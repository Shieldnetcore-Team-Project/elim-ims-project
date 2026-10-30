-- ============================================================================
-- Warehouse balance brought forward from the old system, 30 Oct 2026
-- ----------------------------------------------------------------------------
-- The factory is moving from its old system to this one. The old system's
-- "All Products Reports" for 2026-10-30, Balance column, is the Warehouse's
-- opening stock here -- its balance brought forward (B/F). Everything after
-- it adds or takes as normal (a release accepted from Production adds to it):
--   75cl Bottle Water     13,364 packs
--   50cl Bottle Water        415 packs
--   Sachet Water             545 bags
--   Dispenser Water           93 pieces  ("Dispenser/Jug Water (Old Jug)",
--                                         20261028140000 -- either name)
--   35cl Bottle Water        760 packs
-- (1Ltr and 1.5Ltr are not on the report: left as they are.)
--
-- For each product, current stock becomes the figure; the difference is one
-- 'opening_balance' ledger line, reference BALANCE-BF-2026-10-30, "Balance
-- brought forward from the old system". An earlier run of this migration
-- that posted it as an 'adjusted' line (WAREHOUSE-STOCK-2026-10-30) is
-- relabelled, not posted again. A product not found, matched twice, or
-- already at the figure is left alone with a notice; one audit row lists
-- every change. Safe to run again.
-- Values are read with := (no select-into): the Supabase SQL Editor mistakes
-- that form for creating a table and breaks the script.
-- ============================================================================

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
