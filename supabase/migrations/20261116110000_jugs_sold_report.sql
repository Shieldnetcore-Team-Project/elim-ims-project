-- ============================================================================
-- Jugs sold: the month's total, under QC › Reports and Warehouse › Reports
-- ----------------------------------------------------------------------------
-- User (2026-11-16): "all this jug that I've sold ... posting to marketers ...
-- there should be a place where you can get the total of the jugs we sold for
-- the month ... we have sold 1,000 or 2,000 jugs but it's not displaying
-- anywhere" -- "under report tab", on Quality Control and Warehouse.
--
-- A jug is sold when it leaves with its buyer for good:
--   Jug + Water   a dispenser line typed 'permanent' (price N4,200), in jugs
--   Empty Jug     the Empty Jug product (N3,000), one jug a piece
-- Counted once, where it leaves the company:
--   Marketers     their postings (stock_dispatches, dispatch_date), including
--                 Dispenser Water the Warehouse marked as Jug + Water at the
--                 return (jw_marked), less Jug + Water / Empty Jug returned
--                 unsold (rep_returns.return_date). Their own van sales
--                 (Accounts' marketer-customer sales) are NOT counted again --
--                 those jugs came off the posting.
--   Retail Shop   its POS sales (sale_date). Postings to the shop are not
--                 counted -- the shop's sales are.
--   Distributors / Office Delivery / walk-in   Warehouse sales (sale_date),
--                 less Empty Jug returned and Jug + Water returned on a sale
--                 whose lines for that product were all Jug + Water.
-- Posted sales only; deleted and PR (complimentary) sales left out.
--
-- jugs_sold_report(factory, from, to) -> one row per buyer per day.
-- Read-only; changes nothing. Paste into the Supabase SQL Editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.jugs_sold_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(sold_on date, buyer_kind text, buyer_id uuid, buyer_name text, buyer_code text,
              jug_water numeric, empty_jug numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public._qc_jug_collections_can_view(p_factory)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  IF p_to - p_from > 400 THEN RAISE EXCEPTION 'Pick at most a year'; END IF;

  RETURN QUERY
  WITH ej AS (
    SELECT p.id FROM products p WHERE p.factory_id = p_factory AND lower(btrim(p.name)) = 'empty jug'
  ), parts AS (
    -- Marketers: posted.
    SELECT sd.dispatch_date AS d, 'rep'::text AS k, sd.sales_rep_id AS id, NULL::text AS nm,
           COALESCE(SUM(sdi.quantity * pj.per_unit) FILTER (WHERE sdi.jar_mode = 'permanent'), 0) AS jw,
           COALESCE(SUM(sdi.quantity) FILTER (WHERE sdi.product_id IN (SELECT id FROM ej)), 0) AS e
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      JOIN sales_reps sr ON sr.id = sd.sales_rep_id AND COALESCE(sr.kind, 'rep') <> 'outlet'
      LEFT JOIN LATERAL public._product_jug(sdi.product_id) pj ON true
     WHERE sd.factory_id = p_factory AND sd.status = 'posted'
       AND sd.dispatch_date BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3
    UNION ALL
    -- Marketers: returned unsold.
    SELECT rr.return_date, 'rep', rr.sales_rep_id, NULL,
           -COALESCE(SUM(COALESCE(rri.accepted_quantity, 0) * pj.per_unit) FILTER (WHERE rri.jar_mode = 'permanent'), 0),
           -COALESCE(SUM(COALESCE(rri.accepted_quantity, 0)) FILTER (WHERE rri.product_id IN (SELECT id FROM ej)), 0)
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      JOIN sales_reps sr ON sr.id = rr.sales_rep_id AND sr.factory_id = p_factory
                        AND COALESCE(sr.kind, 'rep') <> 'outlet'
      LEFT JOIN LATERAL public._product_jug(rri.product_id) pj ON true
     WHERE rr.status = 'completed' AND rr.return_date BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3
    UNION ALL
    -- Retail Shop POS and Warehouse sales (not marketers' van sales).
    SELECT s.sale_date,
           CASE WHEN s.sales_rep_id IS NOT NULL THEN 'shop'
                WHEN s.customer_id IS NOT NULL THEN 'customer' ELSE 'walk_in' END,
           COALESCE(s.sales_rep_id, s.customer_id),
           CASE WHEN s.sales_rep_id IS NULL AND s.customer_id IS NULL
                THEN COALESCE(NULLIF(btrim(s.customer_name), ''), 'Walk-in') END,
           COALESCE(SUM(si.quantity * pj.per_unit) FILTER (WHERE si.jar_mode = 'permanent'), 0),
           COALESCE(SUM(si.quantity) FILTER (WHERE si.product_id IN (SELECT id FROM ej)), 0)
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN sales_reps sr ON sr.id = s.sales_rep_id
      LEFT JOIN LATERAL public._product_jug(si.product_id) pj ON true
     WHERE s.factory_id = p_factory AND s.status = 'posted' AND s.deleted_at IS NULL
       AND NOT COALESCE(s.is_pr, false)
       AND (s.sales_rep_id IS NULL OR sr.kind = 'outlet')
       AND s.sale_date BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3, 4
    UNION ALL
    -- Customers' returns (Warehouse › Returns).
    SELECT r.return_date,
           CASE WHEN r.customer_id IS NOT NULL THEN 'customer' ELSE 'walk_in' END,
           r.customer_id,
           CASE WHEN r.customer_id IS NULL THEN COALESCE(NULLIF(btrim(s.customer_name), ''), 'Walk-in') END,
           -COALESCE(SUM(COALESCE(r.accepted_quantity, 0) * pj.per_unit)
              FILTER (WHERE pj.per_unit IS NOT NULL AND r.sale_id IS NOT NULL
                        AND EXISTS (SELECT 1 FROM sale_items x WHERE x.sale_id = r.sale_id
                                     AND x.product_id = r.product_id AND x.jar_mode = 'permanent')
                        AND NOT EXISTS (SELECT 1 FROM sale_items x WHERE x.sale_id = r.sale_id
                                     AND x.product_id = r.product_id
                                     AND x.jar_mode IS DISTINCT FROM 'permanent')), 0),
           -COALESCE(SUM(COALESCE(r.accepted_quantity, 0)) FILTER (WHERE r.product_id IN (SELECT id FROM ej)), 0)
      FROM sales_returns r
      LEFT JOIN sales s ON s.id = r.sale_id
      LEFT JOIN sales_reps sr ON sr.id = r.sales_rep_id
      LEFT JOIN LATERAL public._product_jug(r.product_id) pj ON true
     WHERE r.factory_id = p_factory AND r.status = 'completed'
       AND (r.sales_rep_id IS NULL OR sr.kind = 'outlet')
       AND r.return_date BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3, 4
  ), agg AS (
    SELECT p.d, p.k, p.id, p.nm, SUM(p.jw) AS jw, SUM(p.e) AS e
      FROM parts p GROUP BY 1, 2, 3, 4
  )
  SELECT a.d, a.k, a.id,
         COALESCE(sr.full_name::text, c.name::text, a.nm, 'Walk-in'),
         sr.code::text,
         a.jw, a.e
    FROM agg a
    LEFT JOIN sales_reps sr ON a.k IN ('rep', 'shop') AND sr.id = a.id
    LEFT JOIN customers c ON a.k = 'customer' AND c.id = a.id
   WHERE a.jw <> 0 OR a.e <> 0
   ORDER BY a.d, a.k, 4;
END;
$fn$;
REVOKE ALL ON FUNCTION public.jugs_sold_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jugs_sold_report(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
