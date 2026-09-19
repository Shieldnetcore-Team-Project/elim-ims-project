-- ============================================================================
-- Audit trail for the ledger entries that undo earlier ones
-- ----------------------------------------------------------------------------
-- The ledger already records every reversal as its own row, but the general
-- audit log (Audit Logs page) only said "deletion approved" / "payment
-- reversed" without the customer's balances before and after or how much
-- advance was restored. _customer_ledger_post() now also writes an audit row
-- for the compensating entries produced by a sale reversal or a payment
-- reversal, carrying the previous and new balances, the amount and the reason.
--
-- Debt write-offs and manual adjustments already write their own detailed
-- audit rows, and ordinary sale / payment postings are recorded by the ledger
-- itself, so none of those are duplicated here.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._customer_ledger_post(
  p_factory uuid, p_customer uuid, p_type text,
  p_ref_type text, p_ref_id uuid,
  p_sale_id uuid, p_payment_id uuid, p_debt_id uuid,
  p_goods_value numeric, p_cash_paid numeric, p_advance_used numeric,
  p_credit_delta numeric, p_debt_delta numeric,
  p_method public.payment_method, p_description text, p_notes text,
  p_reverses uuid, p_idem text, p_uid uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_prev_credit numeric;
  v_prev_debt numeric;
  v_credit_delta numeric;
  v_debt_delta numeric;
  v_amount numeric;
  v_id uuid;
BEGIN
  PERFORM 1 FROM customers WHERE id = p_customer FOR UPDATE;

  SELECT credit_after, debt_after INTO v_prev_credit, v_prev_debt
    FROM customer_account_transactions
   WHERE customer_id = p_customer
   ORDER BY seq DESC LIMIT 1;
  v_prev_credit := COALESCE(v_prev_credit, 0);
  v_prev_debt := COALESCE(v_prev_debt, 0);

  v_credit_delta := GREATEST(COALESCE(p_credit_delta, 0), -v_prev_credit);
  v_debt_delta := GREATEST(COALESCE(p_debt_delta, 0), -v_prev_debt);
  v_amount := GREATEST(abs(v_credit_delta), abs(v_debt_delta), COALESCE(p_goods_value, 0),
                       COALESCE(p_cash_paid, 0), COALESCE(p_advance_used, 0));
  IF v_amount = 0 THEN RETURN NULL; END IF;

  INSERT INTO customer_account_transactions(
    factory_id, customer_id, txn_type, reference_type, reference_id, sale_id, payment_id, debt_id, reverses_id,
    amount, goods_value, cash_paid, advance_used, credit_delta, debt_delta, credit_after, debt_after,
    payment_method, description, notes, idempotency_key, created_by)
  VALUES (
    p_factory, p_customer, p_type, p_ref_type, p_ref_id, p_sale_id, p_payment_id, p_debt_id, p_reverses,
    v_amount, COALESCE(p_goods_value, 0), COALESCE(p_cash_paid, 0), COALESCE(p_advance_used, 0),
    v_credit_delta, v_debt_delta, v_prev_credit + v_credit_delta, v_prev_debt + v_debt_delta,
    p_method, p_description, p_notes, p_idem, p_uid)
  RETURNING id INTO v_id;

  IF p_type IN ('REVERSAL', 'ADVANCE_RESTORED')
     AND p_ref_type IN ('sale', 'sale_payments', 'payment_reversal') THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (
      p_uid, p_factory,
      CASE p_type WHEN 'ADVANCE_RESTORED' THEN 'customer_advance_restored' ELSE 'customer_ledger_reversal' END,
      'customers', p_customer::text,
      jsonb_build_object('advance', v_prev_credit, 'debt', v_prev_debt),
      jsonb_build_object('advance', v_prev_credit + v_credit_delta, 'debt', v_prev_debt + v_debt_delta,
                         'amount', v_amount, 'description', p_description,
                         'reference', p_ref_type, 'reason', p_notes, 'ledger_entry', v_id));
  END IF;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._customer_ledger_post(uuid,uuid,text,text,uuid,uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,public.payment_method,text,text,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
