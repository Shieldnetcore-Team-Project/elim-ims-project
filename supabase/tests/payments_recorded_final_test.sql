-- ============================================================================
-- Tests: payments are final when recorded (20261018100000). Same harness as
-- marketer_accountability_test.sql; never run against production.
-- ============================================================================
INSERT INTO factories(id, code, name) VALUES ('f3000000-0000-0000-0000-000000000001', 'paytest', 'Payment Test Factory');
INSERT INTO auth.users(id, email) VALUES ('a3000000-0000-0000-0000-000000000001', 'acct@pay'), ('a3000000-0000-0000-0000-000000000002', 'admin@pay');
INSERT INTO user_roles(user_id, role) VALUES ('a3000000-0000-0000-0000-000000000001', 'accountant'), ('a3000000-0000-0000-0000-000000000002', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b3000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'Pay Bottle', 'pack', 1000, 100);
INSERT INTO customers(id, factory_id, name, registered) VALUES ('d3000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'Pay Shop', true);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END; $$;
-- A credit sale of 10,000 (admin records and approves).
SELECT set_config('test.uid', 'a3000000-0000-0000-0000-000000000002', false);
DO $$ DECLARE v jsonb; BEGIN
  v := public.create_sale(jsonb_build_object('factory_id', 'f3000000-0000-0000-0000-000000000001', 'customer_id', 'd3000000-0000-0000-0000-000000000001',
        'payments', jsonb_build_array(jsonb_build_object('amount', 2000, 'method', 'cash')),
        'items', jsonb_build_array(jsonb_build_object('product_id', 'b3000000-0000-0000-0000-000000000001', 'quantity', 10, 'unit_price', 1000))));
  PERFORM public.approve_sale((v->>'sale_id')::uuid, NULL);
END $$;

-- @@ Payment at the sale and a later payment are final at once
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.check((SELECT bool_and(status = 'confirmed' AND review_status = 'approved') FROM payments_received
                          WHERE customer_id = 'd3000000-0000-0000-0000-000000000001'), 'payment at sale confirmed');
  PERFORM set_config('test.uid', 'a3000000-0000-0000-0000-000000000001', false);  -- accountant records a cheque
  v := public.record_payment(jsonb_build_object('factory_id', 'f3000000-0000-0000-0000-000000000001',
        'customer_id', 'd3000000-0000-0000-0000-000000000001', 'amount', 3000, 'payment_method', 'cheque'));
  PERFORM pg_temp.check((SELECT status = 'confirmed' AND review_status = 'approved' AND reviewed_by = 'a3000000-0000-0000-0000-000000000001'
                           FROM payments_received WHERE id = (v->>'payment_id')::uuid), 'later payment confirmed');
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'd3000000-0000-0000-0000-000000000001') = 5000, 'debt 10,000 - 2,000 - 3,000');
END $$;
SELECT 'ok' AS result;

-- @@ A mistake is still corrected by reversal
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM payments_received WHERE customer_id = 'd3000000-0000-0000-0000-000000000001' AND payment_method = 'cheque';
  PERFORM set_config('test.uid', 'a3000000-0000-0000-0000-000000000002', false);
  PERFORM public.reverse_payment(v_id, 'Cheque bounced');
  PERFORM pg_temp.check((SELECT status FROM payments_received WHERE id = v_id) = 'reversed', 'reversed');
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'd3000000-0000-0000-0000-000000000001') = 8000, 'debt back to 8,000');
END $$;
SELECT 'ok' AS result;

-- @@ Receipts left pending before the change are confirmed by the backfill
ALTER TABLE payments_received DISABLE TRIGGER trg_payments_record_final;
SELECT set_config('test.uid', 'a3000000-0000-0000-0000-000000000001', false);
SELECT public.record_payment(jsonb_build_object('factory_id', 'f3000000-0000-0000-0000-000000000001',
  'customer_id', 'd3000000-0000-0000-0000-000000000001', 'amount', 1000, 'payment_method', 'cash', 'remarks', 'old pending'));
UPDATE payments_received SET status = 'pending_confirmation', review_status = 'pending', reviewed_by = NULL, reviewed_at = NULL WHERE remarks = 'old pending';
ALTER TABLE payments_received ENABLE TRIGGER trg_payments_record_final;
-- ============================================================================
-- Payments: recorded once, no confirmation step
-- ----------------------------------------------------------------------------
-- A payment used to be saved as "pending confirmation" and then confirmed (or
-- rejected) by a second person in Finance. That second step is gone: a
-- payment is final as soon as it is entered.
--
--   * Every new receipt -- at the sale, against a debt, an advance, a
--     marketer collection, any path that writes payments_received -- is saved
--     confirmed and approved, with the person who recorded it as reviewer.
--   * Receipts still waiting today are confirmed the same way.
--   * A mistake is corrected by reversing the payment (reverse_payment),
--     which undoes its effect on the customer's account; that is unchanged.
-- Totals and balances don't move: they already counted pending payments.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._payments_record_final()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'pending_confirmation' THEN
    NEW.status := 'confirmed';
  END IF;
  IF NEW.review_status IN ('pending', 'approved') THEN
    NEW.review_status := 'approved';
    NEW.reviewed_by := COALESCE(NEW.reviewed_by, NEW.received_by, auth.uid());
    NEW.reviewed_at := COALESCE(NEW.reviewed_at, now());
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_payments_record_final ON public.payments_received;
CREATE TRIGGER trg_payments_record_final BEFORE INSERT ON public.payments_received
  FOR EACH ROW EXECUTE FUNCTION public._payments_record_final();

ALTER TABLE public.payments_received ALTER COLUMN status SET DEFAULT 'confirmed';
ALTER TABLE public.payments_received ALTER COLUMN review_status SET DEFAULT 'approved';

-- Receipts waiting for confirmation now.
WITH done AS (
  UPDATE public.payments_received
     SET status = CASE WHEN status = 'pending_confirmation' THEN 'confirmed' ELSE status END,
         review_status = 'approved',
         reviewed_by = COALESCE(reviewed_by, received_by),
         reviewed_at = COALESCE(reviewed_at, now()),
         review_note = COALESCE(review_note, 'Confirmed automatically: payments no longer need a second confirmation')
   WHERE review_status = 'pending' AND status NOT IN ('rejected','reversed','cancelled')
  RETURNING factory_id, amount
)
INSERT INTO public.audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
SELECT NULL, factory_id, 'payments_auto_confirmed', 'payments_received', NULL,
       jsonb_build_object('status', 'pending_confirmation'),
       jsonb_build_object('status', 'confirmed', 'count', COUNT(*), 'total', SUM(amount),
                          'reason', 'Payment confirmation step removed')
  FROM done GROUP BY factory_id;
DO $$ BEGIN
  PERFORM pg_temp.check((SELECT status = 'confirmed' AND review_status = 'approved' FROM payments_received WHERE remarks = 'old pending'), 'backfilled');
  PERFORM pg_temp.check((SELECT status FROM payments_received WHERE payment_method = 'cheque' AND customer_id = 'd3000000-0000-0000-0000-000000000001') = 'reversed', 'reversed one untouched');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'payments_auto_confirmed'), 'audited');
END $$;
SELECT 'ok' AS result;
