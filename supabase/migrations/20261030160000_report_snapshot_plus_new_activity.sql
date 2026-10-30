-- ============================================================================
-- 30 Oct report = the old system's figures + what this system did after
-- ----------------------------------------------------------------------------
-- User report (2026-10-30): Production released 80 packs of 50cl, the
-- Warehouse accepted them, yet 30 Oct's Qty In and Balance stayed at the old
-- system's 613 / 415. The day's row was the stored old-system row and
-- nothing else (20261030150000).
--
-- Now, for a day with an old-system row, each product's row is that row
-- PLUS everything this system recorded for the product after the balance
-- brought forward (its 'opening_balance' line that day; without one, when
-- the row was stored): releases accepted add to Qty In, postings and sales
-- to Qty Out, and so on, and the Balance moves with them -- the same as the
-- Warehouse's stock now.
--
-- A release the Warehouse accepted on that day BEFORE the balance brought
-- forward was overwritten by it (the B/F set the stock to the old figure).
-- Each such release is added back once, as a 'produced' line now ("accepted
-- before the balance brought forward"), so it counts on top like any other.
-- Safe to run again.
-- ============================================================================

-- When the stored old-system row for a product and day took over: its
-- balance-brought-forward line that day, else when the row was stored.
CREATE OR REPLACE FUNCTION public._report_snapshot_cutoff(p_product uuid, p_date date)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT max(m.created_at) FROM inventory_movements m
      WHERE m.product_id = p_product AND m.movement_type = 'opening_balance'
        AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date = p_date),
    (SELECT s.created_at FROM warehouse_report_snapshots s
      WHERE s.product_id = p_product AND s.report_date = p_date));
$$;
REVOKE ALL ON FUNCTION public._report_snapshot_cutoff(uuid, date) FROM PUBLIC, anon, authenticated;

-- Releases accepted before the balance brought forward: add them back once.
DO $$
DECLARE
  v_rel record;
  v_before numeric;
  v_done jsonb := '[]'::jsonb;
BEGIN
  FOR v_rel IN
    SELECT m.factory_id, m.product_id, m.reference, m.quantity, m.created_at, s.report_date, p.name
      FROM warehouse_report_snapshots s
      JOIN inventory_movements m ON m.product_id = s.product_id
       AND m.movement_type = 'produced'
       AND m.reason = 'Production release accepted by Warehouse'
       AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date = s.report_date
      JOIN products p ON p.id = s.product_id
     WHERE m.created_at < public._report_snapshot_cutoff(s.product_id, s.report_date)
       AND NOT EXISTS (SELECT 1 FROM inventory_movements x
                        WHERE x.product_id = m.product_id AND x.reference = m.reference
                          AND x.reason LIKE 'Production release accepted before the balance brought forward%')
  LOOP
    PERFORM 1 FROM products WHERE id = v_rel.product_id FOR UPDATE;
    v_before := (SELECT current_stock FROM products WHERE id = v_rel.product_id);
    UPDATE products SET current_stock = current_stock + v_rel.quantity, updated_at = now()
     WHERE id = v_rel.product_id;
    -- clock_timestamp(): after the B/F line even when both run in one
    -- transaction (pasted together in the SQL Editor, where now() is the same).
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                    quantity_before, quantity_after, created_at)
    VALUES (v_rel.factory_id, v_rel.product_id, 'produced', v_rel.quantity, v_rel.reference,
            'Production release accepted before the balance brought forward: added on top',
            auth.uid(), v_before, v_before + v_rel.quantity, clock_timestamp());
    v_done := v_done || jsonb_build_object('product', v_rel.name, 'release', v_rel.reference,
                                           'quantity', v_rel.quantity, 'stock_now', v_before + v_rel.quantity);
    RAISE NOTICE '%: release % (% ) added back on top of the B/F -- stock now %',
      v_rel.name, v_rel.reference, v_rel.quantity, v_before + v_rel.quantity;
  END LOOP;
  IF jsonb_array_length(v_done) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), (SELECT id FROM factories WHERE code = 'water'), 'stock_count', 'products',
            'BALANCE-BF-2026-10-30', jsonb_build_object('releases_added_back', v_done,
              'reason', 'Releases accepted before the balance brought forward were overwritten by it'));
  ELSE
    RAISE NOTICE 'No release was accepted before the balance brought forward -- nothing to add back';
  END IF;
END $$;

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
           m.created_at AS at,
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM inventory_movements m
     WHERE m.factory_id = p_factory
       AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date >= p_date
  ), sn AS (
    SELECT s.*, public._report_snapshot_cutoff(s.product_id, s.report_date) AS cutoff
      FROM warehouse_report_snapshots s
     WHERE s.factory_id = p_factory AND s.report_date = p_date
  ), cls AS (
    -- The day's lines, sorted into the report's columns; on a day with an
    -- old-system row only the lines after its cutoff count.
    SELECT mv.pid, mv.delta, mv.d,
           (mv.d = p_date AND (sn.product_id IS NULL OR mv.at > sn.cutoff)) AS counts,
           CASE WHEN mv.reason ILIKE 'PR - complimentary%' THEN 'gift'
                WHEN mv.mtype = 'returned' THEN 'returned'
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
