-- ============================================================================
-- Acceptance tests: Warehouse only for Oluwakemi
-- (20261027240000_oluwakemi_warehouse_only.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration matches her email; this
-- runs the same function for a test account.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('8e000000-0000-0000-0000-000000000001', 'whonly-tester@elim.test');
INSERT INTO profiles(id, email, full_name)
SELECT '8e000000-0000-0000-0000-000000000001', 'whonly-tester@elim.test', 'Warehouse Only Tester'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '8e000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '8e000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT '8e000000-0000-0000-0000-000000000001', 'accountant', f.id FROM factories f WHERE f.code = 'water';
INSERT INTO permission_overrides(user_id, module, action, granted) VALUES
  ('8e000000-0000-0000-0000-000000000001', 'distribution', 'create', false);
INSERT INTO user_page_access(user_id, page_id, granted) VALUES
  ('8e000000-0000-0000-0000-000000000001', 'Finance Overview', true);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: Warehouse role only, Warehouse pages only, can post
DO $$
DECLARE u uuid := '8e000000-0000-0000-0000-000000000001'; msg text;
BEGIN
  msg := public._warehouse_only_for('WHONLY-tester@elim.test');
  PERFORM pg_temp.check(msg LIKE '%only the Warehouse%', msg);
  PERFORM pg_temp.check((SELECT array_agg(role::text) FROM user_roles WHERE user_id = u) = ARRAY['store_officer'],
                        'Warehouse role only');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM permission_overrides WHERE user_id = u), 'overrides cleared');
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access WHERE user_id = u AND granted) = 8, '8 Warehouse pages');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM user_page_access WHERE user_id = u AND granted
                                     AND page_id NOT LIKE 'Warehouse › %'), 'nothing else allowed');
  PERFORM pg_temp.check((SELECT NOT granted FROM user_page_access WHERE user_id = u AND page_id = 'Finance Overview'),
                        'earlier page blocked');
  PERFORM pg_temp.check(public.has_permission(u, 'distribution'::module_key, 'create'::action_key)
                        AND public.has_permission(u, 'sales'::module_key, 'create'::action_key)
                        AND public.has_permission(u, 'distribution'::module_key, 'submit'::action_key),
                        'can post to marketers / retail, sell to distributors, log returns');
  msg := public._warehouse_only_for('whonly-tester@elim.test');
  PERFORM pg_temp.check((SELECT count(*) FROM user_roles WHERE user_id = u) = 1, 'idempotent');
  msg := public._warehouse_only_for('nobody@elim.test');
  PERFORM pg_temp.check(msg LIKE 'Skipped: 0 accounts%', msg);
END $$;
