-- ============================================================================
-- Acceptance tests: Production materials report
-- (20261028260000_production_materials_report.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A production user (role 'production')
-- records the factory sheet's three materials.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('ae000000-0000-0000-0000-000000000009', 'boss@pmr'),
  ('ae000000-0000-0000-0000-000000000001', 'pm@pmr');
DELETE FROM user_roles WHERE user_id IN ('ae000000-0000-0000-0000-000000000009', 'ae000000-0000-0000-0000-000000000001');
INSERT INTO user_roles(user_id, role) VALUES ('ae000000-0000-0000-0000-000000000009', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'ae000000-0000-0000-0000-000000000001', 'production', id FROM factories WHERE code = 'water';
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, approval_status, active)
SELECT v.id::uuid, f.id, v.nm, v.u, 0, 'approved', true FROM factories f,
  (VALUES ('af000000-0000-0000-0000-000000000001', 'PMR Jug Cap (Aflac)', 'Piece'),
          ('af000000-0000-0000-0000-000000000002', 'PMR Sachet Roll (OMKAR)', 'Roll'),
          ('af000000-0000-0000-0000-000000000003', 'PMR Packing Nylon (Rowlacom)', 'Piece')) v(id, nm, u)
 WHERE f.code = 'water';
SELECT set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: add, totals, opening carried, edit, refusals
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r record; ok boolean := false; rid uuid;
  cap uuid := 'af000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.save_production_material_report(jsonb_build_object('factory_id', f, 'lines', jsonb_build_array(
    jsonb_build_object('material_id', cap, 'opening', 1539, 'qty_in', 1000),
    jsonb_build_object('material_id', 'af000000-0000-0000-0000-000000000002', 'opening', 29, 'qty_in', 6),
    jsonb_build_object('material_id', 'af000000-0000-0000-0000-000000000003', 'opening', 14600, 'qty_in', 5000))));
  SELECT * INTO r FROM production_material_reports WHERE material_id = cap;
  PERFORM pg_temp.check(r.total = 2539 AND r.balance = 2539 AND r.created_by_name IS NOT NULL, 'jug cap 1539 + 1000');
  -- the next entry starts from that balance
  PERFORM pg_temp.check((SELECT last_balance FROM public.production_material_options(f) WHERE material_id = cap) = 2539,
                        'opening carried forward');
  -- edit: 500 used, 20 damaged, 5 replaced -> 2539 - 500 - 20 + 5 = 2024
  rid := r.id;
  PERFORM public.save_production_material_report(jsonb_build_object('id', rid, 'qty_used', 500, 'damages', 20, 'replaced', 5));
  PERFORM pg_temp.check((SELECT balance FROM production_material_reports WHERE id = rid) = 2024, 'edited balance 2024');
  -- can't use more than there is
  BEGIN
    PERFORM public.save_production_material_report(jsonb_build_object('id', rid, 'qty_used', 99999));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%can''t end below 0%';
  END;
  PERFORM pg_temp.check(ok, 'below zero refused');
END $$;
