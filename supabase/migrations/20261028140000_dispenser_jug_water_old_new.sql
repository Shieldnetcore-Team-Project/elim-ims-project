-- ============================================================================
-- Dispenser/Jug Water, in New Jug and Old Jug
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-28): "Dispenser Water" and "Jug + Water"
-- are the same thing, named "Dispenser/Jug Water" everywhere, and kept as two
-- products by jug: New Jug and Old Jug. The Production Manager posts it to
-- the Warehouse (production release) and the Warehouse accepts it. In the
-- Water Factory:
--   * the category "Dispenser Water" is renamed "Dispenser/Jug Water";
--   * the product "Dispenser Water" becomes "Dispenser/Jug Water (Old Jug)"
--     -- it keeps its stock, price and every record;
--   * the product "Jug + Water" becomes "Dispenser/Jug Water (New Jug)";
--     where there is none, it is created (0 stock, same unit, price and
--     category as the Old Jug one);
--   * jug tracking: each is linked to its jug type (container "Old Jug" /
--     "New Jug", one jug per unit), replacing any other jug link it had, so
--     a sale or posting moves the right kind of jug.
-- Also: warehouse_restock refuses the renamed category like the old one, and
-- the Warehouse products report puts Empty Jug Sold on the first
-- Dispenser/Jug Water row. An audit row lists the changes. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_cat uuid;
  v_old products%ROWTYPE;
  v_new_id uuid;
  v_jug uuid;
  v_log jsonb := '{}'::jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  -- Category.
  SELECT id INTO v_cat FROM product_categories
   WHERE factory_id = v_factory AND lower(btrim(name)) = 'dispenser/jug water';
  IF v_cat IS NULL THEN
    UPDATE product_categories SET name = 'Dispenser/Jug Water'
     WHERE factory_id = v_factory AND lower(btrim(name)) = 'dispenser water'
    RETURNING id INTO v_cat;
    IF v_cat IS NOT NULL THEN v_log := v_log || jsonb_build_object('category', 'Dispenser Water -> Dispenser/Jug Water'); END IF;
  END IF;
  IF v_cat IS NULL THEN
    INSERT INTO product_categories (factory_id, name, description)
    VALUES (v_factory, 'Dispenser/Jug Water', 'Dispenser/jug water in new and old jugs, and empty jugs')
    RETURNING id INTO v_cat;
  END IF;

  -- Old Jug: the existing Dispenser Water.
  SELECT * INTO v_old FROM products
   WHERE factory_id = v_factory AND lower(btrim(name)) = 'dispenser/jug water (old jug)';
  IF NOT FOUND THEN
    UPDATE products SET name = 'Dispenser/Jug Water (Old Jug)', category_id = COALESCE(v_cat, category_id), updated_at = now()
     WHERE factory_id = v_factory AND lower(btrim(name)) = 'dispenser water'
    RETURNING * INTO v_old;
    IF FOUND THEN
      v_log := v_log || jsonb_build_object('old_jug', 'Dispenser Water renamed');
    ELSE
      INSERT INTO products (factory_id, name, unit, unit_price, cost_price, current_stock, product_type, category_id, active)
      VALUES (v_factory, 'Dispenser/Jug Water (Old Jug)', 'Piece', 0, 0, 0, 'finished', v_cat, true)
      RETURNING * INTO v_old;
      v_log := v_log || jsonb_build_object('old_jug', 'created');
    END IF;
  END IF;

  -- New Jug: the existing Jug + Water, else a new product like the Old Jug one.
  SELECT id INTO v_new_id FROM products
   WHERE factory_id = v_factory AND lower(btrim(name)) = 'dispenser/jug water (new jug)';
  IF v_new_id IS NULL THEN
    UPDATE products SET name = 'Dispenser/Jug Water (New Jug)', category_id = COALESCE(v_cat, category_id), updated_at = now()
     WHERE factory_id = v_factory AND lower(btrim(name)) = 'jug + water'
    RETURNING id INTO v_new_id;
    IF v_new_id IS NOT NULL THEN
      v_log := v_log || jsonb_build_object('new_jug', 'Jug + Water renamed');
    ELSE
      INSERT INTO products (factory_id, name, unit, unit_price, cost_price, current_stock, product_type, category_id, active)
      VALUES (v_factory, 'Dispenser/Jug Water (New Jug)', v_old.unit, v_old.unit_price, 0, 0, 'finished',
              COALESCE(v_cat, v_old.category_id), true)
      RETURNING id INTO v_new_id;
      v_log := v_log || jsonb_build_object('new_jug', 'created');
    END IF;
  END IF;
  UPDATE products SET active = true, product_type = 'finished' WHERE id IN (v_old.id, v_new_id);

  -- Jug tracking: one jug of the right kind per unit.
  SELECT id INTO v_jug FROM container_types
   WHERE factory_id = v_factory AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = 'old jug';
  IF v_jug IS NOT NULL THEN
    DELETE FROM product_containers WHERE product_id = v_old.id AND container_type_id <> v_jug;
    INSERT INTO product_containers (product_id, container_type_id, quantity_per_unit)
    VALUES (v_old.id, v_jug, 1) ON CONFLICT (product_id, container_type_id) DO NOTHING;
  END IF;
  v_jug := NULL;
  SELECT id INTO v_jug FROM container_types
   WHERE factory_id = v_factory AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = 'new jug';
  IF v_jug IS NOT NULL THEN
    DELETE FROM product_containers WHERE product_id = v_new_id AND container_type_id <> v_jug;
    INSERT INTO product_containers (product_id, container_type_id, quantity_per_unit)
    VALUES (v_new_id, v_jug, 1) ON CONFLICT (product_id, container_type_id) DO NOTHING;
  END IF;

  IF v_log <> '{}'::jsonb THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'update', 'products', 'dispenser-jug-water',
            v_log || jsonb_build_object('reason', 'Dispenser Water and Jug + Water merged as Dispenser/Jug Water, New Jug / Old Jug (2026-10-28)'));
  END IF;
  RAISE NOTICE 'Dispenser/Jug Water: %', v_log;
