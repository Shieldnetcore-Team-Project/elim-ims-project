-- ============================================================================
-- Tests: staff account security (20261018110000). Same harness as
-- marketer_accountability_test.sql: every migration applied, auth.uid()
-- reads the 'test.uid' setting. Blocks that test what a browser can do run
-- as the real `authenticated` role, so table grants and RLS apply.
-- Never run against production.
-- ============================================================================
RESET ROLE;
SELECT set_config('test.uid', '', false);

-- expect_error: run p_sql and require it to fail with a message like p_like.
CREATE OR REPLACE FUNCTION public.t_expect_error(p_sql text, p_like text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE p_like THEN RETURN; END IF;
    RAISE EXCEPTION 'ASSERTION FAILED: % -- wrong error: %', p_sql, SQLERRM;
  END;
  RAISE EXCEPTION 'ASSERTION FAILED: expected an error from: %', p_sql;
END; $$;
CREATE OR REPLACE FUNCTION public.t_check(p_ok boolean, p_msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END; $$;
GRANT EXECUTE ON FUNCTION public.t_expect_error(text, text), public.t_check(boolean, text) TO authenticated;

-- Roles for delegated managers.
INSERT INTO roles(slug, label, is_system) VALUES
  ('t_approvals_mgr', 'Test account approvals', false),
  ('t_perms_mgr', 'Test permissions manager', false),
  ('t_delete_approver', 'Test delete approver', false),
  ('t_clerk', 'Test clerk', false);
INSERT INTO role_permissions(role, module, action) VALUES
  ('t_approvals_mgr', 'account-approvals', 'create'), ('t_approvals_mgr', 'account-approvals', 'edit'),
  ('t_approvals_mgr', 'users', 'edit'),
  ('t_perms_mgr', 'permissions', 'view'), ('t_perms_mgr', 'permissions', 'edit'), ('t_perms_mgr', 'permissions', 'create'),
  ('t_delete_approver', 'delete-requests', 'approve'),
  ('t_clerk', 'sales', 'view');

-- Users (handle_new_user gives each a pending profile).
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
  ('e5000000-0000-0000-0000-000000000001', 'owner@sec', '{}'),
  ('e5000000-0000-0000-0000-000000000002', 'approvals@sec', '{}'),
  ('e5000000-0000-0000-0000-000000000003', 'perms@sec', '{}'),
  ('e5000000-0000-0000-0000-000000000004', 'clerk@sec', '{}'),
  ('e5000000-0000-0000-0000-000000000005', 'deleter1@sec', '{}'),
  ('e5000000-0000-0000-0000-000000000006', 'deleter2@sec', '{}'),
  ('e5000000-0000-0000-0000-000000000007', 'pending@sec', '{"role_requested":"cashier"}'),
  ('e5000000-0000-0000-0000-000000000008', 'sneaky@sec', '{"role_requested":"super_admin"}'),
  ('e5000000-0000-0000-0000-000000000009', 'chair@sec', '{"role_requested":"chairman"}');
UPDATE profiles SET status = 'active', production_scope = 'WATER'
 WHERE id IN ('e5000000-0000-0000-0000-000000000001','e5000000-0000-0000-0000-000000000002','e5000000-0000-0000-0000-000000000003',
              'e5000000-0000-0000-0000-000000000004','e5000000-0000-0000-0000-000000000005','e5000000-0000-0000-0000-000000000006');
INSERT INTO user_roles(user_id, role) VALUES
  ('e5000000-0000-0000-0000-000000000001', 'super_admin'),
  ('e5000000-0000-0000-0000-000000000002', 't_approvals_mgr'),
  ('e5000000-0000-0000-0000-000000000003', 't_perms_mgr'),
  ('e5000000-0000-0000-0000-000000000004', 't_clerk'),
  ('e5000000-0000-0000-0000-000000000005', 't_delete_approver'),
  ('e5000000-0000-0000-0000-000000000006', 't_delete_approver');

-- @@ A user can change only their avatar and username on their own profile
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000004', false);
UPDATE profiles SET username = 'clerk', avatar_url = 'x' WHERE id = 'e5000000-0000-0000-0000-000000000004';
SELECT public.t_expect_error($q$UPDATE profiles SET production_scope = 'BOTH' WHERE id = 'e5000000-0000-0000-0000-000000000004'$q$, '%permission denied%');
SELECT public.t_expect_error($q$UPDATE profiles SET status = 'active', role_requested = 'super_admin' WHERE id = 'e5000000-0000-0000-0000-000000000004'$q$, '%permission denied%');
SELECT public.t_expect_error($q$UPDATE profiles SET email = 'x@y' WHERE id = 'e5000000-0000-0000-0000-000000000004'$q$, '%permission denied%');
SELECT public.t_expect_error($q$INSERT INTO profiles(id) VALUES (gen_random_uuid())$q$, '%permission denied%');
SELECT public.t_expect_error($q$INSERT INTO user_roles(user_id, role) VALUES ('e5000000-0000-0000-0000-000000000004', 'super_admin')$q$, '%permission denied%');
RESET ROLE;
SELECT public.t_check((SELECT username = 'clerk' AND production_scope = 'WATER' FROM profiles WHERE id = 'e5000000-0000-0000-0000-000000000004'), 'own avatar/username saved, scope untouched');

-- @@ Signup metadata can't request the Admin or Chairman role
RESET ROLE;
SELECT public.t_check((SELECT role_requested FROM profiles WHERE id = 'e5000000-0000-0000-0000-000000000007') = 'cashier', 'ordinary request kept');
SELECT public.t_check((SELECT role_requested IS NULL FROM profiles WHERE id = 'e5000000-0000-0000-0000-000000000008'), 'super_admin request dropped');
SELECT public.t_check((SELECT role_requested IS NULL FROM profiles WHERE id = 'e5000000-0000-0000-0000-000000000009'), 'chairman request dropped');

-- @@ A suspended user loses permissions granted by override
RESET ROLE;
SELECT set_config('test.uid', '', false);
INSERT INTO permission_overrides(user_id, module, action, granted) VALUES ('e5000000-0000-0000-0000-000000000004', 'expenses', 'approve', true);
SELECT public.t_check(public.has_permission('e5000000-0000-0000-0000-000000000004'::uuid, 'expenses'::module_key, 'approve'::action_key), 'override works while active');
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000001', false);
SELECT public.set_user_status('e5000000-0000-0000-0000-000000000004', 'suspended');
SELECT public.t_check(NOT public.has_permission('e5000000-0000-0000-0000-000000000004'::uuid, 'expenses'::module_key, 'approve'::action_key), 'override ignored once suspended');
SELECT public.t_check(NOT public.has_permission('e5000000-0000-0000-0000-000000000004'::uuid, 'sales'::module_key, 'view'::action_key), 'role permission gone too');
-- Reinstate for later tests.
SELECT public.set_user_status('e5000000-0000-0000-0000-000000000004', 'active');
SELECT set_config('test.uid', '', false);
INSERT INTO user_roles(user_id, role) VALUES ('e5000000-0000-0000-0000-000000000004', 't_clerk');

-- @@ A delegated account manager can't create or touch an Admin
RESET ROLE;
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000002', false);
SELECT public.t_expect_error($q$SELECT public.admin_provision_user('e5000000-0000-0000-0000-000000000008', 'super_admin')$q$, '%Admin or Chairman role%');
SELECT public.t_expect_error($q$SELECT public.approve_user('e5000000-0000-0000-0000-000000000009', 'chairman')$q$, '%Admin or Chairman role%');
SELECT public.t_expect_error($q$SELECT public.set_user_status('e5000000-0000-0000-0000-000000000001', 'suspended')$q$, '%Admin or Chairman account%');
SELECT public.t_expect_error($q$SELECT public.delete_user_account('e5000000-0000-0000-0000-000000000001')$q$, '%Admin or Chairman%');
SELECT public.t_expect_error($q$SELECT public.admin_update_profile('e5000000-0000-0000-0000-000000000001', 'Renamed')$q$, '%Admin or Chairman account%');
SELECT public.t_expect_error($q$SELECT public.set_user_status('e5000000-0000-0000-0000-000000000002', 'suspended')$q$, '%own account%');
SELECT public.t_check(NOT public.can_manage_account('e5000000-0000-0000-0000-000000000001'), 'may not change an admin login');
SELECT public.t_check(public.can_manage_account('e5000000-0000-0000-0000-000000000004'), 'may change a clerk login');
RESET ROLE;
SELECT public.t_check(public.has_role('e5000000-0000-0000-0000-000000000001', 'super_admin'), 'admin untouched');
SELECT public.t_check((SELECT status FROM profiles WHERE id = 'e5000000-0000-0000-0000-000000000001') = 'active', 'admin still active');

-- @@ The same manager can still run ordinary accounts
RESET ROLE;
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000002', false);
SELECT public.approve_user('e5000000-0000-0000-0000-000000000007', 'cashier');
SELECT public.admin_provision_user('e5000000-0000-0000-0000-000000000008', 't_clerk');
SELECT public.admin_update_profile('e5000000-0000-0000-0000-000000000004', 'Clerk Renamed');
SELECT public.set_user_status('e5000000-0000-0000-0000-000000000008', 'suspended');
SELECT public.t_check(public.has_role('e5000000-0000-0000-0000-000000000007', 'cashier'), 'approved as cashier');
SELECT public.t_check((SELECT full_name FROM profiles WHERE id = 'e5000000-0000-0000-0000-000000000004') = 'Clerk Renamed', 'clerk renamed');
SELECT public.t_check(NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = 'e5000000-0000-0000-0000-000000000008'), 'suspended clerk has no role');

-- @@ A delegated permissions manager can't raise their own access
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000003', false);
SELECT public.t_expect_error($q$INSERT INTO permission_overrides(user_id, module, action, granted) VALUES ('e5000000-0000-0000-0000-000000000003', 'account-approvals', 'create', true)$q$, '%own permissions%');
SELECT public.t_expect_error($q$INSERT INTO permission_overrides(user_id, module, action, granted) VALUES ('e5000000-0000-0000-0000-000000000004', 'permissions', 'edit', true)$q$, '%permission management%');
SELECT public.t_expect_error($q$INSERT INTO permission_overrides(user_id, module, action, granted) VALUES ('e5000000-0000-0000-0000-000000000001', 'sales', 'view', false)$q$, '%Admin or Chairman account%');
SELECT public.t_expect_error($q$INSERT INTO role_permissions(role, module, action) VALUES ('t_perms_mgr', 'account-approvals', 'create')$q$, '%role you hold%');
SELECT public.t_expect_error($q$DELETE FROM role_permissions WHERE role = 'chairman'$q$, '%Admin or Chairman role%');
-- Granting someone else ordinary access still works.
INSERT INTO permission_overrides(user_id, module, action, granted) VALUES ('e5000000-0000-0000-0000-000000000004', 'customers', 'view', true);
INSERT INTO role_permissions(role, module, action) VALUES ('t_clerk', 'customers', 'view');
RESET ROLE;
SELECT public.t_check(public.has_permission('e5000000-0000-0000-0000-000000000004'::uuid, 'customers'::module_key, 'view'::action_key), 'ordinary grant applied');

-- @@ A delegated delete approver can't approve their own request
RESET ROLE;
SELECT set_config('test.uid', '', false);
INSERT INTO delete_requests(id, table_name, entity_id, entity_label, module, reason, requested_by) VALUES
  ('e5100000-0000-0000-0000-000000000001', 'vehicles', gen_random_uuid(), 'Van 1', 'logistics', 'sold', 'e5000000-0000-0000-0000-000000000005'),
  ('e5100000-0000-0000-0000-000000000002', 'vehicles', gen_random_uuid(), 'Van 2', 'logistics', 'sold', 'e5000000-0000-0000-0000-000000000005');
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000005', false);
SELECT public.t_expect_error($q$SELECT public.approve_delete('e5100000-0000-0000-0000-000000000001')$q$, '%requested yourself%');
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000006', false);
SELECT public.approve_delete('e5100000-0000-0000-0000-000000000001');
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000001', false);
SELECT public.approve_delete('e5100000-0000-0000-0000-000000000002');
SELECT public.t_check((SELECT bool_and(review_status = 'approved') FROM delete_requests WHERE id::text LIKE 'e51%'), 'both approved by someone else');

-- @@ Admins keep full control, but the last owner can't be removed
RESET ROLE;
SELECT set_config('test.uid', 'e5000000-0000-0000-0000-000000000001', false);
-- Admin switching their own role to Chairman (delete + insert in one call).
SELECT public.admin_set_user_role('e5000000-0000-0000-0000-000000000001', 'chairman');
SELECT public.t_check(public.has_role('e5000000-0000-0000-0000-000000000001', 'chairman'), 'now chairman');
SELECT public.admin_set_user_role('e5000000-0000-0000-0000-000000000001', 'super_admin');
SELECT public.admin_update_profile('e5000000-0000-0000-0000-000000000002', 'Approvals Renamed');
SELECT public.t_expect_error($q$SELECT public.set_user_status('e5000000-0000-0000-0000-000000000001', 'suspended')$q$, '%own account%');
-- Remove every owner role at once: refused at commit.
DO $$
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  DELETE FROM user_roles WHERE role IN ('super_admin', 'chairman');
  RAISE EXCEPTION 'ASSERTION FAILED: removing every owner was allowed';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%must remain%' THEN RAISE; END IF;
END $$;
SELECT public.t_check(public.has_role('e5000000-0000-0000-0000-000000000001', 'super_admin'), 'owner still there');
