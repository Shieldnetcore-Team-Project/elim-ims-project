-- ============================================================================
-- 30 Oct 2026 = the old system's final record; 31 Oct opens from its balances
-- ----------------------------------------------------------------------------
-- User decision (2026-10-30, final): the old system's "All Products Reports"
-- for today -- which already counts today's releases and postings -- IS the
-- Warehouse's record for 30 Oct, exactly:
--                      Opening  Qty In  Total  Qty Out  Ret  Gift  Balance
--   75cl Bottle Water   13,661     819 14,480    1,116    0     0   13,364
--   50cl Bottle Water      302     695    997      500    0     0      497
--   Sachet Water           126   2,566  2,692    2,637    0     0       55
--   Dispenser Water        152     590    742      625    0     0      117
--     ("Dispenser/Jug Water (Old Jug)", 20261028140000)
--   35cl Bottle Water      960       0    960      200    0     0      760
--   1.5Ltr Bottle Water: not on the old report, not held -- cleared to 0
-- Tomorrow's opening is its Balance, and from 31 Oct this system's own
-- records run the report.
--
-- So, for each product:
--   * its stored 30 Oct row (warehouse_report_snapshots) becomes these
--     figures, and the report shows it AS IS -- nothing from this system
--     is added on top for 30 Oct (replaces 20261030160000's rule);
--   * Warehouse stock becomes the Balance: the difference is one more
--     balance-brought-forward line (BALANCE-BF-2026-10-30), so stock at the
--     close of today -- and 31 Oct's Opening -- is the Balance.
-- Only on 30 Oct (Lagos): run on a later day it changes nothing, so it can
-- never reset stock that has moved since. Run it once the Warehouse has
-- finished for today; anything recorded in this system after it, today,
-- would add to tomorrow's Opening. Safe to run again the same day.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_row record;
  v_n int;
  v_pid uuid;
  v_name text;
  v_unit text;
  v_before numeric;
  v_delta numeric;
  v_done jsonb := '[]'::jsonb;
BEGIN
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;
  IF (now() AT TIME ZONE 'Africa/Lagos')::date <> '2026-10-30' THEN
    RAISE NOTICE 'Not 30 Oct 2026 any more -- stock and the 30 Oct record left as they are';
    RETURN;
  END IF;

  FOR v_row IN SELECT * FROM (VALUES
      ('75cl Bottle Water', '^75 ?cl bottle',                          13661::numeric, 819::numeric, 1116::numeric, 13364::numeric),
      ('50cl Bottle Water', '^50 ?cl bottle',                            302,  695,  500,   497),
      ('Sachet Water',      '^(sachet|satchet) water',                   126, 2566, 2637,    55),
      ('Dispenser Water',   '^dispenser( water$|/jug water \(old jug\))', 152,  590,  625,   117),
      ('35cl Bottle Water', '^35 ?cl bottle',                            960,    0,  200,   760)
    ) AS t(label, pattern, opening, qty_in, qty_out, balance)
  LOOP
    v_n := (SELECT count(*) FROM products
             WHERE factory_id = v_factory AND product_type = 'finished' AND active
               AND btrim(name) ~* v_row.pattern);
    IF v_n <> 1 THEN
      RAISE NOTICE '%: % matching products -- not changed', v_row.label, v_n;
      CONTINUE;
    END IF;
    v_pid := (SELECT id FROM products
               WHERE factory_id = v_factory AND product_type = 'finished' AND active
                 AND btrim(name) ~* v_row.pattern);
    PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
    v_name := (SELECT name FROM products WHERE id = v_pid);
    v_unit := (SELECT unit FROM products WHERE id = v_pid);

    -- The 30 Oct record: the old system's row, exactly.
    INSERT INTO warehouse_report_snapshots(factory_id, report_date, product_id, opening, qty_in, qty_out,
                                           returned, gift, balance, source)
    VALUES (v_factory, '2026-10-30', v_pid, v_row.opening, v_row.qty_in, v_row.qty_out, 0, 0, v_row.balance,
            'Old system: All Products Reports, 30 Oct 2026 (final)')
    ON CONFLICT (product_id, report_date) DO UPDATE
      SET opening = EXCLUDED.opening, qty_in = EXCLUDED.qty_in, qty_out = EXCLUDED.qty_out,
          returned = 0, gift = 0, balance = EXCLUDED.balance, source = EXCLUDED.source;

    -- Stock at today's close = the Balance.
    v_before := (SELECT current_stock FROM products WHERE id = v_pid);
    v_delta := v_row.balance - v_before;
    IF v_delta <> 0 THEN
      UPDATE products SET current_stock = v_row.balance, updated_at = now() WHERE id = v_pid;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after, created_at)
      VALUES (v_factory, v_pid, 'opening_balance', v_delta, 'BALANCE-BF-2026-10-30',
              format('Balance brought forward: the old system''s final 30 Oct 2026 balance, %s %s',
                     v_row.balance, v_unit),
              auth.uid(), v_before, v_row.balance, clock_timestamp());
    END IF;
    v_done := v_done || jsonb_build_object('product', v_name, 'balance', v_row.balance,
                                           'stock_was', v_before, 'adjusted_by', v_delta);
    RAISE NOTICE '%: 30 Oct = old system''s row; stock % (was %)', v_name, v_row.balance, v_before;
  END LOOP;

  -- 1.5Ltr Bottle Water is not on the old report: the Warehouse holds none
  -- (user, 2026-10-30), so its stock is cleared to 0 the same way.
  v_n := (SELECT count(*) FROM products
           WHERE factory_id = v_factory AND product_type = 'finished' AND active
             AND btrim(name) ~* '^1\.5 ?(l|ltr|litre|liter)\M');
  IF v_n <> 1 THEN
    RAISE NOTICE '1.5Ltr Bottle Water: % matching products -- not changed', v_n;
  ELSE
    v_pid := (SELECT id FROM products
               WHERE factory_id = v_factory AND product_type = 'finished' AND active
                 AND btrim(name) ~* '^1\.5 ?(l|ltr|litre|liter)\M');
    PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
    v_name := (SELECT name FROM products WHERE id = v_pid);
    v_unit := (SELECT unit FROM products WHERE id = v_pid);
    v_before := (SELECT current_stock FROM products WHERE id = v_pid);
    IF v_before <> 0 THEN
      UPDATE products SET current_stock = 0, updated_at = now() WHERE id = v_pid;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after, created_at)
      VALUES (v_factory, v_pid, 'opening_balance', -v_before, 'BALANCE-BF-2026-10-30',
              format('Balance brought forward 30 Oct 2026: cleared to 0 %s (not held, user)', v_unit),
              auth.uid(), v_before, 0, clock_timestamp());
    END IF;
    v_done := v_done || jsonb_build_object('product', v_name, 'balance', 0,
                                           'stock_was', v_before, 'adjusted_by', -v_before);
    RAISE NOTICE '%: cleared to 0 (was %)', v_name, v_before;
  END IF;

  IF jsonb_array_length(v_done) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'stock_count', 'products', 'BALANCE-BF-2026-10-30',
            jsonb_build_object('date', '2026-10-30', 'products', v_done,
                               'reason', 'Old system''s final 30 Oct record; 31 Oct opens from its balances'));
  END IF;
