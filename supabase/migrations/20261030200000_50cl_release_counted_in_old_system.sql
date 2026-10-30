-- ============================================================================
-- 50cl: 535 packs released by Production are already in the old system
-- ----------------------------------------------------------------------------
-- User (2026-10-30): Production released 535 packs of 50cl that the old
-- system's 30 Oct report already counts (its Qty In 695 / Balance 497). The
-- Warehouse accepts the release in this system so it is on record -- that
-- adds 535 to stock -- and this takes the 535 back out, so the stock tallies
-- with the old system's Balance again (497 + 535 - 535).
--
-- Run it AFTER the Warehouse has accepted the release: stock can't go below
-- 0, so run first it changes nothing and says so (497 - 535). Posted once, as an
-- 'adjusted' line PRE-SWITCH-RELEASE-50CL ("already counted in the old
-- system"); on 30 Oct the report shows the old system's row as is, and the
-- next day opens at the stock. Safe to run again.
-- Values are read with := (no select-into): the Supabase SQL Editor
-- mistakes that form for creating a table and breaks the script.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_n int;
  v_pid uuid;
  v_before numeric;
  v_qty constant numeric := 535;
BEGIN
  v_n := (SELECT count(*) FROM products
           WHERE factory_id = v_factory AND product_type = 'finished' AND active
             AND btrim(name) ~* '^50 ?cl bottle');
  IF v_n <> 1 THEN
    RAISE NOTICE '50cl Bottle Water: % matching products -- not changed', v_n;
    RETURN;
  END IF;
  v_pid := (SELECT id FROM products
             WHERE factory_id = v_factory AND product_type = 'finished' AND active
               AND btrim(name) ~* '^50 ?cl bottle');

  IF EXISTS (SELECT 1 FROM inventory_movements
              WHERE product_id = v_pid AND reference = 'PRE-SWITCH-RELEASE-50CL') THEN
    RAISE NOTICE '50cl: the 535 packs were already taken out -- nothing changed';
    RETURN;
  END IF;

  PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
  v_before := (SELECT current_stock FROM products WHERE id = v_pid);
  IF v_before < v_qty THEN
    RAISE NOTICE '50cl stock is % -- NOT CHANGED: accept the 535-pack release from Production first, then run this again', v_before;
    RETURN;
  END IF;

  UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_pid;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after, created_at)
  VALUES (v_factory, v_pid, 'adjusted', -v_qty, 'PRE-SWITCH-RELEASE-50CL',
          'Release of 535 packs already counted in the old system''s 30 Oct Qty In: taken back out',
          auth.uid(), v_before, v_before - v_qty, clock_timestamp());
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'stock_count', 'products', 'PRE-SWITCH-RELEASE-50CL',
          jsonb_build_object('product', '50cl Bottle Water', 'stock', v_before),
          jsonb_build_object('product', '50cl Bottle Water', 'stock', v_before - v_qty,
                             'reason', 'Release already counted in the old system''s 30 Oct Qty In'));
  RAISE NOTICE '50cl: 535 taken back out -- stock % -> %', v_before, v_before - v_qty;
END $$;
