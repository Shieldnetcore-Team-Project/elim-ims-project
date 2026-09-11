-- ============================================================================
-- ADMIN-CREATED ACCOUNTS
-- ----------------------------------------------------------------------------
-- Until now the only way into the system was self-registration (auth.signUp on
-- the login page) followed by approve_user(). That path always sends mail, and
-- Supabase's built-in mailer caps auth email at a couple of messages an hour --
-- which is what "email rate limit exceeded" was. It also makes onboarding a
-- two-party dance: the user registers, then waits for an admin.
--
-- New path: an admin fills in the account details, the server creates the
-- auth.users row through the Admin API with a password and email already
-- confirmed (see src/lib/admin-users.ts -- service-role key, server-only, never
-- in the browser), handle_new_user() drops the usual 'pending' profile via
-- trigger, and this RPC finishes the job in one guarded transaction. No email
-- is sent at any point, so there is no rate limit and no cap on how many
-- accounts can be created. The user signs in immediately with the credentials
-- the admin hands them.
--
-- profiles.created_by was added in 20260816093000 as "new, nullable,
-- unpopulated today" -- this is what finally populates it, and what makes the
-- "Admin-created" vs "Self-registered" label on the Account Approvals page
-- mean something.
--
-- Guard, cast and grant all follow the house pattern: account-approvals:write
-- (same as approve_user), '...'::module_key to dodge the has_permission
-- overload ambiguity fixed in 20260826093000, and REVOKE FROM PUBLIC because
-- Postgres hands EXECUTE to PUBLIC by default at CREATE FUNCTION time.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_provision_user(
  target_id uuid,
  p_role text,
  p_department text DEFAULT NULL,
  p_factory_id uuid DEFAULT NULL,
  p_production_scope text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
  v_factory uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  IF p_role IS NULL OR trim(p_role) = '' THEN
    RAISE EXCEPTION 'A role must be selected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM roles WHERE slug = p_role) THEN
    RAISE EXCEPTION 'Unknown role: %', p_role;
  END IF;
  IF p_production_scope IS NOT NULL AND p_production_scope NOT IN ('NYLON','WATER','BOTH') THEN
    RAISE EXCEPTION 'Invalid production scope: %', p_production_scope;
  END IF;

  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  -- This only ever finishes provisioning a brand-new account. Refusing anything
  -- already past 'pending' stops it becoming a side door for re-roling or
  -- reinstating a live user, which belongs to approve_user/set_user_status and
  -- the maker-checker role-grant flow.
  IF v_profile.status <> 'pending' THEN
    RAISE EXCEPTION 'This account is already provisioned (status: %)', v_profile.status;
  END IF;

  v_factory := COALESCE(p_factory_id, v_profile.requested_factory_id);

  UPDATE profiles SET
    status = 'active',
    created_by = v_uid,
    approved_by = v_uid,
    approved_at = now(),
    role_requested = p_role,
    department = COALESCE(p_department, department),
    requested_factory_id = COALESCE(p_factory_id, requested_factory_id),
    active_factory_id = COALESCE(p_factory_id, active_factory_id),
    production_scope = COALESCE(p_production_scope, production_scope),
    rejected_by = NULL, rejected_reason = NULL, rejected_at = NULL
  WHERE id = target_id;

  INSERT INTO user_roles (user_id, role, factory_id)
  VALUES (target_id, p_role, v_factory)
  ON CONFLICT (user_id, role, factory_id) DO NOTHING;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_factory, 'Account created',
          'An administrator created your account. Sign in with the email and password you were given.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'admin_create_user', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status),
          jsonb_build_object(
            'status', 'active',
            'role', p_role,
            'email', v_profile.email,
            'production_scope', COALESCE(p_production_scope, v_profile.production_scope)
          ));

  RETURN jsonb_build_object('status', 'active', 'role', p_role);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_provision_user(uuid, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_provision_user(uuid, text, text, uuid, text) TO authenticated;
