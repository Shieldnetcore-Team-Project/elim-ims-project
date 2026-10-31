-- ============================================================================
-- Acceptance tests: production hall opening balance
-- (20261031090000_production_hall_opening_31oct.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration's own clean-up ran on an
-- empty database, so the test records an opening the same way it does.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('6a000000-0000-0000-0000-000000000031', 'pm@hallopen');
INSERT INTO profiles(id, email, full_name)
SELECT '6a000000-0000-0000-0000-000000000031', 'pm@hallopen', 'PM Opening'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '6a000000-0000-0000-0000-000000000031');
DELETE FROM user_roles WHERE user_id = '6a000000-0000-0000-0000-000000000031';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('6a000000-0000-0000-0000-000000000031', 'super_admin', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('6d000000-0000-0000-0000-000000000031', (SELECT id FROM factories WHERE code = 'water'), 'OPN Bottle', 'Pack', 0, 40, 'finished');

SELECT set_config('test.uid', '6a000000-0000-0000-0000-000000000031', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the opening replaces what came before it; later batches and releases count on top
DO $$
DECLARE v jsonb; s record;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '6d000000-0000-0000-0000-000000000031';
  d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  -- Yesterday: 100 made, 30 released -> 70 in the hall.
  v := public.create_production(jsonb_build_object('factory_id', f, 'product_id', p,
         'quantity_produced', 100, 'unit', 'Pack', 'shift', 'day'));
  UPDATE production SET production_date = d - 1 WHERE id = (v->>'id')::uuid;
  PERFORM public.release_to_warehouse(jsonb_build_object('factory_id', f, 'product_id', p, 'quantity', 30));
  UPDATE production_releases SET released_at = released_at - interval '1 day' WHERE product_id = p;
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 70, 'hall 70 before the opening');

  INSERT INTO production_hall_openings(factory_id, product_id, opening_date, quantity, reason, created_by)
  VALUES (f, p, d, 500, 'test opening', auth.uid());
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 500, 'hall = opening');

  PERFORM public.create_production(jsonb_build_object('factory_id', f, 'product_id', p,
         'quantity_produced', 20, 'unit', 'Pack', 'shift', 'day'));
  PERFORM public.release_to_warehouse(jsonb_build_object('factory_id', f, 'product_id', p, 'quantity', 50));
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 470, 'opening + 20 - 50');

  SELECT * INTO s FROM public.production_hall_stock(f) WHERE product_id = p;
  PERFORM pg_temp.check(s.produced = 20 AND s.released = 50 AND s.in_hall = 470,
                        'hall row: ' || row_to_json(s)::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = p) = 40, 'Warehouse stock unchanged');
END $$;

-- @@ Test 2: a batch before the opening is locked; a release can't exceed the hall
DO $$
DECLARE bid uuid; e text; e2 text;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '6d000000-0000-0000-0000-000000000031';
  d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  bid := (SELECT id FROM production WHERE product_id = p AND production_date = d - 1);
  BEGIN
    PERFORM public.cancel_production_with_releases(bid, 'try');
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  PERFORM pg_temp.check(e LIKE '%before the production hall opening balance%', 'cancel refused: ' || COALESCE(e, 'none'));
  BEGIN
    PERFORM public.release_to_warehouse(jsonb_build_object('factory_id', f, 'product_id', p, 'quantity', 471));
  EXCEPTION WHEN OTHERS THEN e2 := SQLERRM;
  END;
  PERFORM pg_temp.check(e2 IS NOT NULL, 'release over the hall refused');
  PERFORM pg_temp.check(public._production_hall_available(f, p) = 470, 'hall unchanged');
END $$;
