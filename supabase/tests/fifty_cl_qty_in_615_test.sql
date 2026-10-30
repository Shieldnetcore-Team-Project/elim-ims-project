-- ============================================================================
-- Acceptance tests: 50cl Qty In 615 correction (20261030170000_50cl_qty_in_615.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Starts where production is: 50cl stored
-- as the old system's 613 / 415 and brought forward at 415, then 80 packs
-- released and accepted. The correction makes it 615 / 417: stock 497, and
-- the 30 Oct row Qty In 695, Total 997, Balance 497. Running it again
-- changes nothing.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b0600000-0000-0000-0000-000000000001', 'wh@q615'),
  ('b0600000-0000-0000-0000-000000000002', 'pm@q615');
DELETE FROM user_roles WHERE user_id IN ('b0600000-0000-0000-0000-000000000001', 'b0600000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('b0600000-0000-0000-0000-000000000001', 'super_admin');
UPDATE products SET active = false, name = name || ' (old ' || left(id::text, 8) || ')' WHERE product_type = 'finished';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT x.id::uuid, f.id, x.name, x.unit, 'finished', true, x.stock, 1000
  FROM factories f, (VALUES ('b0600000-0000-0000-0000-0000000000a1','75cl Bottle Water','Pack',14000),
                            ('b0600000-0000-0000-0000-0000000000a2','50cl Bottle Water','Pack',91),
                            ('b0600000-0000-0000-0000-0000000000a3','Sachet Water','Bag',0),
                            ('b0600000-0000-0000-0000-0000000000a4','Dispenser/Jug Water (Old Jug)','Piece',14),
                            ('b0600000-0000-0000-0000-0000000000a5','35cl Bottle Water','Pack',998)) AS x(id,name,unit,stock)
 WHERE f.code = 'water';
INSERT INTO production_releases(factory_id, release_number, product_id, quantity, unit, status, released_by)
SELECT id, 'REL-Q615-80', 'b0600000-0000-0000-0000-0000000000a2', 80, 'Pack', 'pending',
       'b0600000-0000-0000-0000-000000000002' FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: from 613 / 415 + an 80-pack release to 615 / 417: stock 497, row 302/695/997/500/497
DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_count record;
  v_n int;
  v_pid uuid;
  v_name text;
  v_unit text;
  v_before numeric;
  v_delta numeric;
  v_relabelled int;
  v_done jsonb := '[]'::jsonb;
BEGIN
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  FOR v_count IN SELECT * FROM (VALUES
      ('75cl Bottle Water', '^75 ?cl bottle',                            13364::numeric),
      ('50cl Bottle Water', '^50 ?cl bottle',                              417),
      ('Sachet Water',      '^(sachet|satchet) water',                     545),
      ('Dispenser Water',   '^dispenser( water$|/jug water \(old jug\))',   93),
      ('35cl Bottle Water', '^35 ?cl bottle',                              760)) AS t(label, pattern, counted)
  LOOP
    v_n := (SELECT count(*) FROM products
             WHERE factory_id = v_factory AND product_type = 'finished' AND active
               AND btrim(name) ~* v_count.pattern);
    IF v_n <> 1 THEN
      RAISE NOTICE '%: % matching products -- not changed', v_count.label, v_n;
      CONTINUE;
    END IF;
    v_pid := (SELECT id FROM products
               WHERE factory_id = v_factory AND product_type = 'finished' AND active
                 AND btrim(name) ~* v_count.pattern);
    PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
    v_name := (SELECT name FROM products WHERE id = v_pid);
    v_unit := (SELECT unit FROM products WHERE id = v_pid);

    -- An earlier run posted it as a correction: make that line the B/F.
    UPDATE inventory_movements
       SET movement_type = 'opening_balance', reference = 'BALANCE-BF-2026-10-30',
           reason = format('Balance brought forward from the old system (30 Oct 2026 report): %s %s',
                           v_count.counted, v_unit)
     WHERE product_id = v_pid AND reference = 'WAREHOUSE-STOCK-2026-10-30';
    GET DIAGNOSTICS v_relabelled = ROW_COUNT;

    -- Brought forward once. After that, releases, postings and sales move
    -- the stock: running this again must not reset it to the old figure.
    IF EXISTS (SELECT 1 FROM inventory_movements
                WHERE product_id = v_pid AND reference = 'BALANCE-BF-2026-10-30') THEN
      RAISE NOTICE '%: balance already brought forward -- stock left as it is%', v_name,
        CASE WHEN v_relabelled > 0 THEN ' (earlier line relabelled as balance brought forward)' ELSE '' END;
      CONTINUE;
    END IF;

    v_before := (SELECT current_stock FROM products WHERE id = v_pid);
    v_delta := v_count.counted - v_before;
    IF v_delta = 0 THEN
      -- Already at the figure: still mark when it was brought forward.
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after)
      VALUES (v_factory, v_pid, 'opening_balance', 0, 'BALANCE-BF-2026-10-30',
              format('Balance brought forward from the old system (30 Oct 2026 report): %s %s',
                     v_count.counted, v_unit),
              auth.uid(), v_before, v_before);
      RAISE NOTICE '%: already % B/F', v_name, v_count.counted;
      CONTINUE;
    END IF;

    UPDATE products SET current_stock = v_count.counted, updated_at = now() WHERE id = v_pid;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                    quantity_before, quantity_after)
    VALUES (v_factory, v_pid, 'opening_balance', v_delta, 'BALANCE-BF-2026-10-30',
            format('Balance brought forward from the old system (30 Oct 2026 report): %s %s',
                   v_count.counted, v_unit),
            auth.uid(), v_before, v_count.counted);

    v_done := v_done || jsonb_build_object('product', v_name, 'balance_bf', v_count.counted,
                                           'was', v_before, 'adjusted_by', v_delta);
    RAISE NOTICE '%: B/F % (was %)', v_name, v_count.counted, v_before;
  END LOOP;

  IF jsonb_array_length(v_done) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'stock_count', 'products', 'BALANCE-BF-2026-10-30',
            jsonb_build_object('date', '2026-10-30', 'products', v_done,
                               'reason', 'Warehouse balance brought forward from the old system (30 Oct report, Balance column)'));
  END IF;
