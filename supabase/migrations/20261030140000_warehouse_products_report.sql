-- ============================================================================
-- Warehouse › Products Report (user request 2026-10-30)
-- ----------------------------------------------------------------------------
-- The old system's "All Products Reports", per finished product for one day:
--   Opening | Qty In | Total | Qty Out | Returned | Gift/Sample | Adjusted |
--   Balance
-- Opening + Qty In - Qty Out + Returned - Gift/Sample + Adjusted = Balance.
--
-- Built from inventory_movements, the Warehouse's stock ledger. Each line's
-- change is quantity_after - quantity_before (its stored quantity's sign
-- differs by history -- see 20260921090000); for an old line without them
-- the sign comes from its type. Balance is today's stock less everything
-- that moved after the day, so today's Balance is the stock now, and
-- Opening is Balance less the day's movements.
--   Returned     'returned' lines (goods back into the Warehouse)
--   Gift/Sample  PR (no-charge) sales: reason 'PR - complimentary%'
--   Adjusted     stock corrections and counts ('adjusted', 'opening_balance'),
--                e.g. the move from the old system, WAREHOUSE-STOCK-2026-10-30
--   Qty In       everything else that added stock (releases from Production)
--   Qty Out      everything else that took it (postings, sales, damage)
-- ============================================================================

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
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM inventory_movements m
     WHERE m.factory_id = p_factory
       AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date >= p_date
  ), day AS (
    SELECT pid,
      COALESCE(SUM(delta) FILTER (WHERE d > p_date), 0) AS after_day,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date), 0) AS on_day,
      COALESCE(SUM(-delta) FILTER (WHERE d = p_date AND reason ILIKE 'PR - complimentary%'), 0) AS gift,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND mtype = 'returned'
                                    AND reason NOT ILIKE 'PR - complimentary%'), 0) AS returned,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND mtype IN ('adjusted', 'opening_balance')
                                    AND reason NOT ILIKE 'PR - complimentary%'), 0) AS adjusted,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND delta > 0
                                    AND mtype NOT IN ('returned', 'adjusted', 'opening_balance')
                                    AND reason NOT ILIKE 'PR - complimentary%'), 0) AS qty_in,
      COALESCE(SUM(-delta) FILTER (WHERE d = p_date AND delta < 0
                                     AND mtype NOT IN ('returned', 'adjusted', 'opening_balance')
                                     AND reason NOT ILIKE 'PR - complimentary%'), 0) AS qty_out
      FROM mv GROUP BY pid
  )
  SELECT p.id, p.name, p.unit,
         p.current_stock - COALESCE(dy.after_day, 0) - COALESCE(dy.on_day, 0),
         COALESCE(dy.qty_in, 0),
         p.current_stock - COALESCE(dy.after_day, 0) - COALESCE(dy.on_day, 0) + COALESCE(dy.qty_in, 0),
         COALESCE(dy.qty_out, 0),
         COALESCE(dy.returned, 0),
         COALESCE(dy.gift, 0),
         COALESCE(dy.adjusted, 0),
         p.current_stock - COALESCE(dy.after_day, 0)
    FROM products p
    LEFT JOIN day dy ON dy.pid = p.id
   WHERE p.factory_id = p_factory AND p.product_type = 'finished' AND p.active
   ORDER BY p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_products_report(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_products_report(uuid, date) TO authenticated;
