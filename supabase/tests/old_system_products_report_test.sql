-- ============================================================================
-- Acceptance tests: the old system's 30 Oct Products Report kept as is
-- (20261030150000_old_system_products_report.sql, with the balance brought
-- forward of 20261030120000)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. On products named as in production:
--   * 30 Oct shows the old system's rows exactly; 1.5Ltr (not on the old
--     report) is worked out as usual;
--   * 31 Oct opens at the old balances.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('b0400000-0000-0000-0000-000000000001', 'wh@osr');
DELETE FROM user_roles WHERE user_id = 'b0400000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('b0400000-0000-0000-0000-000000000001', 'super_admin');
UPDATE products SET active = false, name = name || ' (old ' || left(id::text, 8) || ')' WHERE product_type = 'finished';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT x.id::uuid, f.id, x.name, x.unit, 'finished', true, x.stock, 1000
  FROM factories f, (VALUES ('b0400000-0000-0000-0000-0000000000a1','75cl Bottle Water','Pack',14000),
                            ('b0400000-0000-0000-0000-0000000000a2','50cl Bottle Water','Pack',91),
                            ('b0400000-0000-0000-0000-0000000000a3','Sachet Water','Bag',0),
                            ('b0400000-0000-0000-0000-0000000000a4','Dispenser/Jug Water (Old Jug)','Piece',14),
                            ('b0400000-0000-0000-0000-0000000000a5','35cl Bottle Water','Pack',998),
                            ('b0400000-0000-0000-0000-0000000000a6','1.5Ltr Bottle Water','Pack',517)) AS x(id,name,unit,stock)
 WHERE f.code = 'water';
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
      ('50cl Bottle Water', '^50 ?cl bottle',                            302,  613,  500,   415),
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
    ON CONFLICT (product_id, report_date) DO UPDATE
      SET opening = EXCLUDED.opening, qty_in = EXCLUDED.qty_in, qty_out = EXCLUDED.qty_out,
          returned = EXCLUDED.returned, gift = EXCLUDED.gift, balance = EXCLUDED.balance,
          source = EXCLUDED.source;
    RAISE NOTICE '%: old-system row stored (balance %)', v_row.label, v_row.balance;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: 30 Oct is the old system's report exactly; 31 Oct opens at its balances
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); got text;
BEGIN
  PERFORM set_config('test.uid', 'b0400000-0000-0000-0000-000000000001', false);
  got := (SELECT string_agg(concat_ws('/', right(r.product_id::text, 1), r.opening::int, r.qty_in::int, r.total::int,
                                      r.qty_out::int, r.returned::int, r.gift::int, r.adjusted::int, r.balance::int), ' '
                            ORDER BY r.product_id)
            FROM public.warehouse_products_report(f, '2026-10-30') r WHERE r.product_id::text LIKE 'b0400000-%');
  PERFORM pg_temp.check(got = '1/13661/819/14480/1116/0/0/0/13364 2/302/613/915/500/0/0/0/415 '
                           || '3/126/2566/2692/2147/0/0/0/545 4/152/300/452/359/0/0/0/93 '
                           || '5/960/0/960/200/0/0/0/760 6/517/0/517/0/0/0/0/517',
                        '30 Oct: ' || got);
  got := (SELECT string_agg(right(r.product_id::text, 1) || '=' || r.opening::int, ' ' ORDER BY r.product_id)
            FROM public.warehouse_products_report(f, '2026-10-31') r WHERE r.product_id::text LIKE 'b0400000-%');
  PERFORM pg_temp.check(got = '1=13364 2=415 3=545 4=93 5=760 6=517', '31 Oct opening: ' || got);
END $$;
