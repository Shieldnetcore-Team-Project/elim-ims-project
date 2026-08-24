-- ============================================================================
-- ROLES TABLE + role_type CONVERSION (enum -> text)
-- ----------------------------------------------------------------------------
-- Converts app_role from a fixed 12-value Postgres ENUM into real data
-- (public.roles), so a super_admin can create/rename/describe roles from the
-- UI without a code deploy. user_roles.role / role_permissions.role /
-- role_grant_requests.role / profiles.role_requested all move from `app_role`
-- to plain `text`. has_role()/approve_user()/request_role_grant()/
-- request_role_revoke() each change a parameter's TYPE (not just add one),
-- which Postgres treats as "cannot change parameter type via CREATE OR
-- REPLACE" for some signatures and "silently create an ambiguous second
-- overload" for others -- every one of those is preceded by an explicit
-- DROP FUNCTION IF EXISTS on its exact prior signature so exactly one
-- version of each exists afterward.
--
-- Ordering, all deliberate:
--   1. Column type conversions FIRST (app_role -> text) -- has_role()'s new
--      text-typed body needs user_roles.role to already be text, or
--      `role = _role` compares app_role = text with no such operator.
--   2. has_role() drop/recreate SECOND, before anything below references it.
--      4 existing RLS policies (permission_overrides x2, role_permissions,
--      workflow_configs) call it DIRECTLY in their USING/WITH CHECK clause,
--      which Postgres tracks as a hard dependency (unlike calls from inside
--      a plpgsql function body, which aren't tracked) -- a bare DROP
--      FUNCTION fails against those, so they're explicitly dropped and
--      recreated around it instead of reaching for CASCADE.
--   3. public.roles table + seed THIRD (its own RLS policies call the now-
--      fixed has_role()).
--   4. FKs from the converted columns to roles(slug) LAST, once the table
--      has data to satisfy them.
-- ============================================================================

-- ============ 1. Convert role-typed columns from app_role -> text ============
ALTER TABLE public.user_roles ALTER COLUMN role TYPE text USING role::text;
ALTER TABLE public.role_permissions ALTER COLUMN role TYPE text USING role::text;
ALTER TABLE public.role_grant_requests ALTER COLUMN role TYPE text USING role::text;
ALTER TABLE public.profiles ALTER COLUMN role_requested TYPE text USING role_requested::text;

-- ============ 2. has_role(): app_role -> text ============
DROP POLICY IF EXISTS "permission overrides read own" ON public.permission_overrides;
DROP POLICY IF EXISTS "role permissions write" ON public.role_permissions;
DROP POLICY IF EXISTS "permission overrides write" ON public.permission_overrides;
DROP POLICY IF EXISTS "workflow configs write" ON public.workflow_configs;

DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, text) TO authenticated;

CREATE POLICY "permission overrides read own" ON public.permission_overrides FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "role permissions write" ON public.role_permissions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "permission overrides write" ON public.permission_overrides FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "workflow configs write" ON public.workflow_configs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- ============ 3. public.roles ============
CREATE TABLE IF NOT EXISTS public.roles (
  slug text PRIMARY KEY,
  label text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);
GRANT SELECT ON public.roles TO anon, authenticated;
GRANT ALL ON public.roles TO service_role;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

-- SELECT is open to anon too: the pre-login signup page (src/routes/index.tsx)
-- reads this table to populate its role dropdown, same reasoning as the
-- existing anon grants on profiles/factories in 20260722160000_open_access_to_anon.sql.
DROP POLICY IF EXISTS "roles read" ON public.roles;
CREATE POLICY "roles read" ON public.roles FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "roles write" ON public.roles;
CREATE POLICY "roles write" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

DROP POLICY IF EXISTS "roles update" ON public.roles;
CREATE POLICY "roles update" ON public.roles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

-- Can't delete a system role, ever -- this clause is the entire guard.
-- (Deleting a role still assigned to someone is additionally blocked by the
-- FK on user_roles.role added below, as defense in depth.)
DROP POLICY IF EXISTS "roles delete" ON public.roles;
CREATE POLICY "roles delete" ON public.roles FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') AND NOT is_system);

-- Seed the 12 existing roles 1:1, labels copied verbatim from ROLE_LABELS in
-- src/lib/permissions.ts. All system roles -- undeletable from the UI.
INSERT INTO public.roles (slug, label, is_system) VALUES
  ('super_admin', 'Super Admin / CEO', true),
  ('chairman', 'Chairman', true),
  ('accountant', 'Accountant / Finance', true),
  ('cashier', 'Cashier', true),
  ('sales', 'Sales', true),
  ('production', 'Production', true),
  ('inventory_officer', 'Inventory Officer', true),
  ('store_officer', 'Store Officer', true),
  ('costing_officer', 'Costing Officer', true),
  ('logistics', 'Logistics', true),
  ('hr', 'HR', true),
  ('payroll_officer', 'Payroll Officer', true)
ON CONFLICT (slug) DO NOTHING;

-- ============ 4. FKs from the converted columns to roles(slug) ============
-- role_grant_requests is deliberately left WITHOUT an FK -- it's append-only
-- audit history and shouldn't be orphaned by a later role rename/delete.
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_fkey FOREIGN KEY (role) REFERENCES public.roles(slug);
ALTER TABLE public.role_permissions
  ADD CONSTRAINT role_permissions_role_fkey FOREIGN KEY (role) REFERENCES public.roles(slug) ON DELETE CASCADE;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_requested_fkey FOREIGN KEY (role_requested) REFERENCES public.roles(slug) ON DELETE SET NULL;

