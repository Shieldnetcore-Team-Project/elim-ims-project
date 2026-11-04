-- ============================================================================
-- Acceptance tests: per-account Production rights make a Store recipient
-- (20261104170000_ranshak_store_recipient.sql)
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9800000-0000-0000-0000-000000000001', 'rsfac', 'RS Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a9800000-0000-0000-0000-000000000001', 'admin@rs'),
  ('a9800000-0000-0000-0000-000000000002', 'pm@rs'),
  ('a9800000-0000-0000-0000-000000000003', 'clerk@rs');
DELETE FROM user_roles WHERE user_id::text LIKE 'a9800000-%';
INSERT INTO user_roles(user_id, role) VALUES ('a9800000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a9800000-0000-0000-0000-000000000002', 'sales', 'f9800000-0000-0000-0000-000000000001'),
  ('a9800000-0000-0000-0000-000000000003', 'sales', 'f9800000-0000-0000-0000-000000000001');
INSERT INTO permission_overrides(user_id, module, action, granted) VALUES
  ('a9800000-0000-0000-0000-000000000002', 'production', 'submit', true);
UPDATE profiles SET status = 'active' WHERE id::text LIKE 'a9800000-%';
SELECT set_config('test.uid', 'a9800000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the PM with per-account Production rights is offered; others are not
DO $$
BEGIN
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.issue_recipients('f9800000-0000-0000-0000-000000000001')
                                 WHERE id = 'a9800000-0000-0000-0000-000000000002' AND department = 'production'),
                        'PM listed under Production');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.issue_recipients('f9800000-0000-0000-0000-000000000001')
                                     WHERE id IN ('a9800000-0000-0000-0000-000000000003', 'a9800000-0000-0000-0000-000000000001')),
                        'a clerk and the admin are not');
END $$;
