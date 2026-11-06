-- ============================================================================
-- Acceptance tests: Store issues to Production fill Qty In
-- (20261104200000_process_material_store_issues.sql). Runs as an admin.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9a00000-0000-0000-0000-000000000001', 'psfac', 'PS Factory');
INSERT INTO auth.users(id, email) VALUES ('a9a00000-0000-0000-0000-000000000001', 'admin@ps');
DELETE FROM user_roles WHERE user_id = 'a9a00000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a9a00000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock) VALUES
  ('c9a00000-0000-0000-0000-000000000001', 'f9a00000-0000-0000-0000-000000000001', 'PS YUNO MOLD', 'Piece', 100000);
UPDATE raw_materials SET active = false WHERE id = 'c9a00000-0000-0000-0000-000000000001';
SELECT set_config('test.uid', 'a9a00000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.since() RETURNS numeric LANGUAGE sql AS $$
  SELECT received_since FROM public.production_material_options('f9a00000-0000-0000-0000-000000000001')
   WHERE material_id = 'c9a00000-0000-0000-0000-000000000001' $$;

-- @@ Test 1: issued 44,000 -> Qty In 44,000; after a line, only what comes later
DO $$
DECLARE f uuid := 'f9a00000-0000-0000-0000-000000000001'; m uuid := 'c9a00000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, issued_to_department, created_at)
  VALUES (f, m, 'used_for_production', 44000, 'production', now() - interval '2 hours'),
         (f, m, 'issued', 500, 'quality_control', now() - interval '2 hours');
  PERFORM pg_temp.check(pg_temp.since() = 44000, 'issued to Production: ' || pg_temp.since());
  PERFORM public.save_production_material_report(jsonb_build_object('factory_id', f,
    'lines', jsonb_build_array(jsonb_build_object('material_id', m, 'qty_in', 44000, 'qty_used', 23))));
  PERFORM pg_temp.check(pg_temp.since() = 0, 'nothing new after the line');
  -- Later than the line (one test transaction shares one now()).
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, issued_to_department, created_at)
  VALUES (f, m, 'used_for_production', 1000, 'production', now() + interval '1 second');
  PERFORM pg_temp.check(pg_temp.since() = 1000, 'the next issue: ' || pg_temp.since());
END $$;
