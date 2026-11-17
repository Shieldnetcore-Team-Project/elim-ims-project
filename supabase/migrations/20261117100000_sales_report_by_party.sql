-- ============================================================================
-- sales_report_by_party: the Operations weekly / monthly / yearly sales sheet
-- ----------------------------------------------------------------------------
-- The factory's printed "OPERATIONS: WEEKLY SALES REPORT FROM .. TO .." lists
-- every marketer / distributor down the side, every product across the top
-- and the quantity each took in the period (user, 2026-11-17). All Reports ›
-- "Sales Report (Marketer/Distributor)" prints it for any range, for everyone
-- or one group: marketers, Distributor/Office Delivery, Retail Shop.
--
-- Quantity = what the Warehouse sent out less what came back, by date:
--   marketer / retail  stock_dispatches (not reversed) by dispatch_date, less
--                      rep_returns (not cancelled) by return_date
--   distributor        Warehouse sales to a registered customer who is not a
--                      marketer's customer (sales_rep_id NULL, not PR, not
--                      deleted, not rejected/cancelled) by sale_date, less
--                      sales_returns on them (or on that customer) by
--                      return_date
--   direct             the same sales to walk-in / unregistered customers, as
--                      one "Direct Sales" row
-- A dispenser sold with its jug for good is "Jug + Water" (_sale_line_name).
--
-- Rows: kind 'product' lists every active finished product (the columns, so a
-- product nobody took still prints as zeros); kind 'party' lists every party
-- that could appear (active marketers, the shop, distributors) with no
-- product, so a party who took nothing still prints as zeros; kind 'line' is
-- a party's net quantity of one product. SECURITY DEFINER so names show to
-- anyone with Reports or Finance view.
-- Safe to run again. Paste into the Supabase SQL Editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sales_report_by_party(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(row_kind text, party_type text, party_id text, party_name text, party_code text,
              product_name text, quantity numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT public._works_in_factory(auth.uid(), p_factory)
     OR NOT (public.has_permission(auth.uid(), 'reports'::module_key, 'view'::action_key)
          OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  IF p_to - p_from > 370 THEN RAISE EXCEPTION 'Pick at most a year of days'; END IF;

  RETURN QUERY
  WITH wh_sales AS (
    SELECT s.id, s.customer_id, s.customer_name, c.name AS cname, c.code AS ccode,
           (c.registered AND c.sales_rep_id IS NULL) AS is_dist
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.factory_id = p_factory AND s.deleted_at IS NULL
       AND s.sales_rep_id IS NULL AND NOT COALESCE(s.is_pr, false)
       AND s.status::text NOT IN ('rejected', 'cancelled')
  ),
  moves AS (
    -- Posted to marketers and the shop
    SELECT CASE WHEN r.kind::text = 'outlet' THEN 'retail' ELSE 'marketer' END AS pt,
           r.id::text AS pid, r.full_name::text AS pname, r.code::text AS pcode,
           public._sale_line_name(p.name, i.jar_mode)::text AS prod, i.quantity AS qty
      FROM stock_dispatches d
      JOIN stock_dispatch_items i ON i.dispatch_id = d.id
      JOIN sales_reps r ON r.id = d.sales_rep_id
      JOIN products p ON p.id = i.product_id
     WHERE d.factory_id = p_factory AND d.status::text <> 'reversed'
       AND d.dispatch_date BETWEEN p_from AND p_to
    UNION ALL
    -- Returned by marketers and the shop
    SELECT CASE WHEN r.kind::text = 'outlet' THEN 'retail' ELSE 'marketer' END,
           r.id::text, r.full_name::text, r.code::text,
           public._sale_line_name(p.name, i.jar_mode)::text, -i.quantity_returned
      FROM rep_returns rr
      JOIN rep_return_items i ON i.rep_return_id = rr.id
      JOIN sales_reps r ON r.id = rr.sales_rep_id
      JOIN products p ON p.id = i.product_id
     WHERE rr.factory_id = p_factory AND rr.status::text <> 'cancelled'
       AND rr.return_date BETWEEN p_from AND p_to
    UNION ALL
    -- Warehouse sales to distributors / walk-ins
    SELECT CASE WHEN w.is_dist THEN 'distributor' ELSE 'direct' END,
           CASE WHEN w.is_dist THEN w.customer_id::text ELSE 'direct' END,
           CASE WHEN w.is_dist THEN w.cname::text ELSE 'Direct Sales' END,
           CASE WHEN w.is_dist THEN w.ccode::text END,
           public._sale_line_name(p.name, si.jar_mode)::text, si.quantity
      FROM wh_sales w
      JOIN sales s ON s.id = w.id
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
     WHERE s.sale_date BETWEEN p_from AND p_to
    UNION ALL
    -- Returned by distributors (on a Warehouse sale, or on the customer)
    SELECT 'distributor', c.id::text, c.name::text, c.code::text, p.name::text, -sr.quantity_returned
      FROM sales_returns sr
      JOIN customers c ON c.id = COALESCE(sr.customer_id, (SELECT s2.customer_id FROM sales s2 WHERE s2.id = sr.sale_id))
      JOIN products p ON p.id = sr.product_id
     WHERE sr.factory_id = p_factory AND sr.status::text <> 'cancelled'
       AND COALESCE(sr.return_date, sr.received_at::date) BETWEEN p_from AND p_to
       AND c.registered AND c.sales_rep_id IS NULL
       AND (sr.sale_id IS NULL OR EXISTS (SELECT 1 FROM wh_sales w WHERE w.id = sr.sale_id))
  )
  SELECT 'product'::text, NULL::text, NULL::text, NULL::text, NULL::text, p.name::text, 0::numeric
    FROM products p
   WHERE p.factory_id = p_factory AND p.product_type = 'finished' AND p.active
  UNION ALL
  SELECT 'party', CASE WHEN r.kind::text = 'outlet' THEN 'retail' ELSE 'marketer' END,
         r.id::text, r.full_name::text, r.code::text, NULL::text, 0::numeric
    FROM sales_reps r
   WHERE r.factory_id = p_factory AND COALESCE(r.status::text, 'active') = 'active'
  UNION ALL
  SELECT 'party', 'distributor', c.id::text, c.name::text, c.code::text, NULL::text, 0::numeric
    FROM customers c
   WHERE c.factory_id = p_factory AND c.registered AND c.sales_rep_id IS NULL
  UNION ALL
  SELECT 'party', 'direct', 'direct', 'Direct Sales', NULL::text, NULL::text, 0::numeric
  UNION ALL
  SELECT 'line', m.pt, m.pid, m.pname, m.pcode, m.prod, SUM(m.qty)
    FROM moves m
   GROUP BY m.pt, m.pid, m.pname, m.pcode, m.prod;
END;
$fn$;
REVOKE ALL ON FUNCTION public.sales_report_by_party(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_report_by_party(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
