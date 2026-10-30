-- ============================================================================
-- Acceptance tests: the old system's final 30 Oct record
-- (20261030180000_old_system_final_30oct.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration's block runs with its
-- "only on 30 Oct" guard off. Starting from an earlier state (old 613/415
-- row, an 80-pack release accepted today, other stocks off), it leaves:
--   * 30 Oct = the old system's final rows exactly, nothing added on top;
--   * Warehouse stock = their Balances, 1.5Ltr cleared to 0; 31 Oct opens at them;
--   * a release accepted on 31 Oct adds to 31 Oct's Qty In and Balance.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b0700000-0000-0000-0000-000000000001', 'wh@final'),
  ('b0700000-0000-0000-0000-000000000002', 'pm@final');
DELETE FROM user_roles WHERE user_id IN ('b0700000-0000-0000-0000-000000000001', 'b0700000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('b0700000-0000-0000-0000-000000000001', 'super_admin');
UPDATE products SET active = false, name = name || ' (old ' || left(id::text, 8) || ')' WHERE product_type = 'finished';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT x.id::uuid, f.id, x.name, x.unit, 'finished', true, x.stock, 1000
  FROM factories f, (VALUES ('b0700000-0000-0000-0000-0000000000a1','75cl Bottle Water','Pack',13364),
                            ('b0700000-0000-0000-0000-0000000000a2','50cl Bottle Water','Pack',495),
                            ('b0700000-0000-0000-0000-0000000000a3','Sachet Water','Bag',545),
                            ('b0700000-0000-0000-0000-0000000000a4','Dispenser/Jug Water (Old Jug)','Piece',93),
                            ('b0700000-0000-0000-0000-0000000000a5','35cl Bottle Water','Pack',760),
                            ('b0700000-0000-0000-0000-0000000000a6','1.5Ltr Bottle Water','Pack',517)) AS x(id,name,unit,stock)
 WHERE f.code = 'water';
-- Earlier state: the first old-system row for 50cl.
INSERT INTO warehouse_report_snapshots(factory_id, report_date, product_id, opening, qty_in, qty_out, balance, source)
SELECT id, '2026-10-30', 'b0700000-0000-0000-0000-0000000000a2', 302, 613, 500, 415, 'earlier' FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: 30 Oct is the final old-system record; stock and 31 Oct opening are its balances
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
  IF false THEN
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
  IF false THEN
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
DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_n int;
  v_pid uuid;
BEGIN
  v_n := (SELECT count(*) FROM products
           WHERE factory_id = v_factory AND product_type = 'finished' AND active
             AND btrim(name) ~* '^1\.5 ?(l|ltr|litre|liter)\M');
  IF v_n <> 1 THEN
    RAISE NOTICE '1.5Ltr Bottle Water: % matching products -- not changed', v_n;
    RETURN;
  END IF;
  v_pid := (SELECT id FROM products
             WHERE factory_id = v_factory AND product_type = 'finished' AND active
               AND btrim(name) ~* '^1\.5 ?(l|ltr|litre|liter)\M');

  INSERT INTO warehouse_report_snapshots(factory_id, report_date, product_id, opening, qty_in, qty_out,
                                         returned, gift, balance, source)
  VALUES (v_factory, '2026-10-30', v_pid, 0, 0, 0, 0, 0, 0, 'Not held: nothing brought forward (user)')
  ON CONFLICT (product_id, report_date) DO UPDATE
    SET opening = 0, qty_in = 0, qty_out = 0, returned = 0, gift = 0, balance = 0, source = EXCLUDED.source;

  IF (SELECT current_stock FROM products WHERE id = v_pid) <> 0 THEN
    RAISE NOTICE '1.5Ltr Bottle Water: 30 Oct row set to 0, but stock is % -- run 20261030180000 first',
      (SELECT current_stock FROM products WHERE id = v_pid);
  ELSE
    RAISE NOTICE '1.5Ltr Bottle Water: 30 Oct all 0; stock 0';
  END IF;
END $$;
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); got text; rel uuid;
BEGIN
  PERFORM set_config('test.uid', 'b0700000-0000-0000-0000-000000000001', false);
  got := (SELECT string_agg(concat_ws('/', right(r.product_id::text, 1), r.opening::int, r.qty_in::int, r.total::int,
                                      r.qty_out::int, r.returned::int, r.gift::int, r.adjusted::int, r.balance::int), ' '
                            ORDER BY r.product_id)
            FROM public.warehouse_products_report(f, '2026-10-30') r
           WHERE r.product_id::text LIKE 'b0700000-%' AND right(r.product_id::text, 1) <> '6');
  PERFORM pg_temp.check(got = '1/13661/819/14480/1116/0/0/0/13364 2/302/695/997/500/0/0/0/497 '
                           || '3/126/2566/2692/2637/0/0/0/55 4/152/590/742/625/0/0/0/117 5/960/0/960/200/0/0/0/760',
                        '30 Oct: ' || got);
  got := (SELECT string_agg(right(id::text, 1) || '=' || current_stock::int, ',' ORDER BY id)
            FROM products WHERE id::text LIKE 'b0700000-%');
  PERFORM pg_temp.check(got = '1=13364,2=497,3=55,4=117,5=760,6=0', 'stock: ' || got);
  got := (SELECT string_agg(right(r.product_id::text, 1) || '=' || r.opening::int, ' ' ORDER BY r.product_id)
            FROM public.warehouse_products_report(f, '2026-10-31') r WHERE r.product_id::text LIKE 'b0700000-%');
  PERFORM pg_temp.check(got = '1=13364 2=497 3=55 4=117 5=760 6=0', '31 Oct opening: ' || got);

  got := (SELECT concat_ws('/', r.opening::int, r.qty_in::int, r.total::int, r.qty_out::int, r.returned::int,
                           r.gift::int, r.adjusted::int, r.balance::int)
            FROM public.warehouse_products_report(f, '2026-10-30') r
           WHERE r.product_id = 'b0700000-0000-0000-0000-0000000000a6');
  PERFORM pg_temp.check(got = '0/0/0/0/0/0/0/0', '1.5Ltr 30 Oct: ' || got);

  -- 31 Oct: Production releases 100 packs of 50cl; the Warehouse accepts them.
  INSERT INTO production_releases(factory_id, release_number, product_id, quantity, unit, status, released_by)
  VALUES (f, 'REL-FINAL-100', 'b0700000-0000-0000-0000-0000000000a2', 100, 'Pack', 'pending',
          'b0700000-0000-0000-0000-000000000002') RETURNING id INTO rel;
  PERFORM public.accept_production_release(rel, 100);
  UPDATE inventory_movements SET created_at = '2026-10-31 10:00+01' WHERE reference = 'REL-FINAL-100';
  got := (SELECT concat_ws('/', r.opening::int, r.qty_in::int, r.total::int, r.qty_out::int, r.balance::int)
            FROM public.warehouse_products_report(f, '2026-10-31') r
           WHERE r.product_id = 'b0700000-0000-0000-0000-0000000000a2');
  PERFORM pg_temp.check(got = '497/100/597/0/597', '31 Oct 50cl: ' || got);
  got := (SELECT concat_ws('/', r.qty_in::int, r.balance::int)
            FROM public.warehouse_products_report(f, '2026-10-30') r
           WHERE r.product_id = 'b0700000-0000-0000-0000-0000000000a2');
  PERFORM pg_temp.check(got = '695/497', '30 Oct unchanged: ' || got);
END $$;
