-- ============================================================================
-- Retail shop dispensers: water vs jar revenue, the day's dispenser
-- reconciliation, the cashier's remittance breakdown, and the reports
-- ----------------------------------------------------------------------------
-- On the "retail dispenser POS sales, empty jug returns and accountant
-- remittance" brief (2026-11-02). Most of it is already in place:
--   * POS jar choice per dispenser line, Permanent priced from the jug type
--     (20261031160000): Return later -> the customer owes the empty;
--     Permanent -> the jar leaves the company ('jar_sold'); the shop's
--     filled stock goes down on posting, row-locked line by line.
--   * Empties customers bring back (record_customer_jar_return: partial,
--     linked to the sale, client_ref, excess needs another person).
--   * Empties Shop -> Warehouse (record_jug_return -> QC counts with
--     verify_jug_return; a shortfall stays on the shop) -> QC -> PM.
--   * The day close: the shop submits, only Accounts confirms, every
--     difference needs a note (20261020100000).
-- What this migration adds:
--   1. sales.client_ref: create_sale returns the first sale for a repeated
--      request instead of posting it twice; and the lines of one product
--      together (18 Return later + 2 Permanent) must fit the stock.
--   2. _outlet_day_figures money.revenue: water and jar revenue apart (the
--      jar part of a line is quantity x jar_unit_price, fixed at the sale
--      from the jug type; the rest is water), dispensers by jar choice;
--      invoice discounts / VAT / later corrections as "adjustments" so the
--      parts add up to the day's sales.
--   3. shop_jar_summary: "empties at the shop" no longer counts empties
--      already sent to the Warehouse and waiting for the count.
--   4. shop_dispenser_day: the day's dispenser reconciliation per jug type
--      (filled opening / received / sold by choice / remaining, POS units vs
--      stock moved, empties expected / back / owed / sent / confirmed /
--      short, jars sold, water / jar revenue) and the cash-up (expected,
--      declared, received, short / over, who, when, remittance numbers).
--   5. retail_dispenser_report: the shop's dispenser sale lines, empties
--      back, empties sent to the Warehouse, cash-ups and empties still owed
--      over a date range, filtered by outlet, cashier and customer -- every
--      row a posted source record with its reference.
-- No price is invented: water is the line's own price, the jar part is the
-- jug type's jar price (Retail -> Jars, admin only).
-- ============================================================================

-- ============ 1. A repeated POS request posts once ============
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS client_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS sales_client_ref_key ON public.sales (client_ref) WHERE client_ref IS NOT NULL;

-- As 20261031160000, plus payload.client_ref (a resubmit returns the first
-- sale) and one stock check per product over all its lines.

