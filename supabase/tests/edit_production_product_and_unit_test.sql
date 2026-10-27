-- ============================================================================
-- Acceptance tests: correct a batch's product and unit
-- (20261027160000_edit_production_product_and_unit.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('5a000000-0000-0000-0000-000000000001', 'pm@edprd');
INSERT INTO profiles(id, email, full_name)
SELECT '5a000000-0000-0000-0000-000000000001', 'pm@edprd', 'PM Edit'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '5a000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '5a000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('5a000000-0000-0000-0000-000000000001', 'super_admin', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('5d000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), '50cl Water', 'Bottle', 0, 0, 'finished'),
  ('5d000000-0000-0000-0000-000000000002', (SELECT id FROM factories WHERE code = 'water'), '75cl Water', 'Bottle', 0, 0, 'finished');
INSERT INTO product_units(product_id, base_unit, packaging_unit, conversion_factor) VALUES
  ('5d000000-0000-0000-0000-000000000001', 'Bottle', 'Pack', 12),
  ('5d000000-0000-0000-0000-000000000002', 'Bottle', 'Pack', 20);

SELECT set_config('test.uid', '5a000000-0000-0000-0000-000000000001', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: wrong product and unit corrected, hall follows
DO $$
DECLARE v jsonb; bid uuid; r production%ROWTYPE;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p50 uuid := '5d000000-0000-0000-0000-000000000001';
  p75 uuid := '5d000000-0000-0000-0000-000000000002';
BEGIN
  -- Entered as 10 Packs of 50cl (120 bottles); it was really 10 Packs of 75cl.
  v := public.create_production(jsonb_build_object('factory_id', f, 'product_id', p50,
         'packaging_unit', 'Pack', 'packaging_quantity', 10, 'unit', 'Bottle', 'shift', 'day'));
  bid := (v->>'id')::uuid;
  PERFORM public.update_production(jsonb_build_object('id', bid, 'product_id', p75, 'quantity_produced', 120,
         'packaging_unit', 'Pack', 'packaging_quantity', 10, 'unit', 'Bottle', 'shift', 'day'));
  SELECT * INTO r FROM production WHERE production.id = bid;
  PERFORM pg_temp.check(r.product_id = p75 AND r.quantity_produced = 200 AND r.packaging_quantity = 10,
                        'moved to 75cl, 10 packs = 200 bottles: ' || r.quantity_produced);
  PERFORM pg_temp.check(public._production_hall_available(f, p50) = 0, '50cl hall back to 0');
  PERFORM pg_temp.check(public._production_hall_available(f, p75) = 200, '75cl hall 200');

  -- Unit changed to a plain count: 150 Bottles, no packaging.
  PERFORM public.update_production(jsonb_build_object('id', bid, 'quantity_produced', 150,
         'packaging_unit', NULL, 'packaging_quantity', NULL, 'unit', 'Bottle'));
  SELECT * INTO r FROM production WHERE production.id = bid;
  PERFORM pg_temp.check(r.quantity_produced = 150 AND r.packaging_unit IS NULL AND r.packaging_quantity IS NULL,
                        'plain unit clears packaging');

  -- Old callers (no product_id / packaging_unit) keep working.
  PERFORM public.update_production(jsonb_build_object('id', bid, 'quantity_produced', 140, 'unit', 'Bottle'));
  SELECT * INTO r FROM production WHERE production.id = bid;
  PERFORM pg_temp.check(r.quantity_produced = 140 AND r.product_id = p75, 'old payload works');
END $$;

-- @@ Test 2: can't move a batch off a product whose goods were released
DO $$
DECLARE v jsonb; bid uuid; ok boolean := false;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p50 uuid := '5d000000-0000-0000-0000-000000000001';
  p75 uuid := '5d000000-0000-0000-0000-000000000002';
BEGIN
  v := public.create_production(jsonb_build_object('factory_id', f, 'product_id', p50,
         'quantity_produced', 100, 'unit', 'Bottle', 'shift', 'night'));
  bid := (v->>'id')::uuid;
  PERFORM public.release_to_warehouse(jsonb_build_object('factory_id', f, 'product_id', p50, 'quantity', 60));
  BEGIN
    PERFORM public.update_production(jsonb_build_object('id', bid, 'product_id', p75, 'quantity_produced', 100,
           'unit', 'Bottle'));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already been released%';
  END;
  PERFORM pg_temp.check(ok, 'released goods block the move');
  PERFORM pg_temp.check((SELECT product_id FROM production WHERE production.id = bid) = p50, 'batch unchanged');
END $$;
