-- ============================================================================
-- Exact jug figures: no negative Warehouse, customers or marketers
-- ----------------------------------------------------------------------------
-- User (2026-11-04), Bottle tracking showing New Jug -173 in the Warehouse
-- and -11 with customers: "lets not have negative figure in warehouse, lets
-- have the exact figure available in the warehouse, with customers and with
-- marketers".
--
--   Warehouse  = the dispensers in Warehouse stock, one jug each -- every
--                product carrying a jug (filled dispensers and the empty-jug
--                product), current_stock x jugs per unit. Read live from the
--                stock, so it is always what the Warehouse holds.
--   A customer / marketer / the shop below 0 (they brought back jugs they had
--                before tracking started) is brought to 0 once, by a 'count'
--                move from outside; from then on their figure is what went
--                out to them less what came back.
--   The jug ledger's Warehouse figure is set to the stock figure once too, so
--   history and the screen agree from today.
--
-- jug_places_now(factory)  the Bottle tracking "Where the containers are"
--   table: Store, QC, Production (ledger), Warehouse (stock), customers,
--   marketers, walk-in (each holder at 0 or above).
-- jug_locations(factory, day)  the QC report, the same way (Warehouse from
--   stock when the day is today; holders never below 0).
-- ============================================================================

-- Jugs in Warehouse stock now.
CREATE OR REPLACE FUNCTION public._jug_warehouse_stock(p_factory uuid, p_type uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(GREATEST(p.current_stock, 0) * pc.quantity_per_unit), 0)
    FROM product_containers pc JOIN products p ON p.id = pc.product_id
   WHERE pc.container_type_id = p_type AND p.factory_id = p_factory;
