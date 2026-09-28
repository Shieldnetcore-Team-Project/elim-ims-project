-- ============================================================================
-- Marketers: assigned customers, and customer payments they collect
-- ----------------------------------------------------------------------------
--   customers.sales_rep_id         the marketer the customer belongs to. They
--                                  show on that marketer's customer list even
--                                  before a first sale, and the marketer
--                                  collects all of their debts.
--   payments_received.collected_by_rep
--                                  the marketer who brought the money in.
--                                  record_payment() takes it as
--                                  payload.collected_by_rep.
--
-- Fixes the marketer's account (rep_account_summary). It charged the rep for
-- goods out, less returns, cash remitted and what their credit customers still
-- owe -- but a customer payment recorded through Payments (rather than as a
-- rep remittance) lowered "still owe" without anything offsetting it, so the
-- rep appeared to owe the factory money the factory already had. Payments the
-- factory received on the rep's credit sales now count, like remittances, and
-- sit with credit_outstanding as running (not date-filtered) figures: together
-- they are all the credit the rep ever gave, less write-offs.
--
-- Also: sales_count / sales_value there counted pending, rejected and deleted
-- sales; now only approved, not deleted, not complimentary ones.
-- ============================================================================

-- ============ 1. Columns ============
ALTER TABLE public.customers
  ADD COLUMN sales_rep_id uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL;
CREATE INDEX idx_customers_sales_rep ON public.customers (sales_rep_id) WHERE sales_rep_id IS NOT NULL;

-- Same factory only (a customer can't be given another factory's marketer).
CREATE OR REPLACE FUNCTION public._customers_rep_same_factory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.sales_rep_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM sales_reps WHERE id = NEW.sales_rep_id AND factory_id = NEW.factory_id) THEN
    RAISE EXCEPTION 'That marketer does not belong to this factory';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_customers_rep_same_factory BEFORE INSERT OR UPDATE OF sales_rep_id ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public._customers_rep_same_factory();

-- The Customers form sets it directly, like name and phone (see the column
-- grants in 20260928120000_customer_credit_terms.sql).
GRANT INSERT (sales_rep_id) ON public.customers TO authenticated;
GRANT UPDATE (sales_rep_id) ON public.customers TO authenticated;

ALTER TABLE public.payments_received
  ADD COLUMN collected_by_rep uuid REFERENCES public.sales_reps(id);
CREATE INDEX idx_payments_collected_by_rep ON public.payments_received (collected_by_rep) WHERE collected_by_rep IS NOT NULL;

-- What a debt had already been paid when it was raised (cash at the till), so
-- later collections on a walk-in debt -- which has no customer ledger -- can be
-- told apart from it.
ALTER TABLE public.debts ADD COLUMN initial_amount_paid numeric(14,2);
UPDATE public.debts d
   SET initial_amount_paid = GREATEST(d.amount_paid
         - COALESCE((SELECT SUM(dp.amount) FROM public.debt_payments dp WHERE dp.debt_id = d.id), 0)
         - CASE WHEN d.writeoff_status = 'posted' THEN COALESCE(d.writeoff_amount, 0) ELSE 0 END, 0);
CREATE OR REPLACE FUNCTION public._debts_initial_paid()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.initial_amount_paid := COALESCE(NEW.initial_amount_paid, NEW.amount_paid);
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_debts_initial_paid BEFORE INSERT ON public.debts
  FOR EACH ROW EXECUTE FUNCTION public._debts_initial_paid();

