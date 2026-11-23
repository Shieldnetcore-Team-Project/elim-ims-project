-- ============================================================================
-- Every account belongs to a factory: Kubwa or Lugbe
-- ----------------------------------------------------------------------------
-- The user (2026-11-23): a user is created under a factory, picked from a
-- dropdown (Kubwa Factory or Lugbe Factory), and the Users list shows it.
--
--   * profiles.active_factory_id is the account's home factory. Every account
--     made before today is in Kubwa (code 'water'); one with none gets Kubwa.
--   * my_factories(): the home factory always, listed first, so the app opens
--     in it. Kubwa is no longer automatic for everyone: a Lugbe account sees
--     Lugbe only, unless an Admin also allows Kubwa in Admin > Factory. The
--     Chairman and Admin still open every factory.
--   * _works_in_factory(): also true in the home factory, a factory an Admin
--     allowed (factory_access), and for the Chairman/Admin, so a person
--     allowed into the other factory can post there too.
--   * set_user_factory(): Admin moves an account to the other factory (its
--     factory-tied roles move with it). Audit-logged.
--   * admin_provision_user(): no factory picked = Kubwa.
-- Safe to run again.
-- ============================================================================

-- 1. Every account has a home factory ----------------------------------------
UPDATE public.profiles p
   SET active_factory_id = (SELECT id FROM public.factories WHERE code = 'water')
 WHERE p.active_factory_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.factories f WHERE f.id = p.active_factory_id);

-- 2. The factories the signed-in account may open, home factory first --------
CREATE OR REPLACE FUNCTION public.my_factories()
RETURNS TABLE (id uuid, code text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH home AS (
    SELECT COALESCE(
             (SELECT p.active_factory_id FROM public.profiles p WHERE p.id = auth.uid()),
             (SELECT f.id FROM public.factories f WHERE f.code = 'water')) AS id
  )
  SELECT f.id, f.code, f.name
    FROM public.factories f, home h
   WHERE f.id = h.id
      OR public.is_factory_switcher(auth.uid())
      OR EXISTS (SELECT 1 FROM public.factory_access a
                  WHERE a.user_id = auth.uid() AND a.factory_id = f.id)
   ORDER BY (f.id <> h.id), (f.code <> 'water'), f.name;
$$;
GRANT EXECUTE ON FUNCTION public.my_factories() TO authenticated;

-- 3. Who may post in a factory ------------------------------------------------
CREATE OR REPLACE FUNCTION public._works_in_factory(p_user uuid, p_factory uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_user IS NOT NULL
     AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = p_user)
     AND (
       p_factory IS NULL
       OR EXISTS (SELECT 1 FROM user_roles ur
                   WHERE ur.user_id = p_user AND (ur.factory_id IS NULL OR ur.factory_id = p_factory))
       OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = p_user AND p.active_factory_id = p_factory)
       OR EXISTS (SELECT 1 FROM factory_access a WHERE a.user_id = p_user AND a.factory_id = p_factory)
       OR public.is_factory_switcher(p_user)
     );
$$;
REVOKE ALL ON FUNCTION public._works_in_factory(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._works_in_factory(uuid, uuid) TO authenticated;

-- 4. Admin moves an account to another factory --------------------------------
CREATE OR REPLACE FUNCTION public.set_user_factory(_user_id uuid, _factory_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old uuid;
BEGIN
  IF NOT (public.is_factory_switcher(v_uid)
          OR public.has_permission(v_uid, 'account-approvals'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Only the Chairman or Admin can change an account''s factory';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM factories WHERE id = _factory_id) THEN
    RAISE EXCEPTION 'Unknown factory';
  END IF;

  SELECT active_factory_id INTO v_old FROM profiles WHERE id = _user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_old IS NOT DISTINCT FROM _factory_id THEN RETURN; END IF;

  UPDATE profiles
     SET active_factory_id = _factory_id,
         requested_factory_id = _factory_id
   WHERE id = _user_id;

  -- Factory-tied roles go with the account (a duplicate is dropped first).
  DELETE FROM user_roles ur
   WHERE ur.user_id = _user_id AND ur.factory_id IS NOT NULL AND ur.factory_id <> _factory_id
     AND EXISTS (SELECT 1 FROM user_roles w
                  WHERE w.user_id = ur.user_id AND w.role = ur.role AND w.factory_id = _factory_id);
  UPDATE user_roles SET factory_id = _factory_id
   WHERE user_id = _user_id AND factory_id IS NOT NULL AND factory_id <> _factory_id;

  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, _factory_id, 'set_user_factory', 'profiles', _user_id::text,
          jsonb_build_object('factory_id', v_old), jsonb_build_object('factory_id', _factory_id));
END;
$$;
REVOKE ALL ON FUNCTION public.set_user_factory(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_user_factory(uuid, uuid) TO authenticated;

-- 5. New accounts: the picked factory, else Kubwa -----------------------------
-- As 20260911090000, with the Kubwa default.
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

  IF v_profile.status <> 'pending' THEN
    RAISE EXCEPTION 'This account is already provisioned (status: %)', v_profile.status;
  END IF;

  v_factory := COALESCE(p_factory_id, v_profile.requested_factory_id,
                        (SELECT id FROM factories WHERE code = 'water'));

  UPDATE profiles SET
    status = 'active',
    created_by = v_uid,
    approved_by = v_uid,
    approved_at = now(),
    role_requested = p_role,
    department = COALESCE(p_department, department),
    requested_factory_id = v_factory,
    active_factory_id = v_factory,
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
            'factory_id', v_factory,
            'production_scope', COALESCE(p_production_scope, v_profile.production_scope)
          ));

  RETURN jsonb_build_object('status', 'active', 'role', p_role);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_provision_user(uuid, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_provision_user(uuid, text, text, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
