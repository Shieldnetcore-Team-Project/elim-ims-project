-- ============================================================================
-- Acceptance tests: no Expenses page for aniaustin
-- (20261023200000_aniaustin_no_expenses.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration matches "aniaustin"; this
-- runs the same function for a test account of the same role.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('8b000000-0000-0000-0000-000000000001', 'noexp-tester@elim.test');
INSERT INTO profiles(id, email, full_name)
SELECT '8b000000-0000-0000-0000-000000000001', 'noexp-tester@elim.test', 'No Expenses Tester'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '8b000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '8b000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT '8b000000-0000-0000-0000-000000000001', 'store_warehouse', f.id FROM factories f WHERE f.code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: Austin loses Expenses only
DO $$
DECLARE u uuid := '8b000000-0000-0000-0000-000000000001'; msg text;
BEGIN
  PERFORM pg_temp.check(public.has_permission(u, 'expenses'::module_key, 'create'::action_key), 'had Expenses before');
  msg := public._no_expenses_for('noexp-tester');
  PERFORM pg_temp.check(msg LIKE '%no longer has the Expenses page%', msg);
  PERFORM pg_temp.check(NOT public.has_permission(u, 'expenses'::module_key, 'view'::action_key)
                        AND NOT public.has_permission(u, 'expenses'::module_key, 'create'::action_key)
                        AND NOT public.has_permission(u, 'expenses'::module_key, 'read'::action_key),
                        'no Expenses right left');
  PERFORM pg_temp.check((SELECT NOT granted FROM user_page_access WHERE user_id = u AND page_id = 'Expenses'),
                        'Expenses page blocked');
  -- Everything else he does is untouched.
  PERFORM pg_temp.check(public.has_permission(u, 'raw-materials'::module_key, 'create'::action_key)
                        AND public.has_permission(u, 'distribution'::module_key, 'create'::action_key),
                        'Store and Warehouse rights kept');
  -- Running it again changes nothing.
  msg := public._no_expenses_for('noexp-tester');
  PERFORM pg_temp.check(NOT public.has_permission(u, 'expenses'::module_key, 'view'::action_key), 'idempotent');
END $$;
