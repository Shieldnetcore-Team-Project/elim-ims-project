-- ============================================================================
-- Sales page "Cash Out": sales staff collect cash from customers all day and
-- periodically hand it over to the till/accounts office. That hand-over is a
-- genuine cash inflow, but it should land in the Expenses page's Cash In
-- ledger (cash_transactions, transaction_type='receipt') automatically rather
-- than needing someone with 'receipts-payments' access to re-enter it.
-- ----------------------------------------------------------------------------
-- create_cash_transaction() already does this insert but is gated on
-- 'receipts-payments' write (see 20260816109000), which a plain sales user
-- doesn't hold. Rather than loosen that RPC's permission check (used from the
-- Expenses page for unrelated manual entries), this is a dedicated RPC for
-- the Sales-page action, gated on 'sales' write instead -- the same
-- permission that already lets someone record a sale. It reuses category
-- 'other_inflow' ("Other Cash Inflows") so no schema/category change is
-- needed and it already flows into Cash Flow Overview and the Expenses
-- ledger's Cash In total; related_reference='sales_cash_out' tags it as
-- coming from this action specifically.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_sales_cash_remittance(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_amount numeric := (payload->>'amount')::numeric;
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_date date := COALESCE((payload->>'transaction_date')::date, CURRENT_DATE);
  v_description text := COALESCE(NULLIF(btrim(payload->>'description'), ''), 'Cash remitted from sales');
  v_payer_payee text := payload->>'payer_payee';
  v_recorded_by text := payload->>'recorded_by_name';
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;
  IF v_recorded_by IS NULL OR btrim(v_recorded_by) = '' THEN RAISE EXCEPTION 'Recorded by name is required'; END IF;

  v_number := 'RCT-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO cash_transactions(factory_id, transaction_number, transaction_date, transaction_type, category,
                                 description, amount, payment_method, payer_payee, related_reference,
                                 recorded_by_name, recorded_by)
  VALUES (v_factory, v_number, v_date, 'receipt', 'other_inflow', v_description, v_amount, v_method,
          v_payer_payee, 'sales_cash_out', v_recorded_by, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'transaction_number', v_number);
END;
$$;

REVOKE ALL ON FUNCTION public.create_sales_cash_remittance(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sales_cash_remittance(jsonb) TO authenticated;