CREATE OR REPLACE FUNCTION public.create_sale(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_sale_date date := COALESCE((payload->>'sale_date')::date, CURRENT_DATE);
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_customer_name text := payload->>'customer_name';
  v_customer_phone text := payload->>'customer_phone';
  v_customer_address text := payload->>'customer_address';
  v_discount numeric := COALESCE((payload->>'discount')::numeric, 0);
  v_vat numeric := COALESCE((payload->>'vat')::numeric, 0);
  v_amount_paid numeric := COALESCE((payload->>'amount_paid')::numeric, 0);
  v_payment_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_payments jsonb := payload->'payments';
  v_apply_credit numeric := 0;
  v_customer_credit numeric;
  v_sales_person text := payload->>'sales_person';
  v_remarks text := payload->>'remarks';
  v_sales_rep uuid := NULLIF(payload->>'sales_rep_id','')::uuid;
  v_is_pr boolean := COALESCE((payload->>'is_pr')::boolean, false);
  v_rep_row public.sales_reps%ROWTYPE;
  v_rep_stock numeric;
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_prefix text;
  v_invoice text;
  v_subtotal numeric := 0;
  v_grand numeric := 0;
  v_balance numeric := 0;
  v_sale_id uuid;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
  v_post jsonb;
  v_mode text;
  v_jug record;
  v_jar numeric;
  v_client text := NULLIF(btrim(COALESCE(payload->>'client_ref', '')), '');
  v_existing sales%ROWTYPE;
  v_over record;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'no items'; END IF;

  -- The same request again (a double tap, a retry after a dropped
  -- connection): hand back the sale it already made.
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM sales WHERE client_ref = v_client;
    IF FOUND THEN
      RETURN jsonb_build_object('sale_id', v_existing.id, 'invoice_number', v_existing.invoice_number,
                                'subtotal', v_existing.subtotal, 'grand_total', v_existing.grand_total,
                                'balance', v_existing.balance, 'status', v_existing.status, 'duplicate', true);
    END IF;
  END IF;

  IF v_is_pr THEN
    -- PR is complimentary -- never mix a real split payment or credit draw
    -- into a "no charge" sale.
    v_payments := NULL;
  END IF;

  IF v_payments IS NOT NULL AND jsonb_array_length(v_payments) > 0 THEN
    SELECT COALESCE(SUM((p->>'amount')::numeric), 0) INTO v_amount_paid
      FROM jsonb_array_elements(v_payments) AS p
      WHERE (p->>'amount')::numeric > 0;
    SELECT (p->>'method')::payment_method INTO v_payment_method
      FROM jsonb_array_elements(v_payments) AS p
      WHERE (p->>'amount')::numeric > 0
      ORDER BY (p->>'amount')::numeric DESC
      LIMIT 1;
    v_payment_method := COALESCE(v_payment_method, 'cash');
  END IF;

  IF v_sales_rep IS NOT NULL THEN
    SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_sales_rep;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
    IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;
    IF v_rep_row.status <> 'active' THEN RAISE EXCEPTION 'Sales rep is not active'; END IF;
  END IF;

  -- Resolve a real customer record for a named walk-in (customer_id not
  -- picked from the dropdown) instead of leaving the sale unlinked.
  IF v_customer IS NULL AND v_customer_name IS NOT NULL AND btrim(v_customer_name) <> '' THEN
    IF v_customer_phone IS NOT NULL AND btrim(v_customer_phone) <> '' THEN
      SELECT id INTO v_customer FROM customers
      WHERE factory_id = v_factory AND phone = v_customer_phone
      LIMIT 1;
    END IF;
    IF v_customer IS NULL THEN
      SELECT id INTO v_customer FROM customers
      WHERE factory_id = v_factory AND lower(name) = lower(btrim(v_customer_name))
      LIMIT 1;
    END IF;
    IF v_customer IS NULL THEN
      INSERT INTO customers(factory_id, name, phone, address, registered)
      VALUES (v_factory, btrim(v_customer_name), v_customer_phone, v_customer_address, false)
      RETURNING id INTO v_customer;
    END IF;
  END IF;

  -- Validate only -- nothing here mutates stock. The actual decrement
  -- happens in approve_sale(), once a manager has reviewed the sale, so
  -- availability is re-checked (and row-locked) again at that point too.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    -- The jar on a jug line (user, 2026-10-31).
    v_mode := NULLIF(v_item->>'jar_mode', '');
    SELECT * INTO v_jug FROM public._product_jug(v_product.id);
    IF v_mode IS NOT NULL AND v_mode NOT IN ('swap', 'return_later', 'permanent') THEN
      RAISE EXCEPTION 'Unknown jar choice %', v_mode;
    END IF;
    IF v_mode IS NOT NULL AND v_jug.container_type_id IS NULL THEN
      RAISE EXCEPTION '% does not come in a jug', v_product.name;
    END IF;
    IF v_mode IS NULL AND v_jug.container_type_id IS NOT NULL AND v_sales_rep IS NOT NULL AND v_rep_row.kind = 'outlet' THEN
      RAISE EXCEPTION 'Choose Swap, Return later or Permanent jar sale for %', v_product.name;
    END IF;
    IF v_mode = 'permanent' THEN
      IF v_jug.jar_price IS NULL OR v_jug.with_jar_price IS NULL THEN
        RAISE EXCEPTION 'The jar price for % is not set -- an administrator sets it under Retail -> Jars', v_jug.name;
      END IF;
      v_price := v_jug.with_jar_price * v_jug.per_unit;
    END IF;
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_sales_rep IS NOT NULL THEN
      SELECT quantity INTO v_rep_stock FROM rep_stock WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id;
      IF COALESCE(v_rep_stock, 0) < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %: rep has %, need %', v_product.name, COALESCE(v_rep_stock,0), v_qty;
      END IF;
    ELSE
      IF v_product.current_stock < v_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
      END IF;
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
  END LOOP;

  -- The lines of one product together (e.g. 18 Return later + 2 Permanent of
  -- the same dispenser) must fit the stock, not each line on its own.
  SELECT p.name, p.unit, t.qty,
         CASE WHEN v_sales_rep IS NOT NULL THEN COALESCE(rs.quantity, 0) ELSE p.current_stock END AS have
    INTO v_over
    FROM (SELECT (i->>'product_id')::uuid AS pid, SUM((i->>'quantity')::numeric) AS qty
            FROM jsonb_array_elements(v_items) i GROUP BY 1) t
    JOIN products p ON p.id = t.pid
    LEFT JOIN rep_stock rs ON rs.sales_rep_id = v_sales_rep AND rs.product_id = t.pid
   WHERE t.qty > CASE WHEN v_sales_rep IS NOT NULL THEN COALESCE(rs.quantity, 0) ELSE p.current_stock END
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Not enough %: % % in stock, the lines on this sale need % together',
      v_over.name, trim_scale(v_over.have), v_over.unit, trim_scale(v_over.qty);
  END IF;

  -- PR: nothing is billed, paid, or owed -- the free-giveaway stock effect
  -- itself still waits for approve_sale() like any other line item.
  IF v_is_pr THEN
    v_discount := 0; v_vat := 0; v_amount_paid := 0;
    v_grand := 0; v_balance := 0;
  ELSE
    v_grand := GREATEST(v_subtotal - v_discount + v_vat, 0);
    -- Auto-preview how much of the customer's own advance/credit would
    -- cover the rest, same formula approve_sale() finalizes with -- so the
    -- balance shown here (and on the printed invoice) is already accurate,
    -- not something that changes surprisingly once a manager approves it.
    IF v_customer IS NOT NULL THEN
      SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_customer;
      v_apply_credit := LEAST(GREATEST(v_grand - v_amount_paid, 0), COALESCE(v_customer_credit, 0));
    END IF;
    v_balance := GREATEST(v_grand - v_amount_paid - v_apply_credit, 0);
  END IF;

  SELECT COALESCE(invoice_prefix,'INV-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'INV-'; END IF;
  v_invoice := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, sales_rep_id,
                    remarks, created_by, is_pr, status, pending_payments, credit_applied, client_ref)
  VALUES (v_factory, v_invoice, v_sale_date, v_customer, v_customer_name, v_customer_phone, v_customer_address,
          v_subtotal, v_discount, v_vat, v_grand, v_amount_paid, v_balance, v_payment_method, v_sales_person, v_sales_rep,
          v_remarks, v_uid, v_is_pr, 'pending_approval', v_payments, v_apply_credit, v_client)
  RETURNING id INTO v_sale_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);

    v_mode := NULLIF(v_item->>'jar_mode', '');
    SELECT * INTO v_jug FROM public._product_jug(v_product.id);
    v_jar := 0;
    IF v_mode = 'permanent' THEN
      v_price := v_jug.with_jar_price * v_jug.per_unit;
      v_jar := v_jug.jar_price * v_jug.per_unit;
    END IF;

    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total, jar_mode, jar_unit_price)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_qty * v_price, v_mode, v_jar);
  END LOOP;

  PERFORM public.record_workflow_action('sales', v_sale_id, 'submit', NULL, 'pending_approval', v_remarks);

  -- The retail outlet's sales need no approval: post now (stock out of the
  -- outlet, receipts, debt, ledger), in this same transaction.
  IF v_sales_rep IS NOT NULL AND v_rep_row.kind = 'outlet' THEN
    v_post := public._post_sale(v_sale_id, 'Retail outlet sale - posted automatically');
    RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                              'subtotal', v_subtotal, 'grand_total', v_grand,
                              'balance', v_post->'balance', 'status', 'posted');
  END IF;

  -- A Warehouse posting to a distributor (20261029140000) doesn't wait on
  -- Accounts either: posted now, so the goods leave Warehouse stock at once.
  -- Accounts confirms it and the payment later (assess_posting).
  IF public.is_warehouse_posting((SELECT s FROM sales s WHERE s.id = v_sale_id)) THEN
    v_post := public._post_sale(v_sale_id, 'Warehouse posting - stock out at once; Accounts confirms payment');
    RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                              'subtotal', v_subtotal, 'grand_total', v_grand,
                              'balance', v_post->'balance', 'status', 'posted');
  END IF;

  RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                            'subtotal', v_subtotal, 'grand_total', v_grand, 'balance', v_balance,
                            'status', 'pending_approval');
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;

