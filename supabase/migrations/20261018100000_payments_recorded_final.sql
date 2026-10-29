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
   WHERE (review_status = 'pending' OR status = 'pending_confirmation')
     AND status NOT IN ('rejected','reversed','cancelled')
  RETURNING factory_id, amount
)
INSERT INTO public.audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
SELECT NULL, factory_id, 'payments_auto_confirmed', 'payments_received', NULL,
       jsonb_build_object('status', 'pending_confirmation'),
       jsonb_build_object('status', 'confirmed', 'count', COUNT(*), 'total', SUM(amount),
                          'reason', 'Payment confirmation step removed')
  FROM done GROUP BY factory_id;
