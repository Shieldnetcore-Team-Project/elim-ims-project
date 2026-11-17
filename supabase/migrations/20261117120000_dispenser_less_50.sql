-- ============================================================================
-- Warehouse dispenser stock: take 50 off (131 -> 81)
-- ----------------------------------------------------------------------------
-- User (2026-11-17): "in warehouse - dispenser, take off 50 and clear it off
-- the system: instead of 131, minus 50 from it."
--
-- Finds the one finished dispenser / jug product (Dispenser Water, Jug +
-- Water, Empty Jug ...) the Warehouse holds 131 of and takes 50 off it, as a
-- stock correction (inventory_movements 'adjusted', so it shows on the
-- Warehouse Activity Log). If none or more than one such product holds 131 it
-- changes nothing and lists the dispenser stock, so the right one can be named.
-- Safe to run again (the second run finds it already done).
-- ============================================================================

DO $$
DECLARE
  v_ref constant text := 'ADJ-DISP-17NOV-50';
  v_ids uuid[];
  v_p record;
  v_list text;
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_movements WHERE reference = v_ref) THEN
    RAISE NOTICE 'Already done: 50 were taken off the dispenser stock -- nothing to do';
    RETURN;
  END IF;

  v_list := (SELECT string_agg(name || ' = ' || trim(to_char(current_stock, 'FM999G999G990D###')), ', ' ORDER BY name)
               FROM products
              WHERE product_type = 'finished' AND name ~* 'dispenser|jug');
  v_ids := ARRAY(SELECT id FROM products
                  WHERE product_type = 'finished' AND name ~* 'dispenser|jug' AND current_stock = 131);

  IF cardinality(v_ids) <> 1 THEN
    RAISE EXCEPTION '% dispenser products hold 131 in the Warehouse -- nothing changed. Dispenser stock now: %',
      cardinality(v_ids), COALESCE(v_list, 'none');
  END IF;

  SELECT * INTO v_p FROM products WHERE id = v_ids[1] FOR UPDATE;
  UPDATE products SET current_stock = current_stock - 50, updated_at = now() WHERE id = v_p.id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after)
  VALUES (v_p.factory_id, v_p.id, 'adjusted', -50, v_ref,
          'Taken off the system at the user''s request (131 -> 81)', auth.uid(),
          v_p.current_stock, v_p.current_stock - 50);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_p.factory_id, 'stock_adjust', 'products', v_p.id::text,
          jsonb_build_object('name', v_p.name, 'current_stock', v_p.current_stock),
          jsonb_build_object('current_stock', v_p.current_stock - 50,
                             'reason', 'Warehouse dispenser: take 50 off the system (2026-11-17)'));

  RAISE NOTICE '%: % -> % in the Warehouse', v_p.name, v_p.current_stock, v_p.current_stock - 50;
END $$;

-- Dispenser stock after the change.
SELECT name, current_stock
  FROM products
 WHERE product_type = 'finished' AND name ~* 'dispenser|jug'
 ORDER BY name;