-- ============ 2. The day's revenue: water and jars apart ============
-- As 20261030110000, plus money.revenue.
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
  v_rev jsonb;
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

  -- Revenue by kind (2026-11-02). A line's jar part is quantity x
  -- jar_unit_price (the jug type's jar price, fixed on a Permanent line at
  -- the sale); the rest of every line is water. Invoice discounts, VAT and
  -- later price corrections are "adjustments", so the parts add up to
  -- sales_value.
  SELECT jsonb_build_object(
    'water_revenue', COALESCE(SUM(si.line_total - si.quantity * si.jar_unit_price), 0),
    'dispenser_water_revenue', COALESCE(SUM(si.line_total - si.quantity * si.jar_unit_price)
                                          FILTER (WHERE j.container_type_id IS NOT NULL), 0),
    'jar_revenue', COALESCE(SUM(si.quantity * si.jar_unit_price), 0),
    'dispensers_sold', COALESCE(SUM(si.quantity) FILTER (WHERE j.container_type_id IS NOT NULL), 0),
    'sold_return_later', COALESCE(SUM(si.quantity) FILTER (WHERE si.jar_mode = 'return_later'), 0),
    'sold_permanent', COALESCE(SUM(si.quantity) FILTER (WHERE si.jar_mode = 'permanent'), 0),
    'sold_swap', COALESCE(SUM(si.quantity) FILTER (WHERE si.jar_mode = 'swap'), 0),
    'jars_sold', COALESCE(SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'permanent'), 0))
    INTO v_rev
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN LATERAL public._product_jug(si.product_id) j ON true
   WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
     AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false);
  v_rev := v_rev || jsonb_build_object('adjustments',
    (v_money->>'sales_value')::numeric - (v_rev->>'water_revenue')::numeric - (v_rev->>'jar_revenue')::numeric);
  v_money := v_money || jsonb_build_object('revenue', v_rev);

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