-- ============ 2. record_payment: who collected it ============
-- Unchanged from 20260928110000_customer_account_ledger_gaps.sql apart from
-- reading and validating payload.collected_by_rep and storing it.
CREATE OR REPLACE FUNCTION public.record_payment(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_debt_id uuid := NULLIF(payload->>'debt_id','')::uuid;
  v_sale_id uuid := NULLIF(payload->>'sale_id','')::uuid;
  v_date date := COALESCE((payload->>'payment_date')::date, CURRENT_DATE);
  v_remarks text := payload->>'remarks';
  v_idem text := NULLIF(btrim(COALESCE(payload->>'idempotency_key','')), '');
  v_rep uuid := NULLIF(payload->>'collected_by_rep','')::uuid;
  v_multi boolean := COALESCE(CASE WHEN jsonb_typeof(payload->'payments') = 'array' THEN jsonb_array_length(payload->'payments') > 0 END, false);
  v_lines jsonb;
  v_line jsonb;
  v_i int := 0;
  v_amount numeric;
  v_method payment_method;
  v_total numeric := 0;
  v_settled numeric := 0;
  v_credit numeric := 0;
  v_receipt text;
  v_payment_id uuid;
  v_first_payment uuid;
  v_first_receipt text;
  v_debt debts%ROWTYPE;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_existing uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key) OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_rep IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales_reps WHERE id = v_rep AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Marketer not found for this factory';
  END IF;

  IF v_debt_id IS NULL AND v_sale_id IS NOT NULL THEN
    SELECT id INTO v_debt_id FROM debts WHERE sale_id = v_sale_id AND status <> 'paid' LIMIT 1;
  END IF;
  IF v_sale_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM sales WHERE id = v_sale_id AND status = 'posted') THEN
      RAISE EXCEPTION 'Cannot record a payment against a sale that has not been approved yet';
    END IF;
  END IF;
  IF v_debt_id IS NOT NULL THEN
    SELECT * INTO v_debt FROM debts WHERE id = v_debt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'debt not found'; END IF;
    IF v_sale_id IS NULL THEN v_sale_id := v_debt.sale_id; END IF;
    IF v_customer IS NULL THEN v_customer := v_debt.customer_id; END IF;
  END IF;

  IF v_multi THEN
    v_lines := payload->'payments';
  ELSE
    v_lines := jsonb_build_array(jsonb_build_object(
      'amount', COALESCE((payload->>'amount')::numeric, 0),
      'method', COALESCE(payload->>'payment_method', 'cash')));
  END IF;

  -- A debt with no customer on it (named walk-in): nothing to ledger and no
  -- account to hold credit, so only that one debt can be paid down.
  IF v_customer IS NULL THEN
    IF v_debt_id IS NULL THEN RAISE EXCEPTION 'A customer or debt is required'; END IF;
    SELECT * INTO v_debt FROM debts WHERE id = v_debt_id FOR UPDATE;
    FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
      v_amount := COALESCE((v_line->>'amount')::numeric, 0);
      v_method := COALESCE((v_line->>'method')::payment_method, 'cash');
      IF v_amount <= 0 THEN CONTINUE; END IF;
      IF v_amount > v_debt.outstanding THEN RAISE EXCEPTION 'Payment exceeds the amount owed on this debt'; END IF;
      v_receipt := public._next_receipt_number(v_factory);
      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks, collected_by_rep)
      VALUES (v_factory, v_receipt, NULL, v_sale_id, v_amount, v_method, v_date, v_uid, v_remarks, v_rep)
      RETURNING id INTO v_payment_id;
      INSERT INTO debt_payments(debt_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_debt_id, v_amount, v_method, v_date, v_uid, v_remarks);
      UPDATE debts SET amount_paid = amount_paid + v_amount, outstanding = outstanding - v_amount,
             status = CASE WHEN outstanding - v_amount = 0 THEN 'paid'::debt_status ELSE 'partial'::debt_status END,
             updated_at = now()
       WHERE id = v_debt_id
       RETURNING * INTO v_debt;
      IF v_sale_id IS NOT NULL THEN
        UPDATE sales SET amount_paid = amount_paid + v_amount, balance = GREATEST(balance - v_amount, 0) WHERE id = v_sale_id;
      END IF;
      v_total := v_total + v_amount;
      v_first_payment := COALESCE(v_first_payment, v_payment_id);
      v_first_receipt := COALESCE(v_first_receipt, v_receipt);
      v_results := v_results || jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt, 'amount', v_amount, 'payment_method', v_method);
    END LOOP;
    IF v_total <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;
    IF v_multi THEN RETURN jsonb_build_object('payments', v_results, 'total_amount', v_total); END IF;
    RETURN jsonb_build_object('payment_id', v_first_payment, 'receipt_number', v_first_receipt);
  END IF;

  PERFORM 1 FROM customers WHERE id = v_customer AND factory_id = v_factory FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this factory'; END IF;

  IF v_idem IS NOT NULL THEN
    SELECT payment_id INTO v_existing FROM customer_account_transactions WHERE idempotency_key = v_idem;
    IF FOUND THEN
      v_res := public._customer_payment_replay(v_customer, v_idem);
      IF v_res IS NULL THEN RAISE EXCEPTION 'This idempotency key was already used for a different customer'; END IF;
      RETURN v_res;
    END IF;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_amount := COALESCE((v_line->>'amount')::numeric, 0);
    v_method := COALESCE((v_line->>'method')::payment_method, 'cash');
    IF v_amount <= 0 THEN CONTINUE; END IF;
    v_i := v_i + 1;

    v_receipt := public._next_receipt_number(v_factory);
    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks, collected_by_rep)
    VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount, v_method, v_date, v_uid, v_remarks, v_rep)
    RETURNING id INTO v_payment_id;

    v_res := public._customer_receive_money(v_factory, v_customer, v_amount, v_method, v_date, v_uid,
                                            v_remarks, v_payment_id, v_receipt, v_debt_id, 'payment',
                                            CASE WHEN v_idem IS NULL THEN NULL WHEN v_i = 1 THEN v_idem ELSE v_idem || ':L' || v_i END);

    v_total := v_total + v_amount;
    v_settled := v_settled + (v_res->>'settled_debt')::numeric;
    v_credit := v_credit + (v_res->>'credit_added')::numeric;
    v_first_payment := COALESCE(v_first_payment, v_payment_id);
    v_first_receipt := COALESCE(v_first_receipt, v_receipt);
    v_results := v_results || jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt,
                                                 'amount', v_amount, 'payment_method', v_method);
  END LOOP;
  IF v_total <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'record_payment', 'customers', v_customer::text, NULL,
          jsonb_build_object('total', v_total, 'settled_debt', v_settled, 'credit_added', v_credit, 'receipt_number', v_first_receipt));

  IF v_multi THEN
    RETURN jsonb_build_object('payments', v_results, 'total_amount', v_total, 'settled_debt', v_settled, 'credit_added', v_credit);
  END IF;
  RETURN jsonb_build_object('payment_id', v_first_payment, 'receipt_number', v_first_receipt,
                            'settled_debt', v_settled, 'credit_added', v_credit);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_payment(jsonb) TO authenticated;