END $$;
DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_row record;
  v_n int;
  v_pid uuid;
BEGIN
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;
  FOR v_row IN SELECT * FROM (VALUES
      ('75cl Bottle Water', '^75 ?cl bottle',                          13661::numeric, 819::numeric, 1116::numeric, 13364::numeric),
      ('50cl Bottle Water', '^50 ?cl bottle',                            302,  615,  500,   417),
      ('Sachet Water',      '^(sachet|satchet) water',                   126, 2566, 2147,   545),
      ('Dispenser Water',   '^dispenser( water$|/jug water \(old jug\))', 152,  300,  359,    93),
      ('35cl Bottle Water', '^35 ?cl bottle',                            960,    0,  200,   760)
    ) AS t(label, pattern, opening, qty_in, qty_out, balance)
  LOOP
    v_n := (SELECT count(*) FROM products
             WHERE factory_id = v_factory AND product_type = 'finished' AND active
               AND btrim(name) ~* v_row.pattern);
    IF v_n <> 1 THEN
      RAISE NOTICE '%: % matching products -- not stored', v_row.label, v_n;
      CONTINUE;
    END IF;
    v_pid := (SELECT id FROM products
               WHERE factory_id = v_factory AND product_type = 'finished' AND active
                 AND btrim(name) ~* v_row.pattern);
    INSERT INTO warehouse_report_snapshots(factory_id, report_date, product_id, opening, qty_in, qty_out,
                                           returned, gift, balance, source)
    VALUES (v_factory, '2026-10-30', v_pid, v_row.opening, v_row.qty_in, v_row.qty_out, 0, 0, v_row.balance,
            'Old system: All Products Reports, 30 Oct 2026')
    -- Stored once: a later correction (e.g. 20261030170000) is never undone
    -- by running this again.
    ON CONFLICT (product_id, report_date) DO NOTHING;
    RAISE NOTICE '%: old-system row stored (balance %)', v_row.label, v_row.balance;
  END LOOP;
END $$;
DO $$
BEGIN
  -- Production's state: stored and brought forward as 613 / 415.
  UPDATE warehouse_report_snapshots SET qty_in = 613, balance = 415
   WHERE product_id = 'b0600000-0000-0000-0000-0000000000a2';
  UPDATE products SET current_stock = 415 WHERE id = 'b0600000-0000-0000-0000-0000000000a2';
  UPDATE inventory_movements SET quantity = quantity - 2, quantity_after = 415
   WHERE product_id = 'b0600000-0000-0000-0000-0000000000a2' AND reference = 'BALANCE-BF-2026-10-30';
  PERFORM set_config('test.uid', 'b0600000-0000-0000-0000-000000000001', false);
  PERFORM public.accept_production_release((SELECT id FROM production_releases WHERE release_number = 'REL-Q615-80'), 80);
  -- (one transaction here: give the release its own, later time)
  UPDATE inventory_movements SET created_at = now() + interval '1 second' WHERE reference = 'REL-Q615-80';
END $$;
DO $$
DECLARE
  v_pid uuid;
  v_factory uuid;
  v_at timestamptz;
  v_before numeric;