-- ============ 3. Empties at the shop leave out empties on their way ============
-- As 20261031160000 (the body now _shop_jar_summary, also read by
-- shop_dispenser_day for Accounts), except empties_at_shop: the jugs the
-- shop holds, less the filled ones, less those sent to the Warehouse and
-- not counted yet -- the empties physically at the shop.
CREATE OR REPLACE FUNCTION public._shop_jar_summary(p_outlet uuid, p_from date, p_to date)
RETURNS TABLE(container_type_id uuid, container_name text, jar_price numeric, with_jar_price numeric,
              filled_on_hand numeric, empties_at_shop numeric, owed_by_customers numeric,
              excess_pending numeric, sent_unconfirmed numeric,
              filled_received numeric, sold_swap numeric, sold_return_later numeric, sold_permanent numeric,
              returned_good numeric, returned_damaged numeric, sent_to_warehouse numeric,
              confirmed_by_warehouse numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_factory uuid := (SELECT factory_id FROM sales_reps WHERE id = p_outlet);
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH t AS (
    SELECT ct.id, ct.name, ct.jar_price, ct.with_jar_price FROM container_types ct
     WHERE ct.factory_id = v_factory AND ct.active AND ct.name ~* 'jug'
  ), held AS (
    SELECT b.container_type_id AS id, SUM(b.balance) AS qty FROM container_balances b
     WHERE b.holder_type = 'sales_rep' AND b.holder_id = p_outlet GROUP BY 1
  ), filled AS (
    SELECT j.container_type_id AS id, SUM(rs.quantity * j.per_unit) AS qty
      FROM rep_stock rs, LATERAL public._product_jug(rs.product_id) j
     WHERE rs.sales_rep_id = p_outlet AND rs.quantity > 0 GROUP BY 1
  ), owed AS (
    SELECT o.container_type_id AS id, SUM(o.quantity_out - o.quantity_returned) AS qty
      FROM public._jar_obligations(v_factory) o WHERE o.outlet_id = p_outlet GROUP BY 1
  ), mv AS (
    SELECT m.container_type_id AS id,
           SUM(CASE WHEN m.source = 'dispatch' AND m.to_id = p_outlet THEN m.quantity
                    WHEN m.source = 'dispatch_reversal' AND m.from_id = p_outlet THEN -m.quantity ELSE 0 END) AS recv
      FROM container_movements m
     WHERE m.factory_id = v_factory AND (m.to_id = p_outlet OR m.from_id = p_outlet)
       AND public._jug_day(m.created_at) BETWEEN p_from AND p_to
     GROUP BY 1
  ), sold AS (
    SELECT j.container_type_id AS id,
           SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'swap') AS swap,
           SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'return_later') AS later,
           SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'permanent') AS perm
      FROM sales s JOIN sale_items si ON si.sale_id = s.id, LATERAL public._product_jug(si.product_id) j
     WHERE s.sales_rep_id = p_outlet AND s.status = 'posted' AND s.deleted_at IS NULL
       AND public._jug_day(COALESCE(s.approved_at, s.created_at)) BETWEEN p_from AND p_to
     GROUP BY 1
  ), back AS (
    SELECT r.container_type_id AS id, SUM(r.quantity_good)::numeric AS good, SUM(r.quantity_damaged)::numeric AS damaged,
           NULL::numeric AS unused
      FROM jar_customer_returns r
     WHERE r.outlet_id = p_outlet AND public._jug_day(r.recorded_at) BETWEEN p_from AND p_to
     GROUP BY 1
  ), pend AS (
    SELECT r.container_type_id AS id, SUM(r.excess_quantity)::numeric AS qty FROM jar_customer_returns r
     WHERE r.outlet_id = p_outlet AND r.excess_status = 'pending' GROUP BY 1
  ), sent AS (
    SELECT j.container_type_id AS id,
           SUM(j.quantity_claimed) FILTER (WHERE public._jug_day(j.recorded_at) BETWEEN p_from AND p_to) AS sent,
           SUM(COALESCE(j.quantity_received, 0)) FILTER (WHERE j.status = 'verified'
                AND public._jug_day(COALESCE(j.verified_at, j.recorded_at)) BETWEEN p_from AND p_to) AS conf,
           SUM(j.quantity_claimed) FILTER (WHERE j.status = 'pending') AS unconf
      FROM jug_returns j
     WHERE j.sales_rep_id = p_outlet AND j.status <> 'cancelled'
     GROUP BY 1
  )
  SELECT t.id, t.name, t.jar_price, t.with_jar_price,
         COALESCE(f.qty, 0), COALESCE(h.qty, 0) - COALESCE(f.qty, 0) - COALESCE(se.unconf, 0), COALESCE(ow.qty, 0),
         COALESCE(pd.qty, 0), COALESCE(se.unconf, 0),
         COALESCE(mv.recv, 0), COALESCE(so.swap, 0), COALESCE(so.later, 0), COALESCE(so.perm, 0),
         COALESCE(bk.good, 0), COALESCE(bk.damaged, 0), COALESCE(se.sent, 0), COALESCE(se.conf, 0)
    FROM t
    LEFT JOIN held h ON h.id = t.id
    LEFT JOIN filled f ON f.id = t.id
    LEFT JOIN owed ow ON ow.id = t.id
    LEFT JOIN mv ON mv.id = t.id
    LEFT JOIN sold so ON so.id = t.id
    LEFT JOIN back bk ON bk.id = t.id
    LEFT JOIN pend pd ON pd.id = t.id
    LEFT JOIN sent se ON se.id = t.id
   ORDER BY t.name;