-- ============ 3. Payments the factory received on a rep's credit sales ============
-- Running total (all time), net of reversals, across the rep's debts:
--   customer debts  from the account ledger: DEBT_SETTLEMENT cash, less
--                   payment_reversal REVERSAL rows on the same debt
--   walk-in debts   (no ledger) amount paid since the debt was raised, less
--                   any posted write-off
-- A debt deleted with its sale (approve_delete) drops out, as its credit does.
CREATE OR REPLACE FUNCTION public._rep_credit_collected(p_sales_rep_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
      SELECT SUM(CASE WHEN t.txn_type = 'DEBT_SETTLEMENT' THEN t.cash_paid ELSE -t.debt_delta END)
        FROM customer_account_transactions t
        JOIN debts d ON d.id = t.debt_id
       WHERE d.sales_rep_id = p_sales_rep_id AND d.customer_id IS NOT NULL
         AND (t.txn_type = 'DEBT_SETTLEMENT'
              OR (t.txn_type = 'REVERSAL' AND t.reference_type = 'payment_reversal'))), 0)
    + COALESCE((
      SELECT SUM(GREATEST(d.amount_paid - COALESCE(d.initial_amount_paid, 0)
                 - CASE WHEN d.writeoff_status = 'posted' THEN COALESCE(d.writeoff_amount, 0) ELSE 0 END, 0))
        FROM debts d
       WHERE d.sales_rep_id = p_sales_rep_id AND d.customer_id IS NULL), 0)
$$;
REVOKE ALL ON FUNCTION public._rep_credit_collected(uuid) FROM PUBLIC, anon, authenticated;

