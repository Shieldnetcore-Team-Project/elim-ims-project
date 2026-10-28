-- ============================================================================
-- Warehouse closing stock, 27 Oct 2026 (Water Factory, finished products)
-- ----------------------------------------------------------------------------
-- The user's count (2026-10-28), in packs:
--   50cl Bottle Water       2
--   75cl Bottle Water  13,824
--   35cl Bottle Water   1,202
--   1.5Ltr Bottle Water    51   ("1.5cl" on the count sheet)
--
-- Recorded as a stock count at the close of 27 Oct: for each product the
-- difference between the count and what the system held at that moment is
-- posted as an 'adjusted' ledger line dated 27 Oct 23:59 (Lagos), so the
-- day's closing stock -- and the next day's opening -- is the count.
-- Anything already moved on 28 Oct is kept on top of it: current stock =
-- count + today's movements. A product not found, or already at the count,
-- is left alone with a notice. An audit row lists every change. Safe to run
-- again (the second run finds each product already at its count).
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
      ('50cl Bottle Water', 2::numeric),
      ('75cl Bottle Water', 13824),
      ('35cl Bottle Water', 1202),
      ('1.5Ltr Bottle Water', 51)) AS t(name, counted)
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