END;
$$;
REVOKE ALL ON FUNCTION public._shop_jar_summary(uuid, date, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.shop_jar_summary(p_outlet uuid, p_from date, p_to date)
RETURNS TABLE(container_type_id uuid, container_name text, jar_price numeric, with_jar_price numeric,
              filled_on_hand numeric, empties_at_shop numeric, owed_by_customers numeric,
              excess_pending numeric, sent_unconfirmed numeric,
              filled_received numeric, sold_swap numeric, sold_return_later numeric, sold_permanent numeric,
              returned_good numeric, returned_damaged numeric, sent_to_warehouse numeric,
              confirmed_by_warehouse numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._jar_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY SELECT * FROM public._shop_jar_summary(p_outlet, p_from, p_to);
END;
$$;
REVOKE ALL ON FUNCTION public.shop_jar_summary(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shop_jar_summary(uuid, date, date) TO authenticated;


-- Accounts read the dispenser figures too (finance view), without the jug
-- pages' rights.
CREATE OR REPLACE FUNCTION public._dispenser_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._jar_can_view() OR public._outlet_recon_can_view();
$$;
REVOKE ALL ON FUNCTION public._dispenser_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._dispenser_can_view() TO authenticated;

CREATE OR REPLACE FUNCTION public._user_label(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.email, 'Unknown') FROM profiles p WHERE p.id = p_user;
$$;
REVOKE ALL ON FUNCTION public._user_label(uuid) FROM PUBLIC, anon, authenticated;

-- ============ 4. The day's dispenser reconciliation ============
-- Per jug type, for one shop and day (filled counted in jugs: a product's
-- units x its jugs per unit):
--   filled   opening, received from the Warehouse, sold (Return later /
--            Permanent / Swap / no choice -- older sales), sent back or
--            damaged, corrections, remaining;
--   check    stock_sold (the shop's stock moves) against pos_units (the
--            posted invoice lines) -> inventory_variance; the shop's count
--            at the day close against the system -> count_variance;
--   empties  expected from the day's Return-later sales, back from
--            customers (good / damaged), still owed on the day's sales and
--            in all, at the shop, sent to the Warehouse, waiting for the
--            count, confirmed, short;
--   money    jars sold, water and jar revenue on the dispenser lines.
-- Plus the day's revenue split and the cash-up, if the shop submitted it.
CREATE OR REPLACE FUNCTION public.shop_dispenser_day(p_outlet uuid, p_date date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_rec outlet_day_reconciliations%ROWTYPE;
  v_fig jsonb;
  v_types jsonb;
  v_cashup jsonb;
  v_exp_cash numeric;
  v_exp_other numeric;
BEGIN
  IF NOT public._dispenser_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail outlet not found'; END IF;
  IF p_date IS NULL THEN RAISE EXCEPTION 'Pick a day'; END IF;
  SELECT * INTO v_rec FROM outlet_day_reconciliations WHERE sales_rep_id = p_outlet AND close_date = p_date;
  v_fig := public._outlet_day_figures(p_outlet, p_date);

  WITH js AS (
    SELECT * FROM public._shop_jar_summary(p_outlet, p_date, p_date)
  ), mv AS (
    SELECT j.container_type_id AS id, m.movement_type, m.quantity * j.per_unit AS delta,
           public._jug_day(m.created_at) AS d
      FROM rep_stock_movements m, LATERAL public._product_jug(m.product_id) j
     WHERE m.sales_rep_id = p_outlet AND public._jug_day(m.created_at) <= p_date
  ), st AS (
    SELECT id,
           COALESCE(SUM(delta) FILTER (WHERE d < p_date), 0) AS opening,
           COALESCE(SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'dispatch_in'), 0) AS received,
           COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'sold'), 0) AS sold,
           COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type IN ('returned_out', 'damaged_out')), 0) AS sent_back,
           COALESCE(SUM(delta) FILTER (WHERE d = p_date AND movement_type IN ('reversal', 'adjustment')), 0) AS corrections,
           COALESCE(SUM(delta), 0) AS closing
      FROM mv GROUP BY id
  ), pos AS (
    SELECT j.container_type_id AS id,
           COALESCE(SUM(si.quantity * j.per_unit), 0) AS units,
           COALESCE(SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'return_later'), 0) AS later,
           COALESCE(SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'permanent'), 0) AS perm,
           COALESCE(SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'swap'), 0) AS swap,
           COALESCE(SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode IS NULL), 0) AS nomode,
           COALESCE(SUM(si.line_total - si.quantity * si.jar_unit_price) FILTER (WHERE NOT COALESCE(s.is_pr, false)), 0) AS water_rev,
           COALESCE(SUM(si.quantity * si.jar_unit_price) FILTER (WHERE NOT COALESCE(s.is_pr, false)), 0) AS jar_rev
      FROM sales s JOIN sale_items si ON si.sale_id = s.id, LATERAL public._product_jug(si.product_id) j
     WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted' AND s.deleted_at IS NULL
     GROUP BY 1
  ), owed_day AS (
    SELECT o.container_type_id AS id, SUM(o.quantity_out - o.quantity_returned) AS qty
      FROM public._jar_obligations(v_rep.factory_id) o JOIN sales s ON s.id = o.sale_id
     WHERE o.outlet_id = p_outlet AND s.sale_date = p_date
     GROUP BY 1
  ), short AS (
    SELECT j.container_type_id AS id, SUM(j.quantity_claimed - j.quantity_received) AS qty
      FROM jug_returns j
     WHERE j.sales_rep_id = p_outlet AND j.status = 'verified'
       AND public._jug_day(COALESCE(j.verified_at, j.recorded_at)) = p_date
     GROUP BY 1
  ), cnt AS (
    SELECT j.container_type_id AS id,
           SUM((c->>'system')::numeric * j.per_unit) AS system,
           SUM((c->>'counted')::numeric * j.per_unit) AS counted
      FROM jsonb_array_elements(COALESCE(v_rec.counted_stock, '[]'::jsonb)) c,
           LATERAL public._product_jug((c->>'product_id')::uuid) j
     GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'container_type_id', js.container_type_id, 'container_name', js.container_name,
           'jar_price', js.jar_price, 'with_jar_price', js.with_jar_price,
           'opening_filled', COALESCE(st.opening, 0), 'received_filled', COALESCE(st.received, 0),
           'sold_return_later', COALESCE(pos.later, 0), 'sold_permanent', COALESCE(pos.perm, 0),
           'sold_swap', COALESCE(pos.swap, 0), 'sold_no_choice', COALESCE(pos.nomode, 0),
           'sent_back_filled', COALESCE(st.sent_back, 0), 'corrections', COALESCE(st.corrections, 0),
           'filled_remaining', COALESCE(st.closing, 0),
           'stock_sold', COALESCE(st.sold, 0), 'pos_units', COALESCE(pos.units, 0),
           'inventory_variance', COALESCE(st.sold, 0) - COALESCE(pos.units, 0),
           'counted_remaining', cnt.counted,
           'count_variance', CASE WHEN cnt.id IS NULL THEN NULL ELSE cnt.counted - cnt.system END,
           'empties_expected', COALESCE(pos.later, 0),
           'returned_good', js.returned_good, 'returned_damaged', js.returned_damaged,
           'owed_from_day', COALESCE(od.qty, 0), 'owed_total', js.owed_by_customers,
           'excess_pending', js.excess_pending,
           'empties_at_shop', js.empties_at_shop,
           'sent_to_warehouse', js.sent_to_warehouse, 'sent_unconfirmed', js.sent_unconfirmed,
           'confirmed_by_warehouse', js.confirmed_by_warehouse, 'transfer_short', COALESCE(sh.qty, 0),
           'jars_sold', COALESCE(pos.perm, 0),
           'water_revenue', COALESCE(pos.water_rev, 0), 'jar_revenue', COALESCE(pos.jar_rev, 0)
         ) ORDER BY js.container_name), '[]'::jsonb)
    INTO v_types
    FROM js
    LEFT JOIN st ON st.id = js.container_type_id
    LEFT JOIN pos ON pos.id = js.container_type_id
    LEFT JOIN owed_day od ON od.id = js.container_type_id
    LEFT JOIN short sh ON sh.id = js.container_type_id
    LEFT JOIN cnt ON cnt.id = js.container_type_id;

  IF v_rec.id IS NOT NULL THEN
    v_exp_cash := COALESCE((v_rec.figures->'money'->>'cash_expected')::numeric, 0);
    v_exp_other := COALESCE((v_rec.figures->'money'->>'other_expected')::numeric, 0);
    v_cashup := jsonb_build_object(
      'id', v_rec.id,
      'reference', 'CU-' || to_char(v_rec.close_date, 'YYYYMMDD') || '-' || upper(left(replace(v_rec.id::text, '-', ''), 6)),
      'status', v_rec.status,
      'expected_cash', v_exp_cash, 'expected_other', v_exp_other,
      'declared_cash', v_rec.declared_cash, 'declared_other', v_rec.declared_other,
      'received_cash', v_rec.received_cash, 'received_other', v_rec.received_other,
      'short_over', COALESCE(v_rec.received_cash, v_rec.declared_cash) + COALESCE(v_rec.received_other, v_rec.declared_other)
                    - v_exp_cash - v_exp_other,
      -- What the shop submitted: the split as it stood then (older days: now).
      'revenue', COALESCE(v_rec.figures->'money'->'revenue', v_fig->'money'->'revenue'),
      'cashier', public._user_label(v_rec.submitted_by), 'submitted_at', v_rec.submitted_at,
      'accountant', CASE WHEN v_rec.reviewed_by IS NULL THEN NULL ELSE public._user_label(v_rec.reviewed_by) END,
      'reviewed_at', v_rec.reviewed_at,
      'retail_notes', v_rec.retail_notes, 'accounts_notes', v_rec.accounts_notes,
      'remittances', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                'number', m.remittance_number, 'method', m.payment_method, 'amount', m.amount)
                              ORDER BY m.remittance_number), '[]'::jsonb)
                        FROM rep_remittances m WHERE m.id = ANY (v_rec.remittance_ids)));
  END IF;

  RETURN jsonb_build_object(
    'date', p_date,
    'outlet', jsonb_build_object('id', v_rep.id, 'name', v_rep.full_name),
    'types', v_types,
    'money', v_fig->'money',
    'cashup', v_cashup);
