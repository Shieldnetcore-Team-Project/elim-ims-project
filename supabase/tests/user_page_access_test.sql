-- ============================================================================
-- Acceptance tests: per-user page access (20261021140000_user_page_access.sql)
--
-- Same harness as preform_inventory_test.sql (supabase/tests/pglite/README.md).
-- Uses its own factory and users; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fc000000-0000-0000-0000-000000000001', 'patest', 'Page Access Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('ac000000-0000-0000-0000-000000000001', 'admin@pa'),
  ('ac000000-0000-0000-0000-000000000002', 'worker@pa'),
  ('ac000000-0000-0000-0000-000000000003', 'other@pa');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'ac000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('ac000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('ac000000-0000-0000-0000-000000000002', 'production', 'fc000000-0000-0000-0000-000000000001'),
  ('ac000000-0000-0000-0000-000000000003', 'production', 'fc000000-0000-0000-0000-000000000001');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: an admin sets pages one by one; users read only their own; only admins write
SET ROLE authenticated;
DO $$
DECLARE w uuid := 'ac000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM set_config('test.uid', 'ac000000-0000-0000-0000-000000000001', false);
  INSERT INTO user_page_access(user_id, page_id, granted) VALUES
    (w, 'Production › Production', true),
    (w, 'Production › Products Report', false);
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access WHERE user_id = w) = 2, 'admin set two pages separately');
  PERFORM pg_temp.check((SELECT granted_by FROM user_page_access WHERE user_id = w AND page_id = 'Production › Production')
                        = 'ac000000-0000-0000-0000-000000000001', 'who granted it is kept');
  INSERT INTO user_page_access(user_id, page_id, granted) VALUES ('ac000000-0000-0000-0000-000000000003', 'Production › Production', false);

  -- The worker sees their own decisions, not someone else's, and cannot change them.
  PERFORM set_config('test.uid', w::text, false);
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access) = 2, 'worker reads only their own two rows');
  PERFORM pg_temp.check(pg_temp.err(format($q$INSERT INTO user_page_access(user_id, page_id, granted) VALUES (%L, 'Finance Overview', true)$q$, w)) IS NOT NULL,
                        'worker cannot grant themselves a page');
  UPDATE user_page_access SET granted = true WHERE user_id = w AND page_id = 'Production › Products Report';
  PERFORM pg_temp.check(NOT (SELECT granted FROM user_page_access WHERE user_id = w AND page_id = 'Production › Products Report'),
                        'worker cannot un-hide a page');
END $$;
RESET ROLE;

-- @@ Test 2: every change is in the audit log, and a deleted account takes its rows with it
DO $$
BEGIN
  PERFORM pg_temp.check((SELECT count(*) FROM audit_logs WHERE action = 'page_access'
                           AND entity_id = 'ac000000-0000-0000-0000-000000000002') = 2, 'both page changes audited');
  DELETE FROM auth.users WHERE id = 'ac000000-0000-0000-0000-000000000003';
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM user_page_access WHERE user_id = 'ac000000-0000-0000-0000-000000000003'),
                        'rows go with the account');
END $$;