$$;
REVOKE ALL ON FUNCTION public._jug_warehouse_stock(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- one-time
DO $$
DECLARE t record; h record; v_now numeric; v_exact numeric;
BEGIN
  FOR t IN SELECT ct.id, ct.factory_id FROM container_types ct LOOP
    -- Customers / marketers / the shop below 0 -> 0.
    FOR h IN SELECT b.holder_type, b.holder_id, b.balance FROM container_balances b
              WHERE b.container_type_id = t.id AND b.holder_type IN ('customer', 'sales_rep', 'walk_in')
                AND b.balance < 0 LOOP
      INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                      source, reference, notes)
      VALUES (t.factory_id, t.id, 'external', NULL, h.holder_type, h.holder_id, -h.balance, 'count', 'COUNT',
              'Jugs held before tracking started (2026-11-04)');
    END LOOP;
    -- The Warehouse ledger to the stock figure.
    v_now := COALESCE((SELECT SUM(balance) FROM container_balances
                        WHERE container_type_id = t.id AND holder_type = 'warehouse'), 0);
    v_exact := public._jug_warehouse_stock(t.factory_id, t.id);
    IF v_exact > v_now THEN
      INSERT INTO container_movements(factory_id, container_type_id, from_type, to_type, quantity, source, reference, notes)
      VALUES (t.factory_id, t.id, 'external', 'warehouse', v_exact - v_now, 'count', 'COUNT',
              'Warehouse set to the dispensers in stock (2026-11-04)');
    ELSIF v_exact < v_now THEN
      INSERT INTO container_movements(factory_id, container_type_id, from_type, to_type, quantity, source, reference, notes)
      VALUES (t.factory_id, t.id, 'warehouse', 'external', v_now - v_exact, 'count', 'COUNT',
              'Warehouse set to the dispensers in stock (2026-11-04)');
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- now
CREATE OR REPLACE FUNCTION public.jug_places_now(p_factory uuid)
RETURNS TABLE(container_type_id uuid, container_name text, store numeric, qc numeric, production numeric,
              warehouse numeric, customers numeric, marketers numeric, walk_in numeric, total numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._jug_can_view()
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH b AS (
    SELECT cb.container_type_id AS t, cb.holder_type AS h, GREATEST(cb.balance, 0) AS q
      FROM container_balances cb WHERE cb.factory_id = p_factory
  ), s AS (
    SELECT t, SUM(q) FILTER (WHERE h = 'store') AS st, SUM(q) FILTER (WHERE h = 'qc') AS qc,
           SUM(q) FILTER (WHERE h = 'production') AS pr, SUM(q) FILTER (WHERE h = 'customer') AS cu,
           SUM(q) FILTER (WHERE h = 'sales_rep') AS mk, SUM(q) FILTER (WHERE h = 'walk_in') AS wi
      FROM b GROUP BY t
  ), r AS (
    SELECT ct.id, ct.name::text AS name, COALESCE(s.st, 0) AS st, COALESCE(s.qc, 0) AS qc, COALESCE(s.pr, 0) AS pr,
           public._jug_warehouse_stock(p_factory, ct.id) AS wh,
           COALESCE(s.cu, 0) AS cu, COALESCE(s.mk, 0) AS mk, COALESCE(s.wi, 0) AS wi
      FROM container_types ct LEFT JOIN s ON s.t = ct.id
     WHERE ct.factory_id = p_factory AND ct.active
  )
  SELECT r.id, r.name, r.st, r.qc, r.pr, r.wh, r.cu, r.mk, r.wi, r.st + r.qc + r.pr + r.wh + r.cu + r.mk + r.wi
    FROM r ORDER BY r.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_places_now(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_places_now(uuid) TO authenticated;

-- ---------------------------------------------------------------- on a day
CREATE OR REPLACE FUNCTION public.jug_locations(p_factory uuid, p_at date)
RETURNS TABLE(container_type_id uuid, container_name text, store numeric, qc numeric, production numeric,
              warehouse numeric, marketers numeric, customers numeric, walk_in numeric, total numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_today boolean := p_at >= (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  IF NOT (public._jug_can_view()
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH d AS (
    SELECT m.container_type_id AS t, m.to_type AS h, m.to_id AS hid, m.quantity AS q FROM container_movements m
     WHERE m.factory_id = p_factory AND public._jug_day(m.created_at) <= p_at
    UNION ALL
    SELECT m.container_type_id, m.from_type, m.from_id, -m.quantity FROM container_movements m
     WHERE m.factory_id = p_factory AND public._jug_day(m.created_at) <= p_at
  ), hb AS (
    -- Per holder, never below 0.
    SELECT t, h, GREATEST(SUM(q), 0) AS q FROM d GROUP BY t, h, hid
  ), s AS (
    SELECT t, SUM(q) FILTER (WHERE h = 'store') AS st, SUM(q) FILTER (WHERE h = 'qc') AS qc,
           SUM(q) FILTER (WHERE h = 'production') AS pr, SUM(q) FILTER (WHERE h = 'warehouse') AS wh,
           SUM(q) FILTER (WHERE h = 'sales_rep') AS mk, SUM(q) FILTER (WHERE h = 'customer') AS cu,
           SUM(q) FILTER (WHERE h = 'walk_in') AS wi
      FROM hb GROUP BY t
  ), r AS (
    SELECT ct.id, ct.name::text AS name, COALESCE(s.st, 0) AS st, COALESCE(s.qc, 0) AS qc, COALESCE(s.pr, 0) AS pr,
           CASE WHEN v_today THEN public._jug_warehouse_stock(p_factory, ct.id) ELSE COALESCE(s.wh, 0) END AS wh,
           COALESCE(s.mk, 0) AS mk, COALESCE(s.cu, 0) AS cu, COALESCE(s.wi, 0) AS wi
      FROM container_types ct LEFT JOIN s ON s.t = ct.id
     WHERE ct.factory_id = p_factory AND ct.active
  )
  SELECT r.id, r.name, r.st, r.qc, r.pr, r.wh, r.mk, r.cu, r.wi, r.st + r.qc + r.pr + r.wh + r.mk + r.cu + r.wi
    FROM r ORDER BY r.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_locations(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_locations(uuid, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