BEGIN
  v_pid := (SELECT s.product_id FROM warehouse_report_snapshots s
              JOIN products p ON p.id = s.product_id
             WHERE s.report_date = '2026-10-30' AND btrim(p.name) ~* '^50 ?cl bottle'
               AND s.qty_in = 613 AND s.balance = 415
             LIMIT 1);
  IF v_pid IS NULL THEN
    RAISE NOTICE '50cl: already Qty In 615 / Balance 417 -- nothing changed';
    RETURN;
  END IF;
  v_factory := (SELECT factory_id FROM products WHERE id = v_pid);

  UPDATE warehouse_report_snapshots SET qty_in = 615, balance = 417
   WHERE product_id = v_pid AND report_date = '2026-10-30';

  -- At the balance brought forward's time, so it stays part of the B/F.
  v_at := public._report_snapshot_cutoff(v_pid, '2026-10-30');
  PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
  v_before := (SELECT current_stock FROM products WHERE id = v_pid);
  UPDATE products SET current_stock = current_stock + 2, updated_at = now() WHERE id = v_pid;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after, created_at)
  VALUES (v_factory, v_pid, 'opening_balance', 2, 'BALANCE-BF-2026-10-30',
          'Balance brought forward from the old system: 50cl Qty In 615, not 613 (+2)',
          auth.uid(), v_before, v_before + 2, COALESCE(v_at, now()));

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'stock_count', 'products', 'BALANCE-BF-2026-10-30',
          jsonb_build_object('product', '50cl Bottle Water', 'qty_in', 613, 'balance', 415),
          jsonb_build_object('product', '50cl Bottle Water', 'qty_in', 615, 'balance', 417,
                             'stock_now', v_before + 2, 'reason', 'Old system 30 Oct Qty In was 615'));
  RAISE NOTICE '50cl: Qty In 615, Balance 417 brought forward -- stock % -> %', v_before, v_before + 2;
END $$;
DO $$
DECLARE
  v_pid uuid;
  v_factory uuid;
  v_at timestamptz;
  v_before numeric;
BEGIN
  v_pid := (SELECT s.product_id FROM warehouse_report_snapshots s
              JOIN products p ON p.id = s.product_id
             WHERE s.report_date = '2026-10-30' AND btrim(p.name) ~* '^50 ?cl bottle'
               AND s.qty_in = 613 AND s.balance = 415
             LIMIT 1);
  IF v_pid IS NULL THEN
    RAISE NOTICE '50cl: already Qty In 615 / Balance 417 -- nothing changed';
    RETURN;
  END IF;
  v_factory := (SELECT factory_id FROM products WHERE id = v_pid);

  UPDATE warehouse_report_snapshots SET qty_in = 615, balance = 417
   WHERE product_id = v_pid AND report_date = '2026-10-30';

  -- At the balance brought forward's time, so it stays part of the B/F.
  v_at := public._report_snapshot_cutoff(v_pid, '2026-10-30');
  PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
  v_before := (SELECT current_stock FROM products WHERE id = v_pid);
  UPDATE products SET current_stock = current_stock + 2, updated_at = now() WHERE id = v_pid;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after, created_at)
  VALUES (v_factory, v_pid, 'opening_balance', 2, 'BALANCE-BF-2026-10-30',
          'Balance brought forward from the old system: 50cl Qty In 615, not 613 (+2)',
          auth.uid(), v_before, v_before + 2, COALESCE(v_at, now()));

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'stock_count', 'products', 'BALANCE-BF-2026-10-30',
          jsonb_build_object('product', '50cl Bottle Water', 'qty_in', 613, 'balance', 415),
          jsonb_build_object('product', '50cl Bottle Water', 'qty_in', 615, 'balance', 417,
                             'stock_now', v_before + 2, 'reason', 'Old system 30 Oct Qty In was 615'));
  RAISE NOTICE '50cl: Qty In 615, Balance 417 brought forward -- stock % -> %', v_before, v_before + 2;
END $$;
DO $$
DECLARE got text;
BEGIN
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b0600000-0000-0000-0000-0000000000a2') = 497,
                        'stock: ' || (SELECT current_stock FROM products WHERE id = 'b0600000-0000-0000-0000-0000000000a2'));
  got := (SELECT concat_ws('/', r.opening::int, r.qty_in::int, r.total::int, r.qty_out::int, r.returned::int,
                           r.gift::int, r.adjusted::int, r.balance::int)
            FROM public.warehouse_products_report((SELECT id FROM factories WHERE code = 'water'), '2026-10-30') r
           WHERE r.product_id = 'b0600000-0000-0000-0000-0000000000a2');
  PERFORM pg_temp.check(got = '302/695/997/500/0/0/0/497', '50cl row: ' || got);
  PERFORM pg_temp.check((SELECT count(*) FROM inventory_movements
                          WHERE product_id = 'b0600000-0000-0000-0000-0000000000a2' AND reason LIKE '%Qty In 615%') = 1,
                        'corrected once');
  got := (SELECT r.opening::int::text FROM public.warehouse_products_report((SELECT id FROM factories WHERE code = 'water'), '2026-10-31') r
           WHERE r.product_id = 'b0600000-0000-0000-0000-0000000000a2');
  PERFORM pg_temp.check(got = '497', '31 Oct opening: ' || got);
END $$;
