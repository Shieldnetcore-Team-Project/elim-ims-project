-- ============================================================================
-- Acceptance tests: Warehouse balance brought forward from the old system
-- (20261030120000_warehouse_stock_20261030.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration's block is run again on
-- products named as in production:
--   * 75cl was already set by the first version (an 'adjusted' line): it is
--     relabelled as the B/F, stock unchanged, nothing posted twice;
--   * the others are set to the report's Balance by an 'opening_balance' line;
--   * a second run changes nothing; a release accepted from Production then
--     adds to the B/F.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b0300000-0000-0000-0000-000000000001', 'wh@bf'),
  ('b0300000-0000-0000-0000-000000000002', 'pm@bf');
DELETE FROM user_roles WHERE user_id IN ('b0300000-0000-0000-0000-000000000001', 'b0300000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('b0300000-0000-0000-0000-000000000001', 'super_admin');
UPDATE products SET active = false, name = name || ' (old ' || left(id::text, 8) || ')' WHERE product_type = 'finished';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT x.id::uuid, f.id, x.name, x.unit, 'finished', true, x.stock, 1000
  FROM factories f, (VALUES ('b0300000-0000-0000-0000-0000000000a1','75cl Bottle Water','Pack',13364),
                            ('b0300000-0000-0000-0000-0000000000a2','50cl Bottle Water','Pack',91),
                            ('b0300000-0000-0000-0000-0000000000a3','Sachet Water','Bag',0),
                            ('b0300000-0000-0000-0000-0000000000a4','Dispenser/Jug Water (Old Jug)','Piece',14),
                            ('b0300000-0000-0000-0000-0000000000a5','35cl Bottle Water','Pack',998),
                            ('b0300000-0000-0000-0000-0000000000a6','1.5Ltr Bottle Water','Pack',517)) AS x(id,name,unit,stock)
 WHERE f.code = 'water';
-- The first version already set 75cl (14,000 -> 13,364) as a correction.
INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
SELECT f.id, 'b0300000-0000-0000-0000-0000000000a1', 'adjusted', -636, 'WAREHOUSE-STOCK-2026-10-30', 'old', NULL, 14000, 13364
  FROM factories f WHERE f.code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: B/F set and labelled; earlier correction relabelled; re-run is a no-op; a release adds on top
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
      ('50cl Bottle Water', '^50 ?cl bottle',                              415),
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

    v_before := (SELECT current_stock FROM products WHERE id = v_pid);
    v_delta := v_count.counted - v_before;
    IF v_delta = 0 THEN
      RAISE NOTICE '%: already % B/F%', v_name, v_count.counted,
        CASE WHEN v_relabelled > 0 THEN ' (earlier line relabelled as balance brought forward)' ELSE '' END;
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
      ('50cl Bottle Water', '^50 ?cl bottle',                              415),
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

    v_before := (SELECT current_stock FROM products WHERE id = v_pid);
    v_delta := v_count.counted - v_before;
    IF v_delta = 0 THEN
      RAISE NOTICE '%: already % B/F%', v_name, v_count.counted,
        CASE WHEN v_relabelled > 0 THEN ' (earlier line relabelled as balance brought forward)' ELSE '' END;
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
DECLARE r text; rel uuid; f uuid := (SELECT id FROM factories WHERE code = 'water');
BEGIN
  r := (SELECT string_agg(right(id::text, 1) || '=' || current_stock::int, ',' ORDER BY id) FROM products WHERE id::text LIKE 'b0300000-%');
  PERFORM pg_temp.check(r = '1=13364,2=415,3=545,4=93,5=760,6=517', 'stock ' || r);
  PERFORM pg_temp.check((SELECT count(*) FROM inventory_movements WHERE product_id::text LIKE 'b0300000-%') = 5
                        AND (SELECT count(*) FROM inventory_movements WHERE product_id::text LIKE 'b0300000-%'
                               AND movement_type = 'opening_balance' AND reference = 'BALANCE-BF-2026-10-30'
                               AND reason LIKE 'Balance brought forward from the old system%') = 5,
                        'five B/F lines, none twice, none left as a correction');
  PERFORM pg_temp.check((SELECT quantity FROM inventory_movements WHERE product_id = 'b0300000-0000-0000-0000-0000000000a1') = -636,
                        '75cl relabelled, not reposted');

  -- Production releases 40 packs of 75cl; the Warehouse accepts them: they add to the B/F.
  INSERT INTO production_releases(factory_id, release_number, product_id, quantity, unit, status, released_by)
  VALUES (f, 'REL-BF-1', 'b0300000-0000-0000-0000-0000000000a1', 40, 'Pack', 'pending', 'b0300000-0000-0000-0000-000000000002')
  RETURNING id INTO rel;
  PERFORM set_config('test.uid', 'b0300000-0000-0000-0000-000000000001', false);
  PERFORM public.accept_production_release(rel, 40);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b0300000-0000-0000-0000-0000000000a1') = 13404,
                        'release adds to the B/F: ' || (SELECT current_stock FROM products WHERE id = 'b0300000-0000-0000-0000-0000000000a1'));
END $$;
