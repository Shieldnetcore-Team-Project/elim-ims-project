-- ============================================================================
-- Acceptance tests: Production -> From Store
-- (20261031200000_production_store_issues.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The Store issues 40 caps to Production
-- (received by the PM) and 10 to Quality Control; a user with Production
-- view only sees the Production issue.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('a3600000-0000-0000-0000-000000000001', 'pm@fromstore'),
  ('a3600000-0000-0000-0000-000000000002', 'store@fromstore');
INSERT INTO profiles(id, email, full_name)
SELECT v.id::uuid, v.e, v.n FROM (VALUES ('a3600000-0000-0000-0000-000000000001', 'pm@fromstore', 'FS PM'),
                                         ('a3600000-0000-0000-0000-000000000002', 'store@fromstore', 'FS Store')) v(id, e, n)
 WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v.id::uuid);
UPDATE profiles SET full_name = CASE id WHEN 'a3600000-0000-0000-0000-000000000001' THEN 'FS PM' ELSE 'FS Store' END
 WHERE id IN ('a3600000-0000-0000-0000-000000000001', 'a3600000-0000-0000-0000-000000000002');
INSERT INTO roles(slug, label, is_system) VALUES ('fs_prod_viewer', 'Production viewer (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action) VALUES ('fs_prod_viewer', 'production', 'view') ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id = 'a3600000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'a3600000-0000-0000-0000-000000000001', 'fs_prod_viewer', id FROM factories WHERE code = 'water';
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock)
SELECT 'b3600000-0000-0000-0000-000000000001', id, 'FS Caps', 'Piece', 1000 FROM factories WHERE code = 'water';
INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, reference, reason, user_id,
                                   issued_to_department, issued_to_user)
SELECT f.id, 'b3600000-0000-0000-0000-000000000001', 'issued', v.q, v.ref, 'test', 'a3600000-0000-0000-0000-000000000002',
       v.dept, CASE WHEN v.dept = 'production' THEN 'a3600000-0000-0000-0000-000000000001'::uuid END
  FROM factories f, (VALUES (40, 'FS-1', 'production'), (10, 'FS-2', 'quality_control')) v(q, ref, dept)
 WHERE f.code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: Production sees its issue (who issued, who received), not QC's
DO $$
DECLARE r record; n int;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
BEGIN
  PERFORM set_config('test.uid', 'a3600000-0000-0000-0000-000000000001', false);
  n := (SELECT count(*) FROM public.production_store_issues(f, CURRENT_DATE, CURRENT_DATE) x WHERE x.material = 'FS Caps');
  PERFORM pg_temp.check(n = 1, 'one issue to Production: ' || n);
  SELECT * INTO r FROM public.production_store_issues(f, CURRENT_DATE, CURRENT_DATE) x WHERE x.material = 'FS Caps';
  PERFORM pg_temp.check(r.quantity = 40 AND r.received_by = 'FS PM' AND r.issued_by = 'FS Store' AND r.unit = 'Piece',
                        'row: ' || row_to_json(r)::text);
END $$;

-- @@ Test 2: no Production or Store rights -> refused
DO $$
DECLARE ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', '', false);
  DELETE FROM role_permissions WHERE role = 'fs_prod_viewer';
  PERFORM set_config('test.uid', 'a3600000-0000-0000-0000-000000000001', false);
  BEGIN
    PERFORM public.production_store_issues((SELECT id FROM factories WHERE code = 'water'), CURRENT_DATE, CURRENT_DATE);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM pg_temp.check(ok, 'refused without rights');
END $$;
