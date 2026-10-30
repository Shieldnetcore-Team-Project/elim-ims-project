-- ============================================================================
-- Acceptance tests: 50cl release already counted in the old system
-- (20261030200000_50cl_release_counted_in_old_system.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. 50cl stands at 497 (the old system's
-- balance). Run before the release is accepted it is refused (stock can't go
-- below 0); after the Warehouse accepts the 535 packs it takes them back out
-- once: stock 497 again.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b0800000-0000-0000-0000-000000000001', 'wh@r535'),
  ('b0800000-0000-0000-0000-000000000002', 'pm@r535');
DELETE FROM user_roles WHERE user_id IN ('b0800000-0000-0000-0000-000000000001', 'b0800000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('b0800000-0000-0000-0000-000000000001', 'super_admin');
UPDATE products SET active = false, name = name || ' (old ' || left(id::text, 8) || ')' WHERE product_type = 'finished';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT 'b0800000-0000-0000-0000-0000000000a2', id, '50cl Bottle Water', 'Pack', 'finished', true, 497, 2650
  FROM factories WHERE code = 'water';
INSERT INTO production_releases(factory_id, release_number, product_id, quantity, unit, status, released_by)
SELECT id, 'REL-535', 'b0800000-0000-0000-0000-0000000000a2', 535, 'Pack', 'pending',
       'b0800000-0000-0000-0000-000000000002' FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: run before the release is accepted it changes nothing
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


DO $$
BEGIN
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b0800000-0000-0000-0000-0000000000a2') = 497, 'unchanged: 497');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reference = 'PRE-SWITCH-RELEASE-50CL'), 'nothing posted');
END $$;

-- @@ Test 2: after accepting, 535 taken back out once: stock 497
DO $$
BEGIN
  PERFORM set_config('test.uid', 'b0800000-0000-0000-0000-000000000001', false);
  PERFORM public.accept_production_release((SELECT id FROM production_releases WHERE release_number = 'REL-535'), 535);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b0800000-0000-0000-0000-0000000000a2') = 1032, 'accepted: 1032');
END $$;
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

DO $$
BEGIN
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b0800000-0000-0000-0000-0000000000a2') = 497,
                        'stock: ' || (SELECT current_stock FROM products WHERE id = 'b0800000-0000-0000-0000-0000000000a2'));
  PERFORM pg_temp.check((SELECT status FROM production_releases WHERE release_number = 'REL-535') = 'accepted', 'release on record');
  PERFORM pg_temp.check((SELECT count(*) FROM inventory_movements WHERE reference = 'PRE-SWITCH-RELEASE-50CL') = 1, 'once');
END $$;
