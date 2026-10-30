-- ============================================================================
-- Retail Shop: receive a payment that was not taken at the sale
-- ----------------------------------------------------------------------------
-- User decision (2026-10-30). A shop sale left unpaid or part-paid at the
-- till can be paid later from Retail › POS (Receive) by the shop's staff --
-- anyone who may sell (sales write), not only Finance:
--   * record_payment() also lets a sales-write user pay a POSTED Retail Shop
--     sale (its seller is the outlet). Finance/Debts users are unchanged.
--   * Such a payment is stamped collected_by_rep = the shop, so the shop's
--     day close (_outlet_day_figures) expects that money on the day it was
--     received, on top of the day's till takings, and counts it in what the
--     shop still holds from earlier days.
-- Needs 20261029290000_retail_customer_returns.sql first. Safe to run again.
-- ============================================================================

-- The Retail Shop a sale (or the debt on it) belongs to; NULL otherwise.
CREATE OR REPLACE FUNCTION public._retail_sale_outlet(p_sale uuid, p_debt uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id FROM sales s JOIN sales_reps r ON r.id = s.sales_rep_id AND r.kind = 'outlet'
   WHERE s.id = COALESCE(p_sale, (SELECT d.sale_id FROM debts d WHERE d.id = p_debt))
     AND s.deleted_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public._retail_sale_outlet(uuid, uuid) FROM PUBLIC, anon, authenticated;

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
  v_shop uuid := public._retail_sale_outlet(v_sale_id, v_debt_id);
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key) OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)) THEN
    -- The Retail Shop's staff may take payment on the shop's own sales; the
    -- money is then the shop's to hand over at its day close.
    IF v_shop IS NULL OR NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    v_rep := v_shop;
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