-- ============ 5. approve_user(): role param -> text, status vocabulary,
-- and a new optional department param so a super_admin can set Role +
-- Department in one action (per the User Management spec). ============
DROP FUNCTION IF EXISTS public.approve_user(uuid, public.app_role);
CREATE OR REPLACE FUNCTION public.approve_user(target_id uuid, granted_role text DEFAULT NULL, p_department text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
  v_role text;
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  v_role := COALESCE(granted_role, v_profile.role_requested);
  IF v_role IS NULL THEN RAISE EXCEPTION 'A role must be selected to approve this account'; END IF;
  IF NOT EXISTS (SELECT 1 FROM roles WHERE slug = v_role) THEN RAISE EXCEPTION 'Unknown role: %', v_role; END IF;

  UPDATE profiles SET
    status = 'active',
    department = COALESCE(p_department, department),
    approved_by = v_uid,
    approved_at = now(),
    rejected_by = NULL, rejected_reason = NULL, rejected_at = NULL
  WHERE id = target_id;

  INSERT INTO user_roles (user_id, role, factory_id)
  VALUES (target_id, v_role, v_profile.requested_factory_id)
  ON CONFLICT (user_id, role, factory_id) DO NOTHING;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id, 'Account approved', 'Your account has been approved. You can now log in.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'approve_user', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status),
          jsonb_build_object('status', 'active', 'role', v_role));

  RETURN jsonb_build_object('status', 'active', 'role', v_role);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_user(uuid, text, text) TO authenticated;

-- ============ 6. request_role_grant() / request_role_revoke(): role param -> text ============
DROP FUNCTION IF EXISTS public.request_role_grant(uuid, public.app_role, uuid);
CREATE OR REPLACE FUNCTION public.request_role_grant(p_target_user_id uuid, p_role text, p_factory_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_target_user_id) THEN RAISE EXCEPTION 'Target user not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM roles WHERE slug = p_role) THEN RAISE EXCEPTION 'Unknown role: %', p_role; END IF;

  INSERT INTO role_grant_requests(target_user_id, role, factory_id, action, requested_by, status)
  VALUES (p_target_user_id, p_role, p_factory_id, 'grant', v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action('users', v_id, 'submit', NULL, 'pending_approval', 'Grant: ' || p_role);
  RETURN jsonb_build_object('id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_role_grant(uuid, text, uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.request_role_revoke(uuid, public.app_role, uuid);
CREATE OR REPLACE FUNCTION public.request_role_revoke(p_user_id uuid, p_role text, p_factory_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_user_id AND role = p_role AND factory_id IS NOT DISTINCT FROM p_factory_id) THEN
    RAISE EXCEPTION 'Role assignment not found';
  END IF;

  INSERT INTO role_grant_requests(target_user_id, role, factory_id, action, requested_by, status)
  VALUES (p_user_id, p_role, p_factory_id, 'revoke', v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action('users', v_id, 'submit', NULL, 'pending_approval', 'Revoke: ' || p_role);
  RETURN jsonb_build_object('id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_role_revoke(uuid, text, uuid) TO authenticated;

-- ============ 7. handle_new_user(): drop the ::app_role cast, 'approved' -> 'active' ============
-- Trigger signature is unchanged (still RETURNS trigger, no params) so a
-- plain CREATE OR REPLACE is fine here -- no DROP needed.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  user_count int;
  is_first boolean;
  default_factory uuid;
  requested_factory uuid;
BEGIN
  SELECT count(*) INTO user_count FROM auth.users;
  is_first := user_count <= 1;

  SELECT id INTO default_factory FROM public.factories WHERE code = 'water' LIMIT 1;
  requested_factory := NULLIF(NEW.raw_user_meta_data->>'requested_factory_id','')::uuid;

  INSERT INTO public.profiles (
    id, full_name, email, phone, username, department, role_requested,
    requested_factory_id, active_factory_id, status, approved_by, approved_at
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.email,
    NEW.raw_user_meta_data->>'phone',
    NEW.raw_user_meta_data->>'username',
    NEW.raw_user_meta_data->>'department',
    NULLIF(NEW.raw_user_meta_data->>'role_requested',''),
    requested_factory,
    COALESCE(requested_factory, default_factory),
    CASE WHEN is_first THEN 'active' ELSE 'pending' END,
    CASE WHEN is_first THEN NEW.id ELSE NULL END,
    CASE WHEN is_first THEN now() ELSE NULL END
  );

  IF is_first THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'super_admin');
  END IF;

  RETURN NEW;
END;
$$;

-- ============ 8. profiles.created_by (new, nullable, unpopulated today) ============
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

-- ============ 9. get_all_users_last_login(): expose auth.users.last_sign_in_at
-- without needing a service-role key -- SECURITY DEFINER runs as the table
-- owner, which can read auth.users directly. ============
CREATE OR REPLACE FUNCTION public.get_all_users_last_login()
RETURNS TABLE(id uuid, last_sign_in_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'super_admin') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY SELECT u.id, u.last_sign_in_at FROM auth.users u;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_all_users_last_login() TO authenticated;

-- ============ 10. Drop the now-unused enum type ============
-- No CASCADE: if anything above was missed, this fails loudly instead of
-- silently dropping a dependent object.
DROP TYPE IF EXISTS public.app_role;
