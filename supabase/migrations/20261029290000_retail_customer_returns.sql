-- ============================================================================
-- Retail customer returns: back into the shop's stock, money settled
-- ----------------------------------------------------------------------------
-- User (2026-10-29): Retail → Sales Returns is for the Retail Shop: a
-- customer who bought from the shop and no longer wants some of the goods
-- brings them back; the shop logs the return against that sale and the
-- packs go back into the shop's stock (the stock the Warehouse posted to
-- it). No inspection or approval -- posted at once, like everything else.
--
-- record_retail_return(payload)
--   sale_id   a posted Retail Shop sale (sales_rep_id = an outlet)
--   items     [{product_id, quantity}] -- at most what was sold on that sale
--             less what was already returned from it
--   settle    'credit' | 'refund' -- what happens to money already paid
--   refund_method  how it was handed back (cash, transfer...), for 'refund'
--   return_date, reason
-- The returned goods' value (their share of the line amounts, after any
-- discount) comes off the sale:
--   1. first off what the customer still owes on it (sale balance, debt,
--      the customer's outstanding balance);
--   2. the rest -- money already paid -- is kept as the customer's credit
--      (needs a customer account) or handed back (refund_amount), which the
--      Retail cash-up takes off that day's expected cash / other money.
-- Stock: rep_stock of the shop goes up; the shop's ledger line is a
-- 'reversal' ("Customer return ..."), counted under corrections on the day.
-- One sales_returns row per product (status completed, accepted = returned),
-- the money split across them in proportion to value. The shop's day must
-- still be open (not submitted / confirmed to Accounts).
-- ============================================================================

ALTER TABLE public.sales_returns
  ADD COLUMN IF NOT EXISTS sales_rep_id uuid REFERENCES public.sales_reps(id),
  ADD COLUMN IF NOT EXISTS value numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS debt_reduced numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_added numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_method public.payment_method;
CREATE INDEX IF NOT EXISTS idx_sales_returns_outlet_day ON public.sales_returns (sales_rep_id, return_date)
  WHERE sales_rep_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_retail_return(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale_id uuid := NULLIF(payload->>'sale_id', '')::uuid;
  v_settle text := COALESCE(NULLIF(payload->>'settle', ''), 'credit');
  v_method payment_method := COALESCE(NULLIF(payload->>'refund_method', '')::payment_method, 'cash');
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, CURRENT_DATE);
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_sale sales%ROWTYPE;
  v_rep sales_reps%ROWTYPE;
  v_debt debts%ROWTYPE;
  v_item jsonb;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_sold numeric;
  v_sold_value numeric;
  v_returned numeric;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_value numeric := 0;
  v_reduce numeric;
  v_paid_part numeric;
  v_credit numeric := 0;
  v_refund numeric := 0;
  v_number text;
  v_n int := 0;
  v_count int;
  v_share numeric;
  v_left_debt numeric;
  v_left_credit numeric;
  v_left_refund numeric;
  v_before numeric;
BEGIN
  IF NOT (public.has_permission(v_uid, 'sales-returns'::module_key, 'submit'::action_key)
       OR public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_settle NOT IN ('credit', 'refund') THEN RAISE EXCEPTION 'Choose credit or refund for money already paid'; END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'A return can''t be dated in the future'; END IF;

  -- Lock order: sale -> customer -> debt (as everywhere else).
  SELECT * INTO v_sale FROM sales WHERE id = v_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_sale.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = v_sale.sales_rep_id;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN
    RAISE EXCEPTION 'Only a Retail Shop sale can be returned here';
  END IF;
  IF v_sale.deleted_at IS NOT NULL OR v_sale.status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted sale can take a return';
  END IF;
  IF COALESCE(v_sale.is_pr, false) THEN RAISE EXCEPTION 'A PR / complimentary sale has no return'; END IF;
  IF EXISTS (SELECT 1 FROM outlet_day_reconciliations
              WHERE sales_rep_id = v_rep.id AND close_date = v_date AND status IN ('submitted', 'confirmed')) THEN
    RAISE EXCEPTION 'The shop''s day % is already closed -- date the return another day, or ask Accounts to query the day back.',
      to_char(v_date, 'DD Mon YYYY');
  END IF;
  IF v_sale.customer_id IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
  END IF;
  IF jsonb_typeof(payload->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Enter what came back'; END IF;

  -- What can come back, and what it is worth (its share of the line amounts).
  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0);
    CONTINUE WHEN v_qty = 0;
    IF v_qty < 0 THEN RAISE EXCEPTION 'Quantities cannot be negative'; END IF;
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(line_total), 0) INTO v_sold, v_sold_value
      FROM sale_items WHERE sale_id = v_sale_id AND product_id = v_product.id;
    IF v_sold = 0 THEN RAISE EXCEPTION '% is not on invoice %', v_product.name, v_sale.invoice_number; END IF;
    SELECT COALESCE(SUM(quantity_returned), 0) INTO v_returned
      FROM sales_returns WHERE sale_id = v_sale_id AND product_id = v_product.id AND status <> 'cancelled';
    IF v_qty > v_sold - v_returned THEN
      RAISE EXCEPTION 'Only % % of % can come back on %', v_sold - v_returned, v_product.unit, v_product.name,
        v_sale.invoice_number;
    END IF;
    v_lines := v_lines || jsonb_build_object('product_id', v_product.id, 'name', v_product.name, 'unit', v_product.unit,
      'quantity', v_qty, 'value', round(v_qty * v_sold_value / v_sold, 2));
    v_value := v_value + round(v_qty * v_sold_value / v_sold, 2);
  END LOOP;
  v_count := jsonb_array_length(v_lines);
  IF v_count = 0 THEN RAISE EXCEPTION 'Enter how many of each product came back'; END IF;

  v_reduce := LEAST(v_value, GREATEST(v_sale.balance, 0));
  v_paid_part := v_value - v_reduce;
  IF v_paid_part > 0 THEN
    IF v_settle = 'credit' THEN
      IF v_sale.customer_id IS NULL THEN
        RAISE EXCEPTION 'A walk-in has no account to keep credit on -- choose a refund';
      END IF;
      v_credit := v_paid_part;
    ELSE
      v_refund := v_paid_part;
    END IF;
  END IF;

  -- The sale: worth less; what was owed / paid on it moves with it.
  UPDATE sales
     SET subtotal = GREATEST(subtotal - v_value, 0),
         grand_total = GREATEST(grand_total - v_value, 0),
         balance = GREATEST(balance - v_reduce, 0),
         amount_paid = GREATEST(amount_paid - v_paid_part, 0)
   WHERE id = v_sale_id;

  SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale_id
   ORDER BY (status <> 'paid') DESC, created_at DESC, id LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE debts
       SET total_amount = GREATEST(total_amount - v_value, 0),
           amount_paid = GREATEST(amount_paid - v_paid_part, 0),
           outstanding = GREATEST(outstanding - v_reduce, 0),
           status = CASE WHEN GREATEST(outstanding - v_reduce, 0) = 0 THEN 'paid'::debt_status
                         WHEN GREATEST(amount_paid - v_paid_part, 0) > 0 THEN 'partial'::debt_status
                         ELSE 'unpaid'::debt_status END,
           updated_at = now()
     WHERE id = v_debt.id;
  END IF;

  IF v_sale.customer_id IS NOT NULL THEN
    UPDATE customers
       SET outstanding_balance = GREATEST(outstanding_balance - v_reduce, 0),
           total_purchases = GREATEST(total_purchases - v_value, 0),
           credit_balance = credit_balance + v_credit,
           updated_at = now()
     WHERE id = v_sale.customer_id;
    IF v_reduce > 0 OR v_credit > 0 THEN
      PERFORM public._customer_ledger_post(
        v_sale.factory_id, v_sale.customer_id, 'CREDIT_ADJUSTMENT', 'sales_return', gen_random_uuid(), v_sale_id, NULL,
        v_debt.id, 0, 0, 0, v_credit, -v_reduce, NULL,
        'Goods returned on ' || v_sale.invoice_number, v_reason, NULL, NULL, v_uid);
    END IF;
  END IF;

  v_number := 'SR-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  v_left_debt := v_reduce;
  v_left_credit := v_credit;
  v_left_refund := v_refund;
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_n := v_n + 1;
    v_qty := (v_line->>'quantity')::numeric;
    -- The money split across the lines by value; the last line takes what is left.
    v_share := CASE WHEN v_value > 0 THEN (v_line->>'value')::numeric / v_value ELSE 0 END;

    SELECT quantity INTO v_before FROM rep_stock
     WHERE sales_rep_id = v_rep.id AND product_id = (v_line->>'product_id')::uuid FOR UPDATE;
    IF FOUND THEN
      UPDATE rep_stock SET quantity = quantity + v_qty, updated_at = now()
       WHERE sales_rep_id = v_rep.id AND product_id = (v_line->>'product_id')::uuid;
    ELSE
      v_before := 0;
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
      VALUES (v_rep.id, (v_line->>'product_id')::uuid, v_sale.factory_id, v_qty);
    END IF;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                    user_id, quantity_before, quantity_after)
    VALUES (v_sale.factory_id, v_rep.id, (v_line->>'product_id')::uuid, 'reversal', v_qty,
            v_number || CASE WHEN v_count > 1 THEN '-' || v_n ELSE '' END,
            'Customer return on ' || v_sale.invoice_number, v_uid, v_before, v_before + v_qty);

    INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned, unit,
                              reason, status, accepted_quantity, received_by, inspected_by, inspected_at, return_date,
                              sales_rep_id, value, debt_reduced, credit_added, refund_amount, refund_method, notes)
    VALUES (v_sale.factory_id, v_number || CASE WHEN v_count > 1 THEN '-' || v_n ELSE '' END, v_sale_id,
            v_sale.customer_id, (v_line->>'product_id')::uuid, v_qty, v_line->>'unit', v_reason, 'completed', v_qty,
            v_uid, v_uid, now(), v_date, v_rep.id, (v_line->>'value')::numeric,
            CASE WHEN v_n = v_count THEN v_left_debt ELSE round(v_reduce * v_share, 2) END,
            CASE WHEN v_n = v_count THEN v_left_credit ELSE round(v_credit * v_share, 2) END,
            CASE WHEN v_n = v_count THEN v_left_refund ELSE round(v_refund * v_share, 2) END,
            CASE WHEN v_refund > 0 THEN v_method END,
            'Back into ' || v_rep.full_name || ' stock');
    v_left_debt := v_left_debt - CASE WHEN v_n = v_count THEN v_left_debt ELSE round(v_reduce * v_share, 2) END;
    v_left_credit := v_left_credit - CASE WHEN v_n = v_count THEN v_left_credit ELSE round(v_credit * v_share, 2) END;
    v_left_refund := v_left_refund - CASE WHEN v_n = v_count THEN v_left_refund ELSE round(v_refund * v_share, 2) END;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_sale.factory_id, 'record_retail_return', 'sales', v_sale_id::text,
          jsonb_build_object('invoice_number', v_sale.invoice_number, 'grand_total', v_sale.grand_total,
                             'balance', v_sale.balance, 'amount_paid', v_sale.amount_paid),
          jsonb_build_object('return_number', v_number, 'items', v_lines, 'value', v_value, 'debt_reduced', v_reduce,
                             'credit_added', v_credit, 'refund', v_refund,
                             'refund_method', CASE WHEN v_refund > 0 THEN v_method END, 'reason', v_reason));

  RETURN jsonb_build_object('return_number', v_number, 'value', v_value, 'debt_reduced', v_reduce,
                            'credit_added', v_credit, 'refund', v_refund);
