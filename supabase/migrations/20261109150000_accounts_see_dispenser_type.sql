-- ============================================================================
-- Accounts sees each dispenser type exactly as the Warehouse posted it
-- ----------------------------------------------------------------------------
-- User (2026-11-09): whichever type the Warehouse posted -- Dispenser Water,
-- Jug + Water or Empty Jug -- is what Accounts sees on the screens it prints
-- invoices from. These lists still read the plain product name:
--   day_postings                Day's postings report
--   party_postings_and_returns  a marketer's / customer's postings and returns
--   retail_daily_book           the Retail Daily Book
--   warehouse_recent_activity   the Warehouse's recent activity
-- Accounts' Record sale on a marketer's customer can say Jug + Water too
-- (record_marketer_customer_sale, dispenser_type_prices). The last result is a
-- read-only health check of the three types: every row should say OK.
-- Needs 20261109140000 first. Safe to run again.
-- Paste the whole file into the Supabase SQL Editor (run without RLS).
-- ============================================================================

DO $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'stock_dispatch_items'
                    AND column_name = 'jar_mode') THEN
    RAISE EXCEPTION 'Run supabase/RUN_THIS_IN_SQL_EDITOR.sql first';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.day_postings(p_factory uuid, p_from date, p_to date DEFAULT NULL)
RETURNS TABLE(party_type text, party text, party_code text, id uuid, reference text, day date,
              at timestamptz, status text, product_name text, unit text, quantity numeric,
              unit_price numeric, line_total numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE
  v_to date := COALESCE(p_to, p_from);
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL THEN RAISE EXCEPTION 'Pick a day'; END IF;
  IF v_to < p_from THEN RAISE EXCEPTION 'The end date is before the start date'; END IF;
  IF v_to - p_from > 92 THEN RAISE EXCEPTION 'Pick at most three months'; END IF;

  RETURN QUERY
  SELECT CASE WHEN r.kind::text = 'outlet' THEN 'retail' ELSE 'marketer' END,
         COALESCE(r.full_name, '-')::text, r.code::text,
         d.id, d.dispatch_number, d.dispatch_date, d.created_at, d.status::text,
         public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
         COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price)
    FROM stock_dispatches d
    JOIN stock_dispatch_items i ON i.dispatch_id = d.id
    LEFT JOIN sales_reps r ON r.id = d.sales_rep_id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE d.factory_id = p_factory AND d.status::text <> 'reversed'
     AND d.dispatch_date BETWEEN p_from AND v_to
  UNION ALL
  SELECT 'distributor', COALESCE(NULLIF(btrim(s.customer_name), ''), c.name, '-')::text, NULL::text,
         s.id, s.invoice_number, s.sale_date, s.created_at, s.status::text,
         public._sale_line_name(COALESCE(p.name, '-'), si.jar_mode)::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN products p ON p.id = si.product_id
   WHERE s.factory_id = p_factory AND s.deleted_at IS NULL
     AND s.status::text NOT IN ('rejected', 'cancelled')
     AND public.is_warehouse_posting(s)
     AND s.sale_date BETWEEN p_from AND v_to
   ORDER BY 1, 2, 7, 9;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.party_postings_and_returns(
  p_factory uuid, p_rep uuid DEFAULT NULL, p_customer_name text DEFAULT NULL
) RETURNS TABLE(kind text, id uuid, reference text, day date, at timestamptz, status text,
                product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric,
                note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE
  v_name text := lower(btrim(COALESCE(p_customer_name, '')));
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF (p_rep IS NULL) = (v_name = '') THEN RAISE EXCEPTION 'Choose a marketer or a customer'; END IF;

  IF p_rep IS NOT NULL THEN
    RETURN QUERY
    SELECT 'posting'::text, d.id, d.dispatch_number, d.dispatch_date, d.created_at, d.status::text,
           public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
           COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price), NULL::text
      FROM stock_dispatches d
      JOIN stock_dispatch_items i ON i.dispatch_id = d.id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE d.factory_id = p_factory AND d.sales_rep_id = p_rep
    UNION ALL
    SELECT 'return', r.id, r.return_number, r.return_date, COALESCE(r.received_at, r.created_at), r.status::text,
           public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity_returned, i.unit_price,
           i.quantity_returned * i.unit_price,
           CASE WHEN cd.dispatch_number IS NOT NULL AND cd.status <> 'reversed'
                THEN 'Added to ' || cd.dispatch_number END
      FROM rep_returns r
      JOIN rep_return_items i ON i.rep_return_id = r.id
      LEFT JOIN products p ON p.id = i.product_id
      LEFT JOIN stock_dispatches cd ON cd.id = r.carried_dispatch_id
     WHERE r.factory_id = p_factory AND r.sales_rep_id = p_rep AND r.status::text <> 'cancelled'
     ORDER BY 5 DESC, 7;
  ELSE
    RETURN QUERY
    SELECT 'posting'::text, s.id, s.invoice_number, s.sale_date, s.created_at, s.status::text,
           public._sale_line_name(COALESCE(p.name, '-'), si.jar_mode)::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total,
           CASE WHEN COALESCE(s.is_pr, false) THEN 'PR' END
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE s.factory_id = p_factory AND s.deleted_at IS NULL
       AND lower(btrim(s.customer_name)) = v_name
       AND s.status::text NOT IN ('rejected', 'cancelled')
    UNION ALL
    SELECT 'return', sr.id, sr.return_number, sr.return_date, COALESCE(sr.received_at, sr.created_at), sr.status::text,
           COALESCE(p.name, '-')::text, COALESCE(p.unit, sr.unit, '')::text, sr.quantity_returned,
           CASE WHEN sr.quantity_returned > 0 THEN sr.value / sr.quantity_returned END, sr.value,
           (SELECT 'On ' || s2.invoice_number FROM sales s2 WHERE s2.id = sr.sale_id)
      FROM sales_returns sr
      LEFT JOIN products p ON p.id = sr.product_id
      LEFT JOIN customers c ON c.id = sr.customer_id
      LEFT JOIN sales s ON s.id = sr.sale_id
     WHERE sr.factory_id = p_factory AND sr.status::text <> 'cancelled'
       AND (lower(btrim(c.name)) = v_name OR lower(btrim(s.customer_name)) = v_name)
     ORDER BY 5 DESC, 7;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.retail_daily_book(p_outlet uuid, p_from date, p_to date)
