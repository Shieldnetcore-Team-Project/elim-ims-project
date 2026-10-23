-- ============================================================================
-- Acceptance tests: Old Jug / New Jug and Warehouse returns
-- (20261023190000_jug_types_old_new.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test. Uses the Water Factory (where the jug types are added) with its own
-- user and marketer.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('8a000000-0000-0000-0000-000000000001', 'austin@jugs');
INSERT INTO profiles(id, email, full_name)
SELECT '8a000000-0000-0000-0000-000000000001', 'austin@jugs', 'Austin'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '8a000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '8a000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT '8a000000-0000-0000-0000-000000000001', 'store_warehouse', f.id FROM factories f WHERE f.code = 'water';
INSERT INTO sales_reps(id, factory_id, code, full_name, status, kind)
SELECT '8e000000-0000-0000-0000-000000000001', f.id, 'JUG-OLD-01', 'Jug Test Marketer', 'active', 'rep'
  FROM factories f WHERE f.code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.jug(p_name text) RETURNS uuid LANGUAGE sql AS $$
  SELECT c.id FROM container_types c JOIN factories f ON f.id = c.factory_id
   WHERE f.code = 'water' AND c.name = p_name $$;

-- @@ Test 1: the Water Factory has Old Jug and New Jug, once each
DO $$
BEGIN
  PERFORM pg_temp.check(pg_temp.jug('Old Jug') IS NOT NULL AND pg_temp.jug('New Jug') IS NOT NULL, 'both jug types');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM container_types c JOIN factories f ON f.id = c.factory_id
                          WHERE f.code = 'water' AND lower(c.name) IN ('old jug', 'new jug')) = 2, 'no duplicates');
END $$;

-- @@ Test 2: the Warehouse (Store & Warehouse role) records an Old Jug return
DO $$
DECLARE v jsonb; f uuid;
BEGIN
  SELECT id INTO f FROM factories WHERE code = 'water';
  PERFORM set_config('test.uid', '8a000000-0000-0000-0000-000000000001', false);
  -- The marketer's opening balance: 10 Old Jugs out with them.
  PERFORM public.record_container_movement(jsonb_build_object('factory_id', f,
    'container_type_id', pg_temp.jug('Old Jug'), 'kind', 'issue', 'holder_type', 'sales_rep',
    'holder_id', '8e000000-0000-0000-0000-000000000001', 'quantity', 10, 'notes', 'Opening balance count'));
  v := public.record_jug_return(jsonb_build_object('sales_rep_id', '8e000000-0000-0000-0000-000000000001',
    'container_type_id', pg_temp.jug('Old Jug'), 'quantity', 4, 'notes', 'Brought back today'));
  PERFORM pg_temp.check((SELECT container_type_id = pg_temp.jug('Old Jug') AND quantity_claimed = 4 AND status = 'pending'
                           FROM jug_returns WHERE id = (v->>'id')::uuid), 'Old Jug return recorded: ' || v::text);
END $$;
