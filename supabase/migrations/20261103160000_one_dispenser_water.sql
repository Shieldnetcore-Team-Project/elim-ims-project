-- ============================================================================
-- One filled dispenser product: "Dispenser Water"; the jug is charged at sale
-- ----------------------------------------------------------------------------
-- User (2026-11-03): the Warehouse posts Dispenser Water; the shop sells it
-- either as water only (the customer hands an empty in) or as water + jug
-- (the customer has no empty and keeps the jug). Two products for the same
-- filled dispenser ("Dispenser Water" and "Dispenser Jug+Water") made the
-- postings and the shop's stock confusing. Decisions:
--   * "Dispenser Jug+Water" is retired everywhere (Warehouse, shop,
--     marketers): only Dispenser Water is posted;
--   * existing Jug+Water stock is the same filled dispensers: it joins the
--     Dispenser Water stock wherever it is (one stock correction each);
--   * the jug alone = Jug+Water price - Dispenser Water price (N4,200 -
--     N1,200 = N3,000), water + jug = the Jug+Water price -- read from the
--     two products, never typed in.
-- At the sale (create_sale, 20261031160000) a Dispenser Water line says what
-- happens to the jug: swap (water only, empty in), permanent (water + jug,
-- the jug's price kept apart as jug revenue), or return later.
--
-- merge_dispenser_jug_water(): the switch-over, per factory, once (a second
-- run finds nothing left to move). Admin / chairman only when called by a
-- user; this migration runs it once. Needs the jug tables (container
-- tracking, 20260928140000, and jar prices, 20261031160000): without them it
-- only reports what is missing.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.merge_dispenser_jug_water()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_water products%ROWTYPE;
  v_combo products%ROWTYPE;
  v_type uuid;
  v_jar numeric;
  v_with numeric;
  v_hold record;
  v_before numeric;
  v_ref text := 'MERGE-JUG+WATER-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD');
  v_done jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NOT NULL AND NOT public._is_product_admin(v_uid) THEN
    RAISE EXCEPTION 'Only an administrator can merge products';
  END IF;
  IF to_regclass('public.product_containers') IS NULL OR to_regclass('public.container_types') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'container_types' AND column_name = 'jar_price') THEN
    RETURN jsonb_build_object('skipped', 'The jug tables are missing: run the container tracking and jar price migrations first');
  END IF;

  FOR v_combo IN
    SELECT * FROM products
     WHERE regexp_replace(lower(name), '\s', '', 'g') IN ('dispenserjug+water', 'dispenserwater+jug', 'jug+water')
     ORDER BY created_at
  LOOP
    SELECT * INTO v_water FROM products
     WHERE factory_id = v_combo.factory_id AND lower(btrim(name)) = 'dispenser water' AND id <> v_combo.id
     ORDER BY active DESC, created_at LIMIT 1;
    IF NOT FOUND THEN CONTINUE; END IF;
    v_with := v_combo.unit_price;
    v_jar := v_combo.unit_price - v_water.unit_price;
    IF v_jar <= 0 THEN
      v_done := v_done || jsonb_build_object('factory_id', v_combo.factory_id,
        'skipped', 'Jug+Water is not dearer than Dispenser Water; set the prices first');
      CONTINUE;
    END IF;

    -- The jug type Dispenser Water carries: its own, else Jug+Water's, else
    -- the factory's dispenser jug, else a new one.
    SELECT pc.container_type_id INTO v_type FROM product_containers pc
      JOIN container_types ct ON ct.id = pc.container_type_id
     WHERE pc.product_id IN (v_water.id, v_combo.id) AND ct.name ~* 'jug'
     ORDER BY (pc.product_id = v_water.id) DESC LIMIT 1;
    IF v_type IS NULL THEN
      SELECT id INTO v_type FROM container_types
       WHERE factory_id = v_combo.factory_id AND name ~* 'jug' AND active ORDER BY name LIMIT 1;
    END IF;
    IF v_type IS NULL THEN
      INSERT INTO container_types(factory_id, name, active) VALUES (v_combo.factory_id, 'Dispenser Jug', true)
      RETURNING id INTO v_type;
    END IF;
    UPDATE container_types SET jar_price = v_jar, with_jar_price = v_with WHERE id = v_type;
    INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role)
    VALUES (v_water.id, v_type, 1, 'with_water')
    ON CONFLICT (product_id, container_type_id) DO UPDATE SET quantity_per_unit = 1, jug_role = 'with_water';

    -- Warehouse stock: Jug+Water joins Dispenser Water.
    SELECT current_stock INTO v_before FROM products WHERE id = v_combo.id FOR UPDATE;
    IF v_before <> 0 THEN
      UPDATE products SET current_stock = 0, updated_at = now() WHERE id = v_combo.id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after)
      VALUES (v_combo.factory_id, v_combo.id, 'correction', -v_before, v_ref,
              'Merged into ' || v_water.name || ' (one filled dispenser product)', v_uid, v_before, 0);
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after)
      SELECT v_combo.factory_id, v_water.id, 'correction', v_before, v_ref,
             'From ' || v_combo.name || ' (one filled dispenser product)', v_uid, p.current_stock, p.current_stock + v_before
        FROM products p WHERE p.id = v_water.id;
      UPDATE products SET current_stock = current_stock + v_before, updated_at = now() WHERE id = v_water.id;
    END IF;

    -- The shop's and every marketer's stock the same way.
    FOR v_hold IN SELECT * FROM rep_stock WHERE product_id = v_combo.id AND quantity <> 0 FOR UPDATE LOOP
      UPDATE rep_stock SET quantity = 0, updated_at = now()
       WHERE sales_rep_id = v_hold.sales_rep_id AND product_id = v_combo.id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                      user_id, quantity_before, quantity_after)
      VALUES (v_combo.factory_id, v_hold.sales_rep_id, v_combo.id, 'adjustment', -v_hold.quantity, v_ref,
              'Merged into ' || v_water.name, v_uid, v_hold.quantity, 0);
      SELECT quantity INTO v_before FROM rep_stock
       WHERE sales_rep_id = v_hold.sales_rep_id AND product_id = v_water.id FOR UPDATE;
      IF NOT FOUND THEN
        v_before := 0;
        INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
        VALUES (v_hold.sales_rep_id, v_water.id, v_combo.factory_id, v_hold.quantity);
      ELSE
        UPDATE rep_stock SET quantity = quantity + v_hold.quantity, updated_at = now()
         WHERE sales_rep_id = v_hold.sales_rep_id AND product_id = v_water.id;
      END IF;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                      user_id, quantity_before, quantity_after)
      VALUES (v_combo.factory_id, v_hold.sales_rep_id, v_water.id, 'adjustment', v_hold.quantity, v_ref,
              'From ' || v_combo.name, v_uid, v_before, v_before + v_hold.quantity);
    END LOOP;

    -- Retired: no screen offers it any more; its history stays.
    UPDATE products SET active = false, updated_at = now() WHERE id = v_combo.id;

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (v_uid, v_combo.factory_id, 'merge_dispenser_jug_water', 'products', v_combo.id::text,
            jsonb_build_object('into', v_water.id, 'jug_type', v_type, 'jar_price', v_jar, 'with_jar_price', v_with,
                               'reference', v_ref));
    v_done := v_done || jsonb_build_object('factory_id', v_combo.factory_id, 'retired', v_combo.name,
                                           'into', v_water.name, 'jar_price', v_jar, 'with_jar_price', v_with);
  END LOOP;
  RETURN jsonb_build_object('done', v_done);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_dispenser_jug_water() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_dispenser_jug_water() TO authenticated;

-- Once now (no user: runs as the migration).
SELECT public.merge_dispenser_jug_water();

NOTIFY pgrst, 'reload schema';
