-- Keep Warehouse returns in the Returned column on the single-day report.
-- The date-range report already classifies marketer / shop returns
-- (return_from_rep); the daily report must do the same.
CREATE OR REPLACE FUNCTION public.warehouse_products_report(p_factory uuid, p_date date)
RETURNS TABLE(product_id uuid, product text, unit text, opening numeric, qty_in numeric,
              total numeric, qty_out numeric, returned numeric, gift numeric,
              adjusted numeric, balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_date IS NULL THEN RAISE EXCEPTION 'Pick a day'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT m.product_id AS pid,
           COALESCE(m.quantity_after - m.quantity_before,
                    CASE WHEN m.movement_type::text IN ('sold', 'issued', 'transferred', 'damaged', 'used_for_production')
                         THEN -abs(m.quantity) ELSE m.quantity END) AS delta,
           m.movement_type::text AS mtype,
           COALESCE(m.reason, '') AS reason,
           COALESCE(m.reference, '') AS ref,
           m.created_at AS at,
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM inventory_movements m
     WHERE m.factory_id = p_factory
       AND m.created_at >= (p_date::timestamp AT TIME ZONE 'Africa/Lagos')
  ), sn AS (
    SELECT s.*, public._report_snapshot_cutoff(s.product_id, s.report_date) AS cutoff
      FROM warehouse_report_snapshots s
     WHERE s.factory_id = p_factory AND s.report_date = p_date
  ), cls AS (
    SELECT mv.pid, mv.delta, mv.d,
           (mv.d = p_date AND (sn.product_id IS NULL OR mv.at > sn.cutoff)) AS counts,
           CASE WHEN public._is_gift_movement(mv.reason, mv.ref) AND mv.delta < 0 THEN 'gift'
                WHEN mv.mtype = 'return_from_rep'
                     AND EXISTS (SELECT 1 FROM stock_dispatches sd
                                  WHERE sd.dispatch_number = mv.ref) THEN 'out'
                WHEN mv.mtype IN ('returned', 'return_from_rep') THEN 'returned'
                WHEN mv.mtype IN ('adjusted', 'opening_balance') THEN 'adjusted'
                WHEN mv.delta > 0 THEN 'in'
                ELSE 'out' END AS col
      FROM mv LEFT JOIN sn ON sn.product_id = mv.pid
  ), day AS (
    SELECT pid,
      COALESCE(SUM(delta) FILTER (WHERE d > p_date), 0) AS after_day,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date), 0) AS on_day,
      COALESCE(SUM(delta) FILTER (WHERE counts), 0) AS counted,
      COALESCE(SUM(-delta) FILTER (WHERE counts AND col = 'gift'), 0) AS gift,
      COALESCE(SUM(delta) FILTER (WHERE counts AND col = 'returned'), 0) AS returned,
      COALESCE(SUM(delta) FILTER (WHERE counts AND col = 'adjusted'), 0) AS adjusted,
      COALESCE(SUM(delta) FILTER (WHERE counts AND col = 'in'), 0) AS qty_in,
      COALESCE(SUM(-delta) FILTER (WHERE counts AND col = 'out'), 0) AS qty_out
      FROM cls GROUP BY pid
  )
  SELECT p.id, p.name, p.unit,
         COALESCE(sn.opening, p.current_stock - COALESCE(dy.after_day, 0) - COALESCE(dy.on_day, 0)),
         COALESCE(sn.qty_in, 0) + COALESCE(dy.qty_in, 0),
         COALESCE(sn.opening, p.current_stock - COALESCE(dy.after_day, 0) - COALESCE(dy.on_day, 0))
           + COALESCE(sn.qty_in, 0) + COALESCE(dy.qty_in, 0),
         COALESCE(sn.qty_out, 0) + COALESCE(dy.qty_out, 0),
         COALESCE(sn.returned, 0) + COALESCE(dy.returned, 0),
         COALESCE(sn.gift, 0) + COALESCE(dy.gift, 0),
         COALESCE(dy.adjusted, 0),
         CASE WHEN sn.product_id IS NULL THEN p.current_stock - COALESCE(dy.after_day, 0)
              ELSE sn.balance + COALESCE(dy.counted, 0) END
    FROM products p
    LEFT JOIN day dy ON dy.pid = p.id
    LEFT JOIN sn ON sn.product_id = p.id
   WHERE p.factory_id = p_factory AND p.product_type = 'finished' AND p.active
   ORDER BY p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_products_report(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_products_report(uuid, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
