-- ============================================================================
-- Warehouse closing stock, 27 Oct 2026: 1.5Ltr Bottle Water = 51 packs
-- ----------------------------------------------------------------------------
-- The 27 Oct closing count (20261028090000) included 1.5Ltr Bottle Water at
-- 51 packs, but the product didn't exist then, so it was skipped. It now
-- exists (20261028100000); the user asked for the record to be updated
-- (2026-10-28). Same method as the other counts: the difference is posted as
-- an 'adjusted' ledger line dated 27 Oct 23:59 (Lagos), and anything moved
-- since stays on top. Already at the count: left alone. Safe to run again.
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
      ('1.5Ltr Bottle Water', 51::numeric)) AS t(name, counted)
  LOOP
    SELECT * INTO v_product FROM products
     WHERE factory_id = v_factory AND product_type = 'finished'
       AND lower(btrim(name)) = lower(v_count.name)
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
                               'reason', 'Warehouse closing stock count, finished products (Water Factory)'));
  END IF;
END $$;
