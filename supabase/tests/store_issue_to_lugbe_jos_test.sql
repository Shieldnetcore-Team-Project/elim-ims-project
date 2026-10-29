-- ============================================================================
-- Acceptance tests: Store issues to Lugbe and Jos
-- (20261029100000_store_issue_to_lugbe_jos.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('3f000000-0000-0000-0000-000000000001', 'lugjos', 'Lugbe Jos Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('3a000000-0000-0000-0000-000000000001', 'store@lugjos'),
  ('3a000000-0000-0000-0000-000000000002', 'qc@lugjos');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '3a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '3a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('3a000000-0000-0000-0000-000000000001', 'store_keeper', '3f000000-0000-0000-0000-000000000001'),
  ('3a000000-0000-0000-0000-000000000002', 'qc_officer', '3f000000-0000-0000-0000-000000000001');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost) VALUES
  ('3c000000-0000-0000-0000-000000000001', '3f000000-0000-0000-0000-000000000001', 'Shrink Wrap', 'Roll', 100, 5000, 50);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: issue to Lugbe and Jos -- a general issue, stock and value leave the Store, collector recorded
DO $$
DECLARE m raw_material_movements%ROWTYPE; w uuid := '3c000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', '3a000000-0000-0000-0000-000000000001', false);
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', w, 'quantity', 10, 'purpose', 'production',
    'issued_to_department', 'lugbe', 'collected_by', 'Musa (driver)', 'reason', 'For Lugbe line', 'reference', 'WB-12'));
  SELECT * INTO m FROM raw_material_movements WHERE material_id = w AND issued_to_department = 'lugbe';
  PERFORM pg_temp.check(m.movement_type = 'issued' AND m.quantity = 10 AND m.issued_to_user IS NULL
                        AND m.reason = 'Issued to Lugbe — collected by Musa (driver): For Lugbe line'
                        AND m.reference = 'WB-12', 'lugbe movement: ' || COALESCE(m.reason, 'none'));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', w, 'quantity', 5, 'issued_to_department', 'jos'));
  PERFORM pg_temp.check((SELECT reason FROM raw_material_movements WHERE material_id = w AND issued_to_department = 'jos') = 'Issued to Jos', 'jos reason');
  PERFORM pg_temp.check((SELECT current_stock = 85 AND current_value = 4250 FROM raw_materials WHERE id = w), 'stock and value out');
  -- Nothing lands in QC's store.
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM qc_store_receipts WHERE material_id = w), 'no QC receipt');
END $$;

-- @@ Test 2: a user cannot be named for a site; unknown destinations refused; QC still works
DO $$
DECLARE e text; w uuid := '3c000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', '3a000000-0000-0000-0000-000000000001', false);
  e := pg_temp.err(format($q$SELECT public.issue_raw_material('{"material_id":"%s","quantity":1,"issued_to_department":"lugbe","issued_to_user":"3a000000-0000-0000-0000-000000000002"}')$q$, w));
  PERFORM pg_temp.check(e LIKE '%collected it, not a user%', 'user on site: ' || COALESCE(e, 'none'));
  e := pg_temp.err(format($q$SELECT public.issue_raw_material('{"material_id":"%s","quantity":1,"issued_to_department":"kano"}')$q$, w));
  PERFORM pg_temp.check(e LIKE '%Lugbe or Jos%', 'unknown site: ' || COALESCE(e, 'none'));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', w, 'quantity', 2, 'purpose', 'general',
    'issued_to_department', 'quality_control', 'issued_to_user', '3a000000-0000-0000-0000-000000000002'));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM qc_store_receipts WHERE material_id = w), 'QC issue still makes a receipt');
END $$;