RETURNS TABLE(day date, kind text, id uuid, reference text, at timestamptz, product_name text, unit text,
              quantity numeric, unit_price numeric, line_total numeric, is_pr boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE
  v_rep sales_reps%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE sales_reps.id = p_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail outlet not found'; END IF;
  IF NOT public._works_in_factory(auth.uid(), v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;

  RETURN QUERY
  SELECT d.dispatch_date, 'posting'::text, d.id, d.dispatch_number, d.created_at,
         public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
         COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price), false
    FROM stock_dispatches d
    JOIN stock_dispatch_items i ON i.dispatch_id = d.id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE d.sales_rep_id = p_outlet AND d.status::text <> 'reversed'
     AND d.dispatch_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT r.return_date, 'return', r.id, r.return_number, COALESCE(r.received_at, r.created_at),
         public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity_returned, i.unit_price,
         i.quantity_returned * i.unit_price, false
    FROM rep_returns r
    JOIN rep_return_items i ON i.rep_return_id = r.id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE r.sales_rep_id = p_outlet AND r.status::text <> 'cancelled'
     AND r.return_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT s.sale_date, 'sale', s.id, s.invoice_number, s.created_at,
         public._sale_line_name(COALESCE(p.name, '-'), si.jar_mode)::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price,
         CASE WHEN COALESCE(s.is_pr, false) THEN 0 ELSE si.line_total END, COALESCE(s.is_pr, false)
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN products p ON p.id = si.product_id
   WHERE s.sales_rep_id = p_outlet AND s.status::text = 'posted' AND s.deleted_at IS NULL
     AND s.sale_date BETWEEN p_from AND p_to
   ORDER BY 1 DESC, 2, 6;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.warehouse_recent_activity(p_factory uuid, p_limit int DEFAULT 30)
RETURNS TABLE(kind text, reference text, at timestamptz, party text, items text,
              quantity numeric, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT * FROM (
    SELECT CASE WHEN r.status = 'rejected' THEN 'refused' ELSE 'received' END,
           r.release_number,
           COALESCE(r.accepted_at, r.released_at),
           'Production'::text,
           pr.name || ' × ' || trim(to_char(COALESCE(r.accepted_quantity, r.quantity), 'FM999G999G990D###')),
           COALESCE(r.accepted_quantity, r.quantity),
           r.status
      FROM production_releases r
      JOIN products pr ON pr.id = r.product_id
     WHERE r.factory_id = p_factory AND r.status IN ('accepted', 'rejected')

    UNION ALL
    SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END,
           d.dispatch_number,
           d.created_at,
           sr.full_name,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
             WHERE i.dispatch_id = d.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
           d.status
      FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id
     WHERE d.factory_id = p_factory AND d.status <> 'reversed'

    UNION ALL
    SELECT CASE WHEN c.registered THEN 'distributor' ELSE 'sale' END,
           s.invoice_number,
           s.created_at,
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id
             WHERE i.sale_id = s.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i WHERE i.sale_id = s.id),
           s.status
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
  ) a
  ORDER BY 3 DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 200);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.record_marketer_customer_sale(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_rep_id uuid := NULLIF(payload->>'sales_rep_id', '')::uuid;
  v_customer_id uuid := NULLIF(payload->>'customer_id', '')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'sale_date', '')::date, CURRENT_DATE);
  v_paid numeric := round(COALESCE((payload->'payment'->>'amount')::numeric, 0), 2);
  v_method payment_method := COALESCE(NULLIF(payload->'payment'->>'method', '')::payment_method, 'cash');
  v_remarks text := NULLIF(btrim(COALESCE(payload->>'remarks', '')), '');
  v_rep sales_reps%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_item jsonb;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
  v_disc numeric;
  v_stock numeric;
  v_subtotal numeric := 0;
  v_credit numeric;
  v_prefix text;
  v_invoice text;
  v_sale_id uuid;
  v_post jsonb;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'distribution'::module_key, 'post'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = v_rep_id;
  IF NOT FOUND OR v_rep.kind <> 'rep' THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_cust FROM customers WHERE id = v_customer_id AND factory_id = v_rep.factory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF v_cust.removed_at IS NOT NULL THEN
    RAISE EXCEPTION '% was removed from the customer list. Restore them on the Customers page first.', v_cust.name;
  END IF;
  IF jsonb_typeof(payload->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'items') = 0 THEN
    RAISE EXCEPTION 'Add at least one product';
  END IF;
  IF v_paid < 0 THEN RAISE EXCEPTION 'The payment cannot be negative'; END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'The sale date cannot be in the future'; END IF;

  -- Check every line first: the product, the price, the discount and that
  -- the marketer has the packs (_post_sale takes them off the van).
  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid AND factory_id = v_rep.factory_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    v_price := round(COALESCE(NULLIF(v_item->>'unit_price', '')::numeric,
                              public._posting_default_price(v_product.id, v_item->>'jar_mode', v_product.unit_price)), 2);
    v_disc := round(COALESCE(NULLIF(v_item->>'discount', '')::numeric, 0), 2);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Enter how many % the customer took', v_product.name; END IF;
    IF v_price < 0 OR v_disc < 0 THEN RAISE EXCEPTION 'Prices and discounts cannot be negative'; END IF;
    IF v_disc > v_price THEN RAISE EXCEPTION 'The discount on % is more than its price per pack', v_product.name; END IF;
    SELECT quantity INTO v_stock FROM rep_stock WHERE sales_rep_id = v_rep.id AND product_id = v_product.id;
    IF NULLIF(v_item->>'jar_mode', '') IS NOT NULL
       AND (v_item->>'jar_mode' <> 'permanent' OR NOT EXISTS (SELECT 1 FROM public._product_jug(v_product.id))) THEN
      RAISE EXCEPTION '% can''t be sold as Jug + Water', v_product.name;
    END IF;
    -- Both types of a dispenser come off the one van stock.
    IF COALESCE(v_stock, 0) < (SELECT SUM((e->>'quantity')::numeric) FROM jsonb_array_elements(payload->'items') e
                                WHERE e->>'product_id' = v_item->>'product_id') THEN
      RAISE EXCEPTION '% has only % of % on hand', v_rep.full_name, COALESCE(v_stock, 0), v_product.name;
    END IF;
    v_subtotal := v_subtotal + round(v_qty * (v_price - v_disc), 2);
  END LOOP;

  -- The customer's advance covers what the payment doesn't, as for any sale.
  v_credit := LEAST(GREATEST(v_subtotal - v_paid, 0), COALESCE(v_cust.credit_balance, 0));

  SELECT COALESCE(invoice_prefix, 'INV-') INTO v_prefix FROM settings WHERE factory_id = v_rep.factory_id;
  v_invoice := COALESCE(v_prefix, 'INV-') || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, sales_rep_id,
                    remarks, created_by, is_pr, status, pending_payments, credit_applied)
  VALUES (v_rep.factory_id, v_invoice, v_date, v_cust.id, v_cust.name, v_cust.phone, v_cust.address,
          v_subtotal, 0, 0, v_subtotal, v_paid, GREATEST(v_subtotal - v_paid - v_credit, 0), v_method, v_rep.full_name,
          v_rep.id, COALESCE(v_remarks, 'Recorded by Accounts from ' || v_rep.full_name || '''s account'), v_uid, false,
          'pending_approval',
          CASE WHEN v_paid > 0 THEN jsonb_build_array(jsonb_build_object('amount', v_paid, 'method', v_method)) END,
          v_credit)
  RETURNING id INTO v_sale_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := round(COALESCE(NULLIF(v_item->>'unit_price', '')::numeric,
                              public._posting_default_price(v_product.id, v_item->>'jar_mode', v_product.unit_price)), 2);
    v_disc := round(COALESCE(NULLIF(v_item->>'discount', '')::numeric, 0), 2);
    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, unit_discount, discount, line_total,
                           jar_mode, jar_unit_price)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_disc, round(v_qty * v_disc, 2), round(v_qty * (v_price - v_disc), 2),
            NULLIF(v_item->>'jar_mode', ''),
            CASE WHEN v_item->>'jar_mode' = 'permanent'
                 THEN COALESCE((SELECT j.jar_price FROM public._product_jug(v_product.id) j), 0) ELSE 0 END);
  END LOOP;

  PERFORM public.record_workflow_action('sales', v_sale_id, 'submit', NULL, 'pending_approval', v_remarks);
  v_post := public._post_sale(v_sale_id, 'Recorded by Accounts from the marketer''s account - posted at once');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_rep.factory_id, 'record_marketer_customer_sale', 'sales', v_sale_id::text,
          jsonb_build_object('invoice_number', v_invoice, 'marketer', v_rep.full_name, 'customer', v_cust.name,
                             'total', v_subtotal, 'paid', v_paid, 'items', payload->'items'));

  RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice, 'grand_total', v_subtotal,
                            'paid', v_paid, 'balance', v_post->'balance');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.dispenser_type_prices(p_factory uuid)
RETURNS TABLE(water_price numeric, jug_price numeric, with_jug numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT p.unit_price::numeric, j.jar_price::numeric, j.with_jar_price::numeric
    FROM products p CROSS JOIN LATERAL public._product_jug(p.id) j
   WHERE p.factory_id = p_factory AND p.active AND lower(btrim(p.name)) = 'dispenser water'
     AND public._works_in_factory(auth.uid(), p_factory)
   LIMIT 1;
END;
$fn$;
REVOKE ALL ON FUNCTION public.dispenser_type_prices(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispenser_type_prices(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.sale_invoice_party(p_sale uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_sale sales%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public._marketer_can_view(COALESCE(
            (SELECT account_rep_id FROM sales WHERE id = p_sale),
            (SELECT sales_rep_id FROM sales WHERE id = p_sale)), true)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_sale FROM sales WHERE id = p_sale;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

  RETURN jsonb_build_object(
    'seller', (SELECT jsonb_build_object('id', r.id, 'code', r.code, 'name', r.full_name, 'kind', r.kind)
                 FROM sales_reps r WHERE r.id = v_sale.sales_rep_id),
    'owner', (SELECT jsonb_build_object('id', r.id, 'code', r.code, 'name', r.full_name, 'kind', r.kind)
                FROM sales_reps r WHERE r.id = v_sale.account_rep_id),
    'customer', (SELECT jsonb_build_object(
                   'code', c.code,
                   'registered', c.registered,
                   'phone', c.phone,
                   'address', c.address
                 )
                   FROM customers c WHERE c.id = v_sale.customer_id),
    'delivered', EXISTS (SELECT 1 FROM deliveries d WHERE d.sale_id = p_sale AND d.status <> 'cancelled'));
END;
$fn$;

NOTIFY pgrst, 'reload schema';

-- Read-only health check: every row should say OK.
WITH w AS (SELECT p.* FROM products p JOIN factories f ON f.id = p.factory_id AND f.code = 'water'
            WHERE p.active AND lower(btrim(p.name)) = 'dispenser water'),
     e AS (SELECT p.* FROM products p JOIN factories f ON f.id = p.factory_id AND f.code = 'water'
            WHERE p.active AND lower(btrim(p.name)) = 'empty jug')
SELECT check_item, CASE WHEN ok THEN 'OK' ELSE 'CHECK' END AS result, detail FROM (
  SELECT 1 AS n, 'One active Dispenser Water' AS check_item, count(*) = 1 AS ok, count(*)::text || ' found' AS detail FROM w
  UNION ALL SELECT 2, 'One active Empty Jug, finished product', count(*) = 1 AND bool_and(product_type = 'finished'), count(*)::text || ' found' FROM e
  UNION ALL SELECT 3, 'Old name Dispenser Empty is gone', count(*) = 0, count(*)::text || ' left'
    FROM products p WHERE p.active AND lower(btrim(p.name)) = 'dispenser empty'
  UNION ALL SELECT 4, 'Prices: 1,200 / 3,000 / 4,200', (SELECT min(unit_price) FROM w) = 1200 AND (SELECT min(unit_price) FROM e) = 3000,
    'Dispenser Water ' || COALESCE((SELECT min(unit_price)::text FROM w), '?') || ', Empty Jug ' || COALESCE((SELECT min(unit_price)::text FROM e), '?')
  UNION ALL SELECT 5, 'Dispenser Water tied to a jug type', count(*) >= 1, count(*)::text || ' link(s)'
    FROM product_containers pc JOIN w ON w.id = pc.product_id WHERE COALESCE(pc.jug_role, 'with_water') <> 'empty'
  UNION ALL SELECT 6, 'Empty Jug tied to the same jug type', count(*) >= 1, count(*)::text || ' link(s)'
    FROM product_containers pc JOIN e ON e.id = pc.product_id
    JOIN product_containers wc ON wc.container_type_id = pc.container_type_id AND wc.product_id IN (SELECT id FROM w)
   WHERE pc.jug_role = 'empty'
  UNION ALL SELECT 7, 'Both have a product category', count(*) = 2 AND bool_and(x.category_id IS NOT NULL),
    COALESCE(string_agg(x.name || ': ' || COALESCE(c.name, 'none'), ', '), 'none')
    FROM (SELECT id, name, category_id FROM w UNION ALL SELECT id, name, category_id FROM e) x
    LEFT JOIN product_categories c ON c.id = x.category_id
  UNION ALL SELECT 8, 'Dispenser officers also handle Empty Jug', count(*) = 0, count(*)::text || ' missing'
    FROM (SELECT DISTINCT user_id FROM user_product_rules WHERE name_pattern ~* 'dispenser') r
   WHERE NOT EXISTS (SELECT 1 FROM user_product_rules x WHERE x.user_id = r.user_id AND 'Empty Jug' ~* x.name_pattern)
  UNION ALL SELECT 9, 'Bottle-only officers do not see Empty Jug', count(*) = 0, count(*)::text || ' overlap'
    FROM user_product_rules r WHERE r.name_pattern ~* 'bottle' AND 'Empty Jug' ~* r.name_pattern
  UNION ALL SELECT 10, 'Posting type columns are in', count(*) = 2, count(*)::text || ' of 2'
    FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'jar_mode'
     AND table_name IN ('stock_dispatch_items', 'rep_return_items')
  UNION ALL SELECT 11, 'Accounts lists and marketer sale updated', count(*) = 5, count(*)::text || ' of 5'
    FROM pg_proc WHERE (proname IN ('day_postings', 'party_postings_and_returns', 'retail_daily_book', 'warehouse_recent_activity') AND prosrc LIKE '%_sale_line_name%')
       OR (proname = 'record_marketer_customer_sale' AND prosrc LIKE '%jar_unit_price%')
) c ORDER BY n;