CREATE OR REPLACE FUNCTION public._outlet_day_figures(p_outlet uuid, p_date date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_products jsonb;
  v_stock jsonb;
  v_money jsonb;
  v_held_before numeric;
  v_remit_before numeric;
  v_remit_day numeric;
  v_pending int;
  v_ref_cash numeric;
  v_ref_other numeric;
BEGIN
  WITH mv AS (
    SELECT m.product_id, m.movement_type, m.quantity AS delta,
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM rep_stock_movements m
     WHERE m.sales_rep_id = p_outlet AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date <= p_date
  ), st AS (
    SELECT product_id,
      COALESCE(SUM(delta) FILTER (WHERE d < p_date), 0) AS opening,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'dispatch_in'), 0) AS received,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'sold'), 0) AS sold,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'returned_out'), 0) AS returned,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'damaged_out'), 0) AS damaged,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND movement_type IN ('reversal', 'adjustment')), 0) AS corrections,
      COALESCE(SUM(delta), 0) AS closing
    FROM mv GROUP BY product_id
  ), sv AS (
    SELECT si.product_id, SUM(si.line_total) AS value
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
       AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
     GROUP BY si.product_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'unit', p.unit, 'unit_price', p.unit_price,
           'opening', st.opening, 'received', st.received, 'sold', st.sold,
           'returned', st.returned, 'damaged', st.damaged, 'corrections', st.corrections,
           'closing', st.closing, 'sold_value', COALESCE(sv.value, 0)
         ) ORDER BY p.name), '[]'::jsonb)
    INTO v_products
    FROM st JOIN products p ON p.id = st.product_id
    LEFT JOIN sv ON sv.product_id = st.product_id
   WHERE st.opening <> 0 OR st.received <> 0 OR st.sold <> 0 OR st.returned <> 0
      OR st.damaged <> 0 OR st.corrections <> 0 OR st.closing <> 0;

  SELECT jsonb_build_object(
    'opening', COALESCE(SUM((x->>'opening')::numeric), 0),
    'received', COALESCE(SUM((x->>'received')::numeric), 0),
    'sold', COALESCE(SUM((x->>'sold')::numeric), 0),
    'returned', COALESCE(SUM((x->>'returned')::numeric), 0),
    'damaged', COALESCE(SUM((x->>'damaged')::numeric), 0),
    'corrections', COALESCE(SUM((x->>'corrections')::numeric), 0),
    'closing', COALESCE(SUM((x->>'closing')::numeric), 0),
    'closing_value', COALESCE(SUM((x->>'closing')::numeric * (x->>'unit_price')::numeric), 0))
    INTO v_stock FROM jsonb_array_elements(v_products) x;

  -- Money the shop took on the day, by method: at the till with the day's
  -- sales, plus payments it received later on earlier unpaid sales (Receive
  -- on Retail › POS, stamped collected_by_rep = the shop -- 20261030110000).
  -- The day's credit sales count the till only.
  WITH s AS (
    SELECT s.id, s.grand_total, s.credit_applied
      FROM sales s
     WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
       AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
  ), p AS (
    SELECT p.payment_method, p.amount
      FROM payments_received p JOIN s ON s.id = p.sale_id
     WHERE p.at_point_of_sale AND p.status NOT IN ('reversed', 'rejected')
  ), c AS (
    SELECT p.payment_method, p.amount
      FROM payments_received p
     WHERE p.collected_by_rep = p_outlet AND NOT p.at_point_of_sale AND p.payment_date = p_date
       AND p.status NOT IN ('reversed', 'rejected')
  ), pc AS (
    SELECT * FROM p UNION ALL SELECT * FROM c
  )
  SELECT jsonb_build_object(
    'sales_count', (SELECT COUNT(*) FROM s),
    'sales_value', (SELECT COALESCE(SUM(grand_total), 0) FROM s),
    'advance_applied', (SELECT COALESCE(SUM(credit_applied), 0) FROM s),
    'cash_expected', (SELECT COALESCE(SUM(amount), 0) FROM pc WHERE payment_method = 'cash'),
    'other_expected', (SELECT COALESCE(SUM(amount), 0) FROM pc WHERE payment_method <> 'cash'),
    'collections_cash', (SELECT COALESCE(SUM(amount), 0) FROM c WHERE payment_method = 'cash'),
    'collections_other', (SELECT COALESCE(SUM(amount), 0) FROM c WHERE payment_method <> 'cash'),
    'credit_sales', GREATEST((SELECT COALESCE(SUM(grand_total - credit_applied), 0) FROM s)
                             - (SELECT COALESCE(SUM(amount), 0) FROM p), 0),
    'by_method', (SELECT COALESCE(jsonb_object_agg(m, amt), '{}'::jsonb)
                    FROM (SELECT payment_method::text AS m, SUM(amount) AS amt FROM pc GROUP BY payment_method) q))
    INTO v_money;

  -- Money handed back to customers for goods they returned on the day
  -- (record_retail_return, 20261029290000) comes off what the shop should
  -- hand over.
  SELECT COALESCE(SUM(refund_amount) FILTER (WHERE refund_method = 'cash'), 0),
         COALESCE(SUM(refund_amount) FILTER (WHERE refund_method IS DISTINCT FROM 'cash'), 0)
    INTO v_ref_cash, v_ref_other
    FROM sales_returns
   WHERE sales_rep_id = p_outlet AND return_date = p_date AND status = 'completed' AND refund_amount > 0;
  v_money := v_money || jsonb_build_object(
    'refunds_cash', v_ref_cash, 'refunds_other', v_ref_other,
    'cash_expected', (v_money->>'cash_expected')::numeric - v_ref_cash,
    'other_expected', (v_money->>'other_expected')::numeric - v_ref_other);

  -- Earlier money the outlet took but has not yet handed over (information
  -- only: the day's expected figures are the day's own takings).
  SELECT COALESCE(SUM(p.amount), 0) INTO v_held_before
    FROM payments_received p LEFT JOIN sales s ON s.id = p.sale_id
   WHERE p.status NOT IN ('reversed', 'rejected')
     AND ((p.at_point_of_sale AND s.sales_rep_id = p_outlet AND s.deleted_at IS NULL AND s.sale_date < p_date)
       OR (NOT p.at_point_of_sale AND p.collected_by_rep = p_outlet AND p.payment_date < p_date));
  SELECT COALESCE(SUM(amount), 0) INTO v_remit_before FROM rep_remittances
   WHERE sales_rep_id = p_outlet AND remittance_date < p_date;
  SELECT COALESCE(SUM(amount), 0) INTO v_remit_day FROM rep_remittances
   WHERE sales_rep_id = p_outlet AND remittance_date = p_date;

  SELECT COUNT(*) INTO v_pending FROM sales
   WHERE sales_rep_id = p_outlet AND sale_date = p_date AND status = 'pending_approval' AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'date', p_date, 'products', v_products, 'stock', v_stock, 'money', v_money,
    'unremitted_before', v_held_before - v_remit_before,
    'remitted_on_day', v_remit_day,
    'pending_sales', v_pending);
END;
$$;
REVOKE ALL ON FUNCTION public._outlet_day_figures(uuid, date) FROM PUBLIC, anon, authenticated;
