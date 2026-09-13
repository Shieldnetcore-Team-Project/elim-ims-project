-- ============================================================================
-- ADMIN EDIT USER PROFILE (Users & Roles page)
-- ----------------------------------------------------------------------------
-- "update own profile" (20260721052758) only lets a user touch their own row,
-- so an admin editing someone else's name/phone/department/username/email had
-- no path that wasn't a raw table write. This RPC is that path -- same guard
-- style as set_production_scope() (20260819090000) on the same page: 'users'
-- edit permission, or super_admin.
--
-- Email/password are NOT handled here -- those live in auth.users, not
-- profiles, and can only be changed through the Supabase Admin API (service
-- role key, server-only). See adminUpdateUser() in src/lib/admin-users.ts,
-- which calls admin.auth.admin.updateUserById() first and then this RPC so
-- profiles.email (used for display and password-reset emails) stays in sync
-- with the real login email.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_update_profile(
  target_id uuid,
  p_full_name text,
  p_phone text DEFAULT NULL,
  p_department text DEFAULT NULL,
  p_username text DEFAULT NULL,
  p_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_before profiles%ROWTYPE;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_permission(v_uid, 'users'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_full_name IS NULL OR btrim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required';
  END IF;

  SELECT * INTO v_before FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  UPDATE profiles SET
    full_name = btrim(p_full_name),
    phone = NULLIF(btrim(COALESCE(p_phone, '')), ''),
    department = NULLIF(btrim(COALESCE(p_department, '')), ''),
    username = NULLIF(btrim(COALESCE(p_username, '')), ''),
    email = COALESCE(NULLIF(btrim(COALESCE(p_email, '')), ''), email)
  WHERE id = target_id;

  INSERT INTO audit_logs(user_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, 'admin_update_profile', 'profiles', target_id::text,
          jsonb_build_object('full_name', v_before.full_name, 'phone', v_before.phone,
                              'department', v_before.department, 'username', v_before.username,
                              'email', v_before.email),
          jsonb_build_object('full_name', btrim(p_full_name), 'phone', p_phone,
                              'department', p_department, 'username', p_username,
                              'email', COALESCE(NULLIF(btrim(COALESCE(p_email, '')), ''), v_before.email)));

  RETURN jsonb_build_object('updated', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_profile(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_profile(uuid, text, text, text, text, text) TO authenticated;