-- ============ 4. rep_account_summary: count those payments ============
-- Unchanged from 20260828092000_distribution_rpcs.sql apart from
-- credit_collected (and the sales count fix in the header).
CREATE OR REPLACE FUNCTION public.rep_account_summary(p_sales_rep_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_goods_out numeric := 0;
  v_accepted numeric := 0;
  v_written_off numeric := 0;
  v_damaged numeric := 0;
  v_rejected numeric := 0;
  v_cash numeric := 0;
  v_credit numeric := 0;
  v_collected numeric := 0;
  v_van_value numeric := 0;
  v_sales_count int := 0;
  v_sales_value numeric := 0;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT COALESCE(SUM(sdi.line_value), 0) INTO v_goods_out
  FROM stock_dispatch_items sdi
  JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
  WHERE sd.sales_rep_id = p_sales_rep_id AND sd.status = 'posted'
    AND (p_from IS NULL OR sd.dispatch_date >= p_from)
    AND (p_to   IS NULL OR sd.dispatch_date <= p_to);

  SELECT
    COALESCE(SUM(COALESCE(rri.accepted_quantity,0) * rri.unit_price), 0),
    COALESCE(SUM(CASE WHEN NOT rri.charge_rep THEN (rri.damaged_quantity + rri.rejected_quantity) * rri.unit_price ELSE 0 END), 0),
    COALESCE(SUM(rri.damaged_quantity * rri.unit_price), 0),
    COALESCE(SUM(rri.rejected_quantity * rri.unit_price), 0)
  INTO v_accepted, v_written_off, v_damaged, v_rejected
  FROM rep_return_items rri
  JOIN rep_returns rr ON rr.id = rri.rep_return_id
  WHERE rr.sales_rep_id = p_sales_rep_id AND rr.status = 'completed'
    AND (p_from IS NULL OR rr.return_date >= p_from)
    AND (p_to   IS NULL OR rr.return_date <= p_to);

  SELECT COALESCE(SUM(amount), 0) INTO v_cash
  FROM rep_remittances
  WHERE sales_rep_id = p_sales_rep_id
    AND (p_from IS NULL OR remittance_date >= p_from)
    AND (p_to   IS NULL OR remittance_date <= p_to);

  SELECT COALESCE(SUM(outstanding), 0) INTO v_credit
  FROM debts
  WHERE sales_rep_id = p_sales_rep_id AND status <> 'paid';

  v_collected := public._rep_credit_collected(p_sales_rep_id);

  SELECT COALESCE(SUM(rs.quantity * p.unit_price), 0) INTO v_van_value
  FROM rep_stock rs JOIN products p ON p.id = rs.product_id
  WHERE rs.sales_rep_id = p_sales_rep_id;

  SELECT COUNT(*), COALESCE(SUM(grand_total), 0) INTO v_sales_count, v_sales_value
  FROM sales
  WHERE sales_rep_id = p_sales_rep_id
    AND status = 'posted' AND deleted_at IS NULL AND NOT COALESCE(is_pr, false)
    AND (p_from IS NULL OR sale_date >= p_from)
    AND (p_to   IS NULL OR sale_date <= p_to);

  RETURN jsonb_build_object(
    'goods_out_value', v_goods_out,
    'accepted_returns_value', v_accepted + v_written_off,
    'accepted_only_value', v_accepted,
    'written_off_value', v_written_off,
    'damaged_value', v_damaged,
    'rejected_value', v_rejected,
    'cash_remitted', v_cash,
    'credit_outstanding', v_credit,
    'credit_collected', v_collected,
    'van_stock_value', v_van_value,
    'sales_count', v_sales_count,
    'sales_value', v_sales_value,
    'net_balance_owed', v_goods_out - (v_accepted + v_written_off) - v_cash - v_credit - v_collected
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.rep_account_summary(uuid, date, date) TO authenticated;

-- ============ 5. The marketer's customers ============
-- Invoices: the rep's own sales, plus every invoice of a customer assigned to
-- the rep (they collect on those too). sold_by_rep tells them apart.
DROP FUNCTION IF EXISTS public.rep_customer_invoices(uuid, date, date);
CREATE FUNCTION public.rep_customer_invoices(
  p_sales_rep_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL
) RETURNS TABLE(
  sale_id uuid, invoice_number text, sale_date date,
  customer_id uuid, customer_name text, customer_phone text,
  grand_total numeric, cash_paid numeric, advance_applied numeric,
  written_off numeric, outstanding numeric,
  due_date date, paid_at timestamptz, debt_status text, sold_by_rep boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT s.id, s.invoice_number, s.sale_date,
         s.customer_id,
         COALESCE(c.name, NULLIF(btrim(s.customer_name), ''), 'Walk-in'),
         COALESCE(c.phone, s.customer_phone),
         s.grand_total, s.amount_paid, s.credit_applied,
         CASE WHEN d.writeoff_status = 'posted' THEN COALESCE(d.writeoff_amount, 0) ELSE 0 END,
         COALESCE(d.outstanding, 0),
         d.due_date, d.paid_at, d.status::text,
         s.sales_rep_id IS NOT DISTINCT FROM p_sales_rep_id
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN debts d ON d.sale_id = s.id
   WHERE (s.sales_rep_id = p_sales_rep_id OR c.sales_rep_id = p_sales_rep_id)
     AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
     AND (p_from IS NULL OR s.sale_date >= p_from)
     AND (p_to IS NULL OR s.sale_date <= p_to)
   ORDER BY s.sale_date DESC, s.invoice_number DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.rep_customer_invoices(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_customer_invoices(uuid, date, date) TO authenticated;

-- Every registered customer the rep is responsible for -- assigned to them or
-- sold to by them -- with the customer's whole-account position (all debts,
-- advance) and what the rep has collected from them.
CREATE OR REPLACE FUNCTION public.rep_customers(p_sales_rep_id uuid)
RETURNS TABLE(
  customer_id uuid, name text, phone text, assigned boolean,
  total_owed numeric, advance_balance numeric, collected_by_rep numeric, last_collection date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT c.id, c.name, c.phone, c.sales_rep_id IS NOT DISTINCT FROM p_sales_rep_id,
         c.outstanding_balance, c.credit_balance,
         COALESCE(p.total, 0), p.last_date
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT SUM(pr.amount) AS total, MAX(pr.payment_date) AS last_date
        FROM payments_received pr
       WHERE pr.customer_id = c.id AND pr.collected_by_rep = p_sales_rep_id
         AND pr.status NOT IN ('reversed','rejected')
    ) p ON true
   WHERE c.sales_rep_id = p_sales_rep_id
      OR EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id AND s.sales_rep_id = p_sales_rep_id
                   AND s.status = 'posted' AND s.deleted_at IS NULL)
   ORDER BY c.name;
END;
$$;
REVOKE ALL ON FUNCTION public.rep_customers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_customers(uuid) TO authenticated;