END $$;

-- The report: a day with a stored old-system row shows that row as is; any
-- other day is worked out from the stock ledger. The next day's Opening is
-- the stock at that day's start (here: the old system's Balance).
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
  ), calc AS (
    SELECT p.id, p.name, p.unit,
           p.current_stock - COALESCE(dy.after_day, 0) - COALESCE(dy.on_day, 0) AS opening,
           COALESCE(dy.qty_in, 0) AS qty_in,
           COALESCE(dy.qty_out, 0) AS qty_out,
           COALESCE(dy.returned, 0) AS returned,
           COALESCE(dy.gift, 0) AS gift,
           COALESCE(dy.adjusted, 0) AS adjusted,
           p.current_stock - COALESCE(dy.after_day, 0) AS balance
      FROM products p
      LEFT JOIN day dy ON dy.pid = p.id
     WHERE p.factory_id = p_factory AND p.product_type = 'finished' AND p.active
  )
  SELECT c.id, c.name, c.unit,
         COALESCE(sn.opening, c.opening),
         COALESCE(sn.qty_in, c.qty_in),
         COALESCE(sn.opening + sn.qty_in, c.opening + c.qty_in),
         COALESCE(sn.qty_out, c.qty_out),
         COALESCE(sn.returned, c.returned),
         COALESCE(sn.gift, c.gift),
         CASE WHEN sn.product_id IS NULL THEN c.adjusted ELSE 0 END,
         COALESCE(sn.balance, c.balance)
    FROM calc c
    LEFT JOIN warehouse_report_snapshots sn ON sn.product_id = c.id AND sn.report_date = p_date
   ORDER BY c.name;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_products_report(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_products_report(uuid, date) TO authenticated;
