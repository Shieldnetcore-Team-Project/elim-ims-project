-- ============================================================================
-- Acceptance tests: new accounts start with their department's page only
-- (20261022120000_new_user_department_pages.sql)
--
-- Same harness as user_page_access_test.sql (supabase/tests/pglite/README.md).
-- Uses its own factory and users; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fd000000-0000-0000-0000-000000000001', 'dptest', 'Department Pages Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('ad000000-0000-0000-0000-000000000001', 'admin@dp'),
  ('ad000000-0000-0000-0000-000000000002', 'new@dp'),
  ('ad000000-0000-0000-0000-000000000003', 'old@dp'),
  ('ad000000-0000-0000-0000-000000000004', 'boss@dp'),
  ('ad000000-0000-0000-0000-000000000005', 'clerk@dp'),
  ('ad000000-0000-0000-0000-000000000006', 'signup@dp');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'ad000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
UPDATE profiles SET status = 'pending', approved_at = NULL
 WHERE id IN ('ad000000-0000-0000-0000-000000000002', 'ad000000-0000-0000-0000-000000000006');
UPDATE profiles SET status = 'active', approved_at = now() - interval '60 days'
 WHERE id IN ('ad000000-0000-0000-0000-000000000003', 'ad000000-0000-0000-0000-000000000004',
              'ad000000-0000-0000-0000-000000000005');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('ad000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('ad000000-0000-0000-0000-000000000003', 'production', 'fd000000-0000-0000-0000-000000000001'),
  ('ad000000-0000-0000-0000-000000000004', 'chairman', NULL),
  ('ad000000-0000-0000-0000-000000000005', 'production', 'fd000000-0000-0000-0000-000000000001');
INSERT INTO audit_logs(user_id, action, entity, entity_id)
VALUES ('ad000000-0000-0000-0000-000000000001', 'approve_user', 'profiles', 'ad000000-0000-0000-0000-000000000003');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: an admin-created account gets its department's page granted and every other page blocked
SET ROLE authenticated;
DO $$
DECLARE n uuid := 'ad000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000001', false);
  PERFORM admin_provision_user(n, 'production', 'Sales', 'fd000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(NOT has_permission(n, 'sales'::module_key, 'view'::action_key), 'production role has no sales view of its own');
  PERFORM pg_temp.check(apply_default_page_access(n, ARRAY['Retail › Sales & POS'],
                          ARRAY['Dashboard', 'Production › Production', 'Retail › Sales & POS'],
                          ARRAY['sales', 'permissions']) = 3, 'three rows written');
  PERFORM pg_temp.check((SELECT granted FROM user_page_access WHERE user_id = n AND page_id = 'Retail › Sales & POS'), 'department page granted');
  PERFORM pg_temp.check(NOT (SELECT granted FROM user_page_access WHERE user_id = n AND page_id = 'Dashboard'), 'dashboard blocked');
  PERFORM pg_temp.check(NOT (SELECT granted FROM user_page_access WHERE user_id = n AND page_id = 'Production › Production'),
                        'the role''s own page blocked too');
  PERFORM pg_temp.check(has_permission(n, 'sales'::module_key, 'view'::action_key), 'sales view granted so the page loads');
  PERFORM pg_temp.check(NOT has_permission(n, 'sales'::module_key, 'create'::action_key), 'only view, not work');
  PERFORM pg_temp.check(NOT has_permission(n, 'permissions'::module_key, 'view'::action_key), 'permission management is never given by default');

  -- A retry, or a second call, changes nothing.
  PERFORM pg_temp.check(apply_default_page_access(n, ARRAY['Dashboard'], ARRAY[]::text[]) = 0, 'second call is a no-op');
  PERFORM pg_temp.check(NOT (SELECT granted FROM user_page_access WHERE user_id = n AND page_id = 'Dashboard'), 'still blocked');
END $$;
RESET ROLE;

-- @@ Test 2: a self-signup gets it on approval; a role added later doesn't wipe anything
SET ROLE authenticated;
DO $$
DECLARE s uuid := 'ad000000-0000-0000-0000-000000000006';
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000001', false);
  PERFORM approve_user(s, 'accountant', 'Finance & Accounts');
  PERFORM pg_temp.check(apply_default_page_access(s, ARRAY['Finance Overview'], ARRAY['Dashboard'], ARRAY['finance']) = 2,
                        'approved signup gets its defaults');
  -- Approved again later (e.g. with another role): nothing is reset.
  PERFORM approve_user(s, 'sales', NULL);
  PERFORM pg_temp.check(apply_default_page_access(s, ARRAY['Retail › Sales & POS'], ARRAY['Finance Overview'], ARRAY['sales']) = 0,
                        'a second approval leaves the pages alone');
  PERFORM pg_temp.check((SELECT granted FROM user_page_access WHERE user_id = s AND page_id = 'Finance Overview'), 'finance still granted');
END $$;
RESET ROLE;

-- @@ Test 3: existing users and Admin / Chairman accounts are not touched
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(apply_default_page_access('ad000000-0000-0000-0000-000000000003', ARRAY['Finance Overview'], ARRAY['Dashboard']) = 0,
                        'an existing user is not restricted');
  PERFORM pg_temp.check(apply_default_page_access('ad000000-0000-0000-0000-000000000004', ARRAY['Finance Overview'], ARRAY['Dashboard']) = 0,
                        'the chairman is not restricted');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM user_page_access
                          WHERE user_id IN ('ad000000-0000-0000-0000-000000000003', 'ad000000-0000-0000-0000-000000000004')),
                        'no rows for them');
END $$;
RESET ROLE;

-- @@ Test 4: only someone who may approve accounts can call it
SET ROLE authenticated;
DO $$
DECLARE n uuid := 'ad000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000005', false);
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT apply_default_page_access(%L, ARRAY['Dashboard'], ARRAY[]::text[])$q$, n))
                        LIKE '%Insufficient permissions%', 'a clerk cannot call it');
END $$;
RESET ROLE;