END;
$$;
REVOKE ALL ON FUNCTION public.record_retail_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_retail_return(jsonb) TO authenticated;

-- The Retail cash-up takes the day's refunds off the money expected.
-- _outlet_day_figures is otherwise as 20261020100000.
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

  -- Money taken at the till with the day's sales, by method.
  WITH s AS (
    SELECT s.id, s.grand_total, s.credit_applied
      FROM sales s
     WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
       AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
  ), p AS (
    SELECT p.payment_method, p.amount
      FROM payments_received p JOIN s ON s.id = p.sale_id
     WHERE p.at_point_of_sale AND p.status NOT IN ('reversed', 'rejected')
  )
  SELECT jsonb_build_object(
    'sales_count', (SELECT COUNT(*) FROM s),
    'sales_value', (SELECT COALESCE(SUM(grand_total), 0) FROM s),
    'advance_applied', (SELECT COALESCE(SUM(credit_applied), 0) FROM s),
    'cash_expected', (SELECT COALESCE(SUM(amount), 0) FROM p WHERE payment_method = 'cash'),
    'other_expected', (SELECT COALESCE(SUM(amount), 0) FROM p WHERE payment_method <> 'cash'),
    'by_method', (SELECT COALESCE(jsonb_object_agg(m, amt), '{}'::jsonb)
                    FROM (SELECT payment_method::text AS m, SUM(amount) AS amt FROM p GROUP BY payment_method) q))
    INTO v_money;
  v_money := v_money || jsonb_build_object(
    'credit_sales', GREATEST((v_money->>'sales_value')::numeric - (v_money->>'advance_applied')::numeric
                             - (v_money->>'cash_expected')::numeric - (v_money->>'other_expected')::numeric, 0));

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
    FROM payments_received p JOIN sales s ON s.id = p.sale_id
   WHERE s.sales_rep_id = p_outlet AND p.at_point_of_sale AND s.deleted_at IS NULL
     AND p.status NOT IN ('reversed', 'rejected') AND s.sale_date < p_date;
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
