-- Lets a super admin set a user's global role in a single step from the
-- Admin Panel's Edit User dialog, instead of going through the
-- request_role_grant -> approve_role_grant -> post_role_grant maker-checker
-- chain (still in place and unused by this RPC -- see 20260816110000). The
-- maker-checker flow stays as the general path for everyone else; this is a
-- deliberately narrower, super-admin-only shortcut.
CREATE OR REPLACE FUNCTION public.admin_set_user_role(target_user_id uuid, new_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old_roles text[];
BEGIN
  IF NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Only a super admin can assign roles directly';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'Target user not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM roles WHERE slug = new_role) THEN
    RAISE EXCEPTION 'Unknown role: %', new_role;
  END IF;

  SELECT coalesce(array_agg(role), '{}') INTO v_old_roles
  FROM user_roles WHERE user_id = target_user_id AND factory_id IS NULL;

  -- Factory-scoped roles (factory_id IS NOT NULL) are untouched -- this
  -- replaces only the user's global role, matching the single "Role"
  -- dropdown the Edit User dialog shows.
  DELETE FROM user_roles WHERE user_id = target_user_id AND factory_id IS NULL;
  INSERT INTO user_roles(user_id, role) VALUES (target_user_id, new_role)
    ON CONFLICT (user_id, role, factory_id) DO NOTHING;

  INSERT INTO audit_logs(user_id, action, entity, entity_id, old_value, new_value)
  VALUES (
    v_uid, 'admin_set_role', 'user_roles', target_user_id::text,
    jsonb_build_object('roles', v_old_roles),
    jsonb_build_object('role', new_role)
  );

  RETURN jsonb_build_object('set', true, 'role', new_role);
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid, text) TO authenticated;
