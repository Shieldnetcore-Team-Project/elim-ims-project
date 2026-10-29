-- ============================================================================
-- Acceptance tests: clearing the Production Hall
-- (20261029120000_clear_production_hall.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration's clean-up ran on an empty
-- database, so the test records a clearance the same way it does.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('6a000000-0000-0000-0000-000000000001', 'pm@clrhall');
INSERT INTO profiles(id, email, full_name)
SELECT '6a000000-0000-0000-0000-000000000001', 'pm@clrhall', 'PM Clear'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '6a000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '6a000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('6a000000-0000-0000-0000-000000000001', 'super_admin', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('6d000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'CLR Sachet', 'Bag', 0, 500, 'finished');

SELECT set_config('test.uid', '6a000000-0000-0000-0000-000000000001', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: 100 made, 60 released, 40 cleared -> hall 0; release and Warehouse stock untouched
DO $$
DECLARE v jsonb; s record;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '6d000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_production(jsonb_build_object('factory_id', f, 'product_id', p,
         'quantity_produced', 100, 'unit', 'Bag', 'shift', 'day'));
  PERFORM public.release_to_warehouse(jsonb_build_object('factory_id', f, 'product_id', p, 'quantity', 60));
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 40, 'hall 40 before');
  INSERT INTO production_hall_clearances(factory_id, product_id, quantity, reason, cleared_by)
  VALUES (f, p, public._production_hall_available(f, p), 'test clear', auth.uid());
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 0, 'hall 0 after');
  SELECT * INTO s FROM public.production_hall_stock(f) WHERE product_id = p;
  -- Shown empty after the clear-out (20261029130000): nothing since it.
  PERFORM pg_temp.check(s.produced = 0 AND s.released = 0 AND s.cleared = 0 AND s.in_hall = 0,
                        'hall row: ' || row_to_json(s)::text);
  PERFORM pg_temp.check((SELECT COUNT(*) FROM production_releases WHERE product_id = p AND status = 'pending') = 1, 'release kept');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = p) = 500, 'Warehouse stock unchanged');
END $$;

-- @@ Test 2: cleared batches are locked; new batches count, release and edit normally
DO $$
DECLARE v jsonb; bid uuid; e text;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '6d000000-0000-0000-0000-000000000001';
BEGIN
  SELECT id INTO bid FROM production WHERE product_id = p;
  BEGIN
    PERFORM public.cancel_production_with_releases(bid, 'try');
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  PERFORM pg_temp.check(e LIKE '%cleared from the production hall%', 'cancel refused: ' || COALESCE(e, 'none'));
  -- Nothing was reversed by the refused cancel.
  PERFORM pg_temp.check((SELECT COUNT(*) FROM production_releases WHERE product_id = p AND status = 'pending') = 1,
                        'release still pending');

  v := public.create_production(jsonb_build_object('factory_id', f, 'product_id', p,
         'quantity_produced', 30, 'unit', 'Bag', 'shift', 'night'));
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 30, 'new batch in hall');
  PERFORM public.update_production(jsonb_build_object('id', (v->>'id')::uuid, 'quantity_produced', 25, 'unit', 'Bag'));
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 25, 'new batch editable');
  PERFORM public.release_to_warehouse(jsonb_build_object('factory_id', f, 'product_id', p, 'quantity', 25));
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 0, 'released from the new batch');
END $$;

-- @@ Test 3: the hall lists only what came after the clear-out
DO $$
DECLARE s record;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '6d000000-0000-0000-0000-000000000001';
BEGIN
  SELECT * INTO s FROM public.production_hall_stock(f) WHERE product_id = p;
  PERFORM pg_temp.check(s.produced = 25 AND s.released = 25 AND s.in_hall = 0 AND s.cleared = 0,
                        'since clear-out: ' || row_to_json(s)::text);
END $$;
