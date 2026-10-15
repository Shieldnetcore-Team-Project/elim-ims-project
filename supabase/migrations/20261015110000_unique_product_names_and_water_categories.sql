-- ============================================================================
-- No duplicate products or categories; the Water Factory's three categories
-- ----------------------------------------------------------------------------
-- Product names now come from a fixed list in the app (35cl ... 1.5Ltr Bottle
-- Water, Dispenser Water, Jug + Water, Empty Jug, Sachet Water). Older records
-- were typed by hand ("35cl bottled water", "50cl Bottled Water"), so picking
-- the list name created a second record of the same product.
--
--   1. Rename the hand-typed products to the list spelling. A list-spelled
--      twin that has no stock and nothing recorded against it is removed
--      first (the hand-typed record keeps its stock and history).
--   2. Categories: "Bottled Water" -> "Bottle Water"; make sure Bottle Water,
--      Dispenser Water and Sachet Water exist in every factory.
--   3. One name per factory, ignoring case and surrounding spaces, for both
--      products and categories (unique indexes) -- so duplicates can't come
--      back.
-- Safe to re-run.
-- ============================================================================

-- ---- 1. products: list spelling, drop empty twins ----
DO $$
DECLARE
  m record;
  v_old uuid;
  v_new uuid;
BEGIN
  FOR m IN SELECT * FROM (VALUES
    ('35cl bottled water', '35cl Bottle Water'),
    ('50cl bottled water', '50cl Bottle Water'),
    ('75cl bottled water', '75cl Bottle Water'),
    ('1ltr bottled water', '1Ltr Bottle Water'),
    ('1.5ltr bottled water', '1.5Ltr Bottle Water'),
    ('satchet water', 'Sachet Water')
  ) AS t(old_name, new_name) LOOP
    FOR v_old IN SELECT id FROM products WHERE lower(btrim(name)) = m.old_name LOOP
      SELECT p.id INTO v_new FROM products p, products o
       WHERE o.id = v_old AND p.factory_id = o.factory_id AND p.id <> v_old
         AND lower(btrim(p.name)) = lower(m.new_name);
      IF v_new IS NOT NULL THEN
        -- Only an empty twin is removed; anything with stock or records needs
        -- a person to decide, so it is left and the rename skipped.
        IF COALESCE((SELECT current_stock FROM products WHERE id = v_new), 0) = 0
           AND NOT EXISTS (SELECT 1 FROM production WHERE product_id = v_new)
           AND NOT EXISTS (SELECT 1 FROM production_releases WHERE product_id = v_new)
           AND NOT EXISTS (SELECT 1 FROM sale_items WHERE product_id = v_new)
           AND NOT EXISTS (SELECT 1 FROM inventory_movements WHERE product_id = v_new)
           AND NOT EXISTS (SELECT 1 FROM stock_dispatch_items WHERE product_id = v_new)
           AND NOT EXISTS (SELECT 1 FROM production_requests WHERE product_id = v_new) THEN
          DELETE FROM products WHERE id = v_new;
        ELSE
          RAISE NOTICE 'Kept both "%" and "%": the second one has stock or records', m.old_name, m.new_name;
          CONTINUE;
        END IF;
      END IF;
      UPDATE products SET name = m.new_name, updated_at = now() WHERE id = v_old;
    END LOOP;
  END LOOP;
END $$;

-- ---- 2. categories ----
UPDATE product_categories c SET name = 'Bottle Water'
 WHERE lower(btrim(c.name)) = 'bottled water'
   AND NOT EXISTS (SELECT 1 FROM product_categories x
                    WHERE x.factory_id = c.factory_id AND lower(btrim(x.name)) = 'bottle water');

INSERT INTO product_categories (factory_id, name, description)
SELECT f.id, v.name, v.description
  FROM factories f
 CROSS JOIN (VALUES
   ('Bottle Water', 'PET bottled water, all sizes'),
   ('Dispenser Water', 'Dispenser water, jugs with water and empty jugs'),
   ('Sachet Water', 'Pure water sachets')
 ) AS v(name, description)
 WHERE NOT EXISTS (SELECT 1 FROM product_categories c
                    WHERE c.factory_id = f.id AND lower(btrim(c.name)) = lower(v.name));

-- ---- 3. one name per factory ----
CREATE UNIQUE INDEX IF NOT EXISTS products_factory_name_unique
  ON public.products (factory_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS product_categories_factory_name_unique
  ON public.product_categories (factory_id, lower(btrim(name)));
