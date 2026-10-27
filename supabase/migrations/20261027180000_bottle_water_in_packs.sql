-- ============================================================================
-- Bottle Water products are counted in packs
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-27): the finished Bottle Water products
-- (35cl, 50cl, 75cl, 1Ltr, 1.5Ltr ...) are posted and stocked in packs, not
-- pieces. Their unit becomes 'Pack', so Production's Finished product
-- dropdown, the production hall and the Warehouse all show packs.
--
-- Only the unit label changes: stock numbers are left as they are (selling
-- prices were already per pack). Finished products only -- the empty blown
-- bottles QC stocks ("50cl Bottle", semi_finished) stay in pieces. Batches
-- already recorded keep the unit they were recorded with. Safe to run again.
-- ============================================================================

DO $$
DECLARE v_rows jsonb;
BEGIN
  WITH changed AS (
    UPDATE products p SET unit = 'Pack', updated_at = now()
      FROM products o
      LEFT JOIN product_categories c ON c.id = o.category_id
     WHERE p.id = o.id
       AND o.product_type = 'finished'
       AND (lower(btrim(o.name)) LIKE '%bottle water' OR lower(btrim(c.name)) = 'bottle water')
       AND lower(btrim(o.unit)) <> 'pack'
    RETURNING p.id, p.factory_id, p.name, o.unit AS old_unit
  )
  SELECT jsonb_agg(jsonb_build_object('product', name, 'from', old_unit)) INTO v_rows FROM changed;

  IF v_rows IS NULL THEN
    RAISE NOTICE 'Bottle Water products already in packs';
    RETURN;
  END IF;
  INSERT INTO audit_logs(user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'update', 'products', 'bottle-water-unit',
          jsonb_build_object('unit', 'Pack', 'products', v_rows,
                             'reason', 'Bottle Water posted in packs (factory decision 2026-10-27)'));
  RAISE NOTICE 'Now in packs: %', v_rows;
END $$;