END $$;

-- Restock: the renamed category comes from Production too.
CREATE OR REPLACE FUNCTION public.warehouse_restock(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(payload->>'notes'), '');
  v_product products%ROWTYPE;
  v_category text;
  v_number text;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be more than 0'; END IF;
  SELECT * INTO v_product FROM products WHERE id = (payload->>'product_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to this factory'; END IF;
  IF v_product.product_type <> 'finished' OR NOT v_product.active THEN
    RAISE EXCEPTION '% can''t be restocked here', v_product.name;
  END IF;
  SELECT name INTO v_category FROM product_categories WHERE id = v_product.category_id;
  IF lower(COALESCE(v_category, '')) IN ('bottle water', 'dispenser water', 'dispenser/jug water')
     OR v_product.name ILIKE '%bottle water%' OR v_product.name ILIKE 'dispenser%' THEN
    RAISE EXCEPTION '% comes from Production -- accept it under Production Releases to Accept', v_product.name;
  END IF;

  v_number := 'RST-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_product.id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_factory, v_product.id, 'received', v_qty, v_number,
          COALESCE('Restocked: ' || v_notes, 'Restocked'), v_uid,
          v_product.current_stock, v_product.current_stock + v_qty);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'warehouse_restock', 'products', v_product.id::text,
          jsonb_build_object('reference', v_number, 'product', v_product.name, 'quantity', v_qty,
                             'unit', v_product.unit, 'notes', v_notes));
  RETURN jsonb_build_object('reference', v_number, 'stock', v_product.current_stock + v_qty);
END;
$$;

-- Products report: with two Dispenser/Jug Water rows, Empty Jug Sold goes on
-- the first one only.
CREATE OR REPLACE FUNCTION public.warehouse_products_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(product_id uuid, product_name text, unit text,
              opening numeric, qty_in numeric, qty_out numeric, gift numeric,
              returned numeric, sold numeric, empty_jug_sold numeric, balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start timestamptz := (p_from::timestamp) AT TIME ZONE 'Africa/Lagos';
  v_end timestamptz := ((p_to + 1)::timestamp) AT TIME ZONE 'Africa/Lagos';
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;

  RETURN QUERY
  WITH w AS (
    SELECT p.id AS pid, p.name AS pname, p.unit AS punit, p.current_stock AS cur,
           COALESCE(SUM(m.d) FILTER (WHERE m.created_at >= v_start), 0) AS after_start,
           COALESCE(SUM(m.d) FILTER (WHERE m.created_at >= v_end), 0) AS after_end,
           COALESCE(SUM(m.d) FILTER (WHERE m.in_range AND m.cls = 'in'), 0) AS q_in,
           COALESCE(SUM(-m.d) FILTER (WHERE m.in_range AND m.cls = 'out'), 0) AS q_out,
           COALESCE(SUM(-m.d) FILTER (WHERE m.in_range AND m.cls = 'gift'), 0) AS q_gift,
           COALESCE(SUM(m.d) FILTER (WHERE m.in_range AND m.cls = 'returned'), 0) AS q_ret
      FROM products p
      LEFT JOIN LATERAL (
        SELECT im.created_at,
               im.quantity_after - im.quantity_before AS d,
               im.created_at >= v_start AND im.created_at < v_end AS in_range,
               CASE
                 WHEN im.movement_type = 'dispatched_to_rep' THEN 'out'
                 WHEN im.movement_type = 'sold' AND im.reason ILIKE 'PR%' THEN 'gift'
                 WHEN im.movement_type = 'sold' THEN 'out'
                 WHEN im.movement_type = 'issued' THEN 'gift'
                 WHEN im.movement_type = 'return_from_rep'
                      AND EXISTS (SELECT 1 FROM stock_dispatches sd
                                   WHERE sd.dispatch_number = im.reference) THEN 'out'
                 WHEN im.movement_type IN ('return_from_rep', 'returned') THEN 'returned'
                 ELSE 'in'
               END AS cls
          FROM inventory_movements im
         WHERE im.product_id = p.id AND im.created_at >= v_start
      ) m ON true
     WHERE p.factory_id = p_factory AND p.product_type = 'finished'
     GROUP BY p.id, p.name, p.unit, p.current_stock
  ), jug AS (
    SELECT COALESCE(SUM(w.q_out - w.q_ret), 0) AS jug_sold FROM w WHERE lower(btrim(w.pname)) = 'empty jug'
  ), first_dispenser AS (
    SELECT w.pid FROM w WHERE w.pname ILIKE 'dispenser%' ORDER BY w.pname LIMIT 1
  )
  SELECT w.pid, w.pname, w.punit,
         w.cur - w.after_start,
         w.q_in, w.q_out, w.q_gift, w.q_ret,
         w.q_out - w.q_ret,
         CASE WHEN w.pid = (SELECT first_dispenser.pid FROM first_dispenser)
              THEN (SELECT jug.jug_sold FROM jug) ELSE 0 END,
         w.cur - w.after_end
    FROM w
   WHERE lower(btrim(w.pname)) <> 'empty jug'
     AND (w.cur - w.after_start <> 0 OR w.q_in <> 0 OR w.q_out <> 0
          OR w.q_gift <> 0 OR w.q_ret <> 0 OR w.cur - w.after_end <> 0)
   ORDER BY w.pname;
END;
$$;