END;
$$;
REVOKE ALL ON FUNCTION public.shop_dispenser_day(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shop_dispenser_day(uuid, date) TO authenticated;

-- ============ 5. Reports ============
-- Over p_from..p_to (at most a year), optionally one outlet, one cashier (who
-- recorded it) and a customer search (name, phone or invoice):
--   sales        every posted dispenser line at a retail shop: invoice, jar
--                choice, units, jugs, water and jar revenue
--   returns      empties customers brought back (jar_customer_returns)
--   transfers    empties the shop sent to the Warehouse (jug_returns):
--                sent, counted, short, who sent / counted
--   cashups      each shop day with sales or a cash-up: expected, declared,
--                received, short / over, water / jar revenue, status, who
--   outstanding  Return-later sales still owing empties, today (any date)
--   cashiers     who recorded the period's shop sales, for the filter
CREATE OR REPLACE FUNCTION public.retail_dispenser_report(
  p_factory uuid, p_from date, p_to date,
  p_outlet uuid DEFAULT NULL, p_cashier uuid DEFAULT NULL, p_customer text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_q text := NULLIF(btrim(COALESCE(p_customer, '')), '');
  v_sales jsonb;
  v_returns jsonb;
  v_transfers jsonb;
  v_cashups jsonb;
  v_owed jsonb;
  v_cashiers jsonb;
BEGIN
  IF NOT public._dispenser_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at, x.invoice_number), '[]'::jsonb) INTO v_sales FROM (
    SELECT s.id AS sale_id, s.invoice_number, s.sale_date, s.created_at, s.sales_rep_id AS outlet_id,
           r.full_name AS outlet, s.created_by AS cashier_id, public._user_label(s.created_by) AS cashier,
           COALESCE(NULLIF(btrim(s.customer_name), ''), 'Walk-in') AS customer, s.customer_phone,
           p.name AS product, j.name AS jug, COALESCE(si.jar_mode, 'none') AS jar_mode,
           si.quantity, si.quantity * j.per_unit AS jugs, si.unit_price, si.jar_unit_price,
           CASE WHEN COALESCE(s.is_pr, false) THEN 0 ELSE si.line_total - si.quantity * si.jar_unit_price END AS water_revenue,
           CASE WHEN COALESCE(s.is_pr, false) THEN 0 ELSE si.quantity * si.jar_unit_price END AS jar_revenue,
           CASE WHEN COALESCE(s.is_pr, false) THEN 0 ELSE si.line_total END AS line_total,
           COALESCE(s.is_pr, false) AS is_pr
      FROM sales s
      JOIN sales_reps r ON r.id = s.sales_rep_id AND r.kind = 'outlet'
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      CROSS JOIN LATERAL public._product_jug(si.product_id) j
     WHERE s.factory_id = p_factory AND s.status = 'posted' AND s.deleted_at IS NULL
       AND s.sale_date BETWEEN p_from AND p_to
       AND (p_outlet IS NULL OR s.sales_rep_id = p_outlet)
       AND (p_cashier IS NULL OR s.created_by = p_cashier)
       AND (v_q IS NULL OR s.customer_name ILIKE '%' || v_q || '%' OR s.customer_phone ILIKE '%' || v_q || '%'
            OR s.invoice_number ILIKE '%' || v_q || '%')
  ) x;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.recorded_at), '[]'::jsonb) INTO v_returns FROM (
    SELECT jr.id, jr.return_number, jr.recorded_at, jr.outlet_id, r.full_name AS outlet,
           jr.sale_id, s.invoice_number,
           COALESCE(NULLIF(btrim(COALESCE(s.customer_name, jr.customer_name, '')), ''), 'Walk-in') AS customer,
           ct.name AS jug, jr.quantity_good, jr.quantity_damaged, jr.quantity_applied, jr.excess_quantity,
           jr.excess_status, jr.recorded_by AS cashier_id, public._user_label(jr.recorded_by) AS cashier, jr.notes
      FROM jar_customer_returns jr
      JOIN sales_reps r ON r.id = jr.outlet_id
      JOIN container_types ct ON ct.id = jr.container_type_id
      LEFT JOIN sales s ON s.id = jr.sale_id
     WHERE jr.factory_id = p_factory AND public._jug_day(jr.recorded_at) BETWEEN p_from AND p_to
       AND (p_outlet IS NULL OR jr.outlet_id = p_outlet)
       AND (p_cashier IS NULL OR jr.recorded_by = p_cashier)
       AND (v_q IS NULL OR COALESCE(s.customer_name, jr.customer_name) ILIKE '%' || v_q || '%'
            OR s.customer_phone ILIKE '%' || v_q || '%' OR s.invoice_number ILIKE '%' || v_q || '%')
  ) x;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.recorded_at), '[]'::jsonb) INTO v_transfers FROM (
    SELECT j.id, j.reference, j.recorded_at, j.sales_rep_id AS outlet_id, r.full_name AS outlet, ct.name AS jug,
           j.quantity_claimed AS sent, j.quantity_received AS received, j.status,
           CASE WHEN j.status = 'verified' THEN j.quantity_claimed - j.quantity_received END AS short,
           j.recorded_by AS cashier_id, public._user_label(j.recorded_by) AS sent_by,
           CASE WHEN j.verified_by IS NULL THEN NULL ELSE public._user_label(j.verified_by) END AS counted_by,
           j.verified_at, j.verify_note, j.notes
      FROM jug_returns j
      JOIN sales_reps r ON r.id = j.sales_rep_id AND r.kind = 'outlet'
      JOIN container_types ct ON ct.id = j.container_type_id
     WHERE j.factory_id = p_factory AND j.status <> 'cancelled'
       AND public._jug_day(j.recorded_at) BETWEEN p_from AND p_to
       AND (p_outlet IS NULL OR j.sales_rep_id = p_outlet)
       AND (p_cashier IS NULL OR j.recorded_by = p_cashier)
  ) x;

  -- Every shop day with sales or a cash-up in the range.
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.close_date, x.outlet), '[]'::jsonb) INTO v_cashups FROM (
    SELECT dd.outlet_id, r.full_name AS outlet, dd.d AS close_date,
           COALESCE(rc.status, 'not_submitted') AS status,
           CASE WHEN rc.id IS NULL THEN NULL
                ELSE 'CU-' || to_char(rc.close_date, 'YYYYMMDD') || '-' || upper(left(replace(rc.id::text, '-', ''), 6)) END AS reference,
           (f.fig->>'sales_value')::numeric AS sales_value,
           (f.fig->'revenue'->>'water_revenue')::numeric AS water_revenue,
           (f.fig->'revenue'->>'jar_revenue')::numeric AS jar_revenue,
           (f.fig->'revenue'->>'adjustments')::numeric AS adjustments,
           (f.fig->>'cash_expected')::numeric + (f.fig->>'other_expected')::numeric AS expected,
           rc.declared_cash + rc.declared_other AS declared,
           CASE WHEN rc.received_cash IS NULL THEN NULL ELSE rc.received_cash + COALESCE(rc.received_other, 0) END AS received,
           CASE WHEN rc.id IS NULL THEN NULL
                ELSE COALESCE(rc.received_cash, rc.declared_cash) + COALESCE(rc.received_other, rc.declared_other)
                     - (f.fig->>'cash_expected')::numeric - (f.fig->>'other_expected')::numeric END AS short_over,
           rc.submitted_by AS cashier_id,
           CASE WHEN rc.submitted_by IS NULL THEN NULL ELSE public._user_label(rc.submitted_by) END AS cashier,
           rc.submitted_at,
           CASE WHEN rc.reviewed_by IS NULL THEN NULL ELSE public._user_label(rc.reviewed_by) END AS accountant,
           rc.reviewed_at, rc.retail_notes, rc.accounts_notes
      FROM (SELECT s.sales_rep_id AS outlet_id, s.sale_date AS d FROM sales s
              JOIN sales_reps r ON r.id = s.sales_rep_id AND r.kind = 'outlet'
             WHERE s.factory_id = p_factory AND s.status = 'posted' AND s.deleted_at IS NULL
               AND s.sale_date BETWEEN p_from AND p_to
            UNION
            SELECT o.sales_rep_id, o.close_date FROM outlet_day_reconciliations o
             WHERE o.factory_id = p_factory AND o.close_date BETWEEN p_from AND p_to) dd
      JOIN sales_reps r ON r.id = dd.outlet_id
      LEFT JOIN outlet_day_reconciliations rc ON rc.sales_rep_id = dd.outlet_id AND rc.close_date = dd.d
      -- A submitted day reads what was submitted; an open day reads live.
      CROSS JOIN LATERAL (SELECT CASE WHEN rc.id IS NOT NULL AND rc.status <> 'queried' AND rc.figures->'money' ? 'revenue'
                                      THEN rc.figures->'money'
                                      ELSE public._outlet_day_figures(dd.outlet_id, dd.d)->'money' END AS fig) f
     WHERE (p_outlet IS NULL OR dd.outlet_id = p_outlet)
       AND (p_cashier IS NULL OR rc.submitted_by = p_cashier
            OR EXISTS (SELECT 1 FROM sales s WHERE s.sales_rep_id = dd.outlet_id AND s.sale_date = dd.d
                        AND s.created_by = p_cashier AND s.status = 'posted' AND s.deleted_at IS NULL))
  ) x;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.sale_date, x.invoice_number), '[]'::jsonb) INTO v_owed FROM (
    SELECT s.id AS sale_id, s.invoice_number, s.sale_date, o.outlet_id, r.full_name AS outlet,
           COALESCE(NULLIF(btrim(s.customer_name), ''), 'Walk-in') AS customer, s.customer_phone,
           ct.name AS jug, o.quantity_out AS taken, o.quantity_returned AS returned,
           o.quantity_out - o.quantity_returned AS outstanding,
           (now() AT TIME ZONE 'Africa/Lagos')::date - s.sale_date AS days_out,
           public._user_label(s.created_by) AS cashier
      FROM public._jar_obligations(p_factory) o
      JOIN sales s ON s.id = o.sale_id
      JOIN sales_reps r ON r.id = o.outlet_id
      JOIN container_types ct ON ct.id = o.container_type_id
     WHERE o.quantity_out - o.quantity_returned > 0
       AND (p_outlet IS NULL OR o.outlet_id = p_outlet)
       AND (p_cashier IS NULL OR s.created_by = p_cashier)
       AND (v_q IS NULL OR s.customer_name ILIKE '%' || v_q || '%' OR s.customer_phone ILIKE '%' || v_q || '%'
            OR s.invoice_number ILIKE '%' || v_q || '%')
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'name', public._user_label(u.id)) ORDER BY public._user_label(u.id)), '[]'::jsonb)
    INTO v_cashiers
    FROM (SELECT DISTINCT s.created_by AS id FROM sales s
            JOIN sales_reps r ON r.id = s.sales_rep_id AND r.kind = 'outlet'
           WHERE s.factory_id = p_factory AND s.sale_date BETWEEN p_from AND p_to
             AND s.status = 'posted' AND s.deleted_at IS NULL AND s.created_by IS NOT NULL) u;

  RETURN jsonb_build_object('sales', v_sales, 'returns', v_returns, 'transfers', v_transfers,
                            'cashups', v_cashups, 'outstanding', v_owed, 'cashiers', v_cashiers);
END;
$$;
REVOKE ALL ON FUNCTION public.retail_dispenser_report(uuid, date, date, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retail_dispenser_report(uuid, date, date, uuid, uuid, text) TO authenticated;

-- ============ 6. The new page follows Retail › Jars ============
-- Retail › Dispenser Reports (src/lib/nav.ts) is ticked or unticked for each
-- account exactly as its Retail › Jars, so the accounts kept to one page
-- (Marry, Ruth, Blessing, ...) don't suddenly see it.
INSERT INTO public.user_page_access (user_id, page_id, granted)
SELECT a.user_id, 'Retail › Dispenser Reports', a.granted
  FROM public.user_page_access a
 WHERE a.page_id = 'Retail › Jars'
ON CONFLICT (user_id, page_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
