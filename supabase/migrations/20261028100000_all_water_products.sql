-- ============================================================================
-- Every Water Factory product exists, so Finished Products lists them all
-- ----------------------------------------------------------------------------
-- The user wants Warehouse → Finished Products — Water Factory to show every
-- product on the factory's list with its stock (2026-10-28):
--   35cl, 50cl, 75cl, 1Ltr, 1.5Ltr Bottle Water   (Pack)
--   Dispenser Water, Jug + Water, Empty Jug       (Piece)
--   Sachet Water                                  (Bag)
-- (FINISHED_PRODUCT_NAMES, src/components/shared/product-name-select.tsx.)
--
-- A product on the list that doesn't exist yet is created as a finished
-- product with 0 stock, in its category (Bottle / Dispenser / Sachet Water),
-- at the standard selling price where there is one. One that exists but was
-- deactivated is made active again. Nothing else is touched: existing
-- products keep their stock, unit and price. Names are matched ignoring case
-- and spaces (one name per factory, products_factory_name_unique). An audit
-- row lists what was added or reactivated. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_p record;
  v_id uuid;
  v_cat uuid;
  v_added jsonb := '[]'::jsonb;
  v_reactivated jsonb := '[]'::jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  FOR v_p IN SELECT * FROM (VALUES
      ('35cl Bottle Water',   'Pack',  'Bottle Water',    2550::numeric),
      ('50cl Bottle Water',   'Pack',  'Bottle Water',    2650),
      ('75cl Bottle Water',   'Pack',  'Bottle Water',    1700),
      ('1Ltr Bottle Water',   'Pack',  'Bottle Water',    0),
      ('1.5Ltr Bottle Water', 'Pack',  'Bottle Water',    1700),
      ('Dispenser Water',     'Piece', 'Dispenser Water', 0),
      ('Jug + Water',         'Piece', 'Dispenser Water', 0),
      ('Empty Jug',           'Piece', 'Dispenser Water', 0),
      ('Sachet Water',        'Bag',   'Sachet Water',    0)) AS t(name, unit, category, price)
  LOOP
    SELECT id INTO v_id FROM products
     WHERE factory_id = v_factory AND lower(btrim(name)) = lower(v_p.name);
    IF FOUND THEN
      UPDATE products SET active = true, updated_at = now() WHERE id = v_id AND NOT active;
      IF FOUND THEN v_reactivated := v_reactivated || to_jsonb(v_p.name); END IF;
      CONTINUE;
    END IF;

    SELECT id INTO v_cat FROM product_categories
     WHERE factory_id = v_factory AND lower(btrim(name)) = lower(v_p.category);
    INSERT INTO products (factory_id, name, unit, unit_price, cost_price, current_stock, product_type, category_id, active)
    VALUES (v_factory, v_p.name, v_p.unit, v_p.price, 0, 0, 'finished', v_cat, true);
    v_added := v_added || to_jsonb(v_p.name);
  END LOOP;

  IF jsonb_array_length(v_added) + jsonb_array_length(v_reactivated) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'create', 'products', 'water-product-list',
            jsonb_build_object('added', v_added, 'reactivated', v_reactivated,
                               'reason', 'Every Water Factory product listed on Finished Products (2026-10-28)'));
  END IF;
  RAISE NOTICE 'Added: %; reactivated: %', v_added, v_reactivated;
END $$;
