-- ============================================================================
-- Warehouse closing stock, 27 Oct 2026: Dispenser Water 14, Sachet Water 0
-- ----------------------------------------------------------------------------
-- The user's count (2026-10-28), added to the 27 Oct closing counts
-- (20261028090000, 20261028110000):
--   Dispenser Water   14 pieces  (now "Dispenser/Jug Water (Old Jug)",
--                                 20261028140000 -- either name is matched)
--   Sachet Water       0 bags
-- Same method: the difference is posted as an 'adjusted' ledger line dated
-- 27 Oct 23:59 (Lagos), and anything moved since stays on top. Already at
-- the count: left alone. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_close constant timestamptz := '2026-10-27 23:59:59+01';
  v_count record;
  v_product products%ROWTYPE;
  v_since numeric;
  v_at_close numeric;
  v_delta numeric;
  v_done jsonb := '[]'::jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  FOR v_count IN SELECT * FROM (VALUES
      ('dispenser', 14::numeric),
      ('Sachet Water', 0)) AS t(name, counted)
  LOOP
    SELECT * INTO v_product FROM products
     WHERE factory_id = v_factory AND product_type = 'finished'
       AND (lower(btrim(name)) = lower(v_count.name)
            OR (v_count.name = 'dispenser'
                AND lower(btrim(name)) IN ('dispenser water', 'dispenser/jug water (old jug)')))
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE NOTICE '% not found -- not changed', v_count.name;
      CONTINUE;
    END IF;

    -- What moved after the close (28 Oct onwards) stays on top of the count.
    SELECT COALESCE(SUM(quantity_after - quantity_before), 0) INTO v_since
      FROM inventory_movements
     WHERE product_id = v_product.id AND created_at > v_close;
    v_at_close := v_product.current_stock - v_since;
    v_delta := v_count.counted - v_at_close;
    IF v_delta = 0 THEN
      RAISE NOTICE '%: already % at the close of 27 Oct', v_product.name, v_count.counted;
      CONTINUE;
    END IF;
    IF v_product.current_stock + v_delta < 0 THEN
      RAISE EXCEPTION '%: the count would leave stock below zero after today''s movements -- nothing changed', v_product.name;
    END IF;

    UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_product.id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                    quantity_before, quantity_after, created_at)
    VALUES (v_factory, v_product.id, 'adjusted', v_delta, 'CLOSING-STOCK-2026-10-27',
            format('Closing stock count 27 Oct 2026: %s %s', v_count.counted, v_product.unit),
            auth.uid(), v_at_close, v_count.counted, v_close);

    v_done := v_done || jsonb_build_object('product', v_product.name, 'counted', v_count.counted,
                                           'system_at_close', v_at_close, 'adjusted_by', v_delta,
                                           'moved_since', v_since, 'stock_now', v_product.current_stock + v_delta);
    RAISE NOTICE '%: % at close (was %), % now', v_product.name, v_count.counted, v_at_close,
      v_product.current_stock + v_delta;
  END LOOP;

  IF jsonb_array_length(v_done) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'stock_count', 'products', 'CLOSING-STOCK-2026-10-27',
            jsonb_build_object('closing_date', '2026-10-27', 'products', v_done,
                               'reason', 'Warehouse closing stock count, Dispenser and Sachet Water (Water Factory)'));
  END IF;
END $$;
