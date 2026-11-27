-- Keep Warehouse returns out of Qty In. Direct customer returns use
-- movement_type 'returned'; marketer and Retail Shop returns use
-- 'return_from_rep'. The latter must be reported in Returned as well.
--
-- Opening remains the stock at the start of p_from, derived from the current
-- ledger balance less every movement from p_from onward (the previous
-- closing). Movements during the selected period cannot change that opening.
CREATE OR REPLACE FUNCTION public.warehouse_products_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(product_id uuid, product_name text, unit text,
              opening numeric, qty_in numeric, qty_out numeric, gift numeric,
              returned numeric, sold numeric, empty_jug_sold numeric, adjusted numeric,
              balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_start timestamptz := p_from::timestamp AT TIME ZONE 'Africa/Lagos';
  v_end timestamptz := (p_to + 1)::timestamp AT TIME ZONE 'Africa/Lagos';
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT m.product_id AS pid,
           COALESCE(m.quantity_after - m.quantity_before,
                    CASE WHEN m.movement_type::text IN ('sold', 'issued', 'transferred', 'damaged', 'used_for_production')
                         THEN -abs(m.quantity) ELSE m.quantity END) AS delta,
           m.movement_type::text AS mtype,
           COALESCE(m.reason, '') AS reason,
           COALESCE(m.reference, '') AS ref,
           m.created_at < v_end AS in_range
      FROM inventory_movements m
     WHERE m.factory_id = p_factory AND m.created_at >= v_start
  ), cls AS (
    SELECT mv.pid, mv.delta, mv.in_range,
           CASE WHEN public._is_gift_movement(mv.reason, mv.ref) AND mv.delta < 0 THEN 'gift'
                WHEN mv.mtype = 'return_from_rep'
                     AND EXISTS (SELECT 1 FROM stock_dispatches sd
                                  WHERE sd.dispatch_number = mv.ref) THEN 'out'
                WHEN mv.mtype IN ('returned', 'return_from_rep') THEN 'returned'
                WHEN mv.mtype IN ('adjusted', 'opening_balance') THEN 'adjusted'
                WHEN mv.delta > 0 THEN 'in'
                ELSE 'out' END AS col
      FROM mv
  ), agg AS (
    SELECT pid,
      COALESCE(SUM(delta), 0) AS after_start,
      COALESCE(SUM(delta) FILTER (WHERE NOT in_range), 0) AS after_end,
      COALESCE(SUM(delta) FILTER (WHERE in_range AND col = 'in'), 0) AS q_in,
      COALESCE(SUM(-delta) FILTER (WHERE in_range AND col = 'out'), 0) AS q_out,
      COALESCE(SUM(-delta) FILTER (WHERE in_range AND col = 'gift'), 0) AS q_gift,
      COALESCE(SUM(delta) FILTER (WHERE in_range AND col = 'returned'), 0) AS q_ret,
      COALESCE(SUM(delta) FILTER (WHERE in_range AND col = 'adjusted'), 0) AS q_adj
      FROM cls GROUP BY pid
  ), w AS (
    SELECT p.id AS pid, p.name::text AS pname, p.unit::text AS punit,
           p.current_stock - COALESCE(a.after_start, 0) AS op,
           COALESCE(a.q_in, 0) AS q_in, COALESCE(a.q_out, 0) AS q_out,
           COALESCE(a.q_gift, 0) AS q_gift, COALESCE(a.q_ret, 0) AS q_ret,
           COALESCE(a.q_adj, 0) AS q_adj,
           p.current_stock - COALESCE(a.after_end, 0) AS bal
      FROM products p LEFT JOIN agg a ON a.pid = p.id
     WHERE p.factory_id = p_factory AND p.product_type = 'finished' AND p.active
  ), jug AS (
    SELECT COALESCE(SUM(w.q_out - w.q_ret), 0) AS jug_sold
      FROM w
     WHERE lower(btrim(w.pname)) IN ('empty jug', 'dispenser empty')
  ), first_dispenser AS (
    SELECT w.pid
      FROM w
     WHERE w.pname ILIKE 'dispenser%' AND w.pname NOT ILIKE '%empty%'
     ORDER BY w.pname
     LIMIT 1
  )
  SELECT w.pid, w.pname, w.punit, w.op, w.q_in, w.q_out, w.q_gift, w.q_ret,
         GREATEST(w.q_out - w.q_ret, 0),
         CASE WHEN w.pid = (SELECT first_dispenser.pid FROM first_dispenser)
              THEN (SELECT jug.jug_sold FROM jug) ELSE 0 END,
         w.q_adj, w.bal
    FROM w
   WHERE lower(btrim(w.pname)) NOT IN ('empty jug', 'dispenser empty')
     AND (w.op <> 0 OR w.q_in <> 0 OR w.q_out <> 0 OR w.q_gift <> 0 OR w.q_ret <> 0
          OR w.q_adj <> 0 OR w.bal <> 0)
   ORDER BY w.pname;
END;
$fn$;
REVOKE ALL ON FUNCTION public.warehouse_products_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_products_report(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
