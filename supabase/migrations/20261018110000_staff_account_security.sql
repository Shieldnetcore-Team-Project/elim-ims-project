-- ============================================================================
-- Staff account security: close the ways a member of staff could raise their
-- own access or act on an account above theirs.
--
--  1. profiles: "update own profile" let a user rewrite every column of their
--     own row through the REST API -- production_scope (has_production_scope_
--     access() reads it, so WATER staff could give themselves NYLON), status,
--     role_requested (approve_user() defaults to it, so a pending account
--     could ask for super_admin and the Approve dialog pre-fills it),
--     approved_by, email... The app only ever writes avatar_url and username,
--     so those are now the only columns a user can update directly. Every
--     other change goes through the SECURITY DEFINER admin RPCs as before.
--     The anon grants from 20260722160000 (open_access_to_anon) are removed.
--  2. has_permission(): permission_overrides were honoured with or without a
--     role. set_user_status() suspends an account by deleting its user_roles,
--     so a suspended or deactivated user kept every override-granted
--     permission. No role now means no permission.
--  3. handle_new_user(): a signup can't put super_admin / chairman into
--     role_requested (supabase.auth.signUp takes arbitrary metadata).
--  4. user_roles / profiles guards: only an admin or the chairman can grant,
--     remove, edit, suspend or delete an Admin or Chairman account, nobody can
--     change their own roles, suspend or delete themselves, and the last
--     Admin/Chairman can't be removed. Done as triggers so every path is
--     covered -- approve_user, admin_provision_user, post_role_grant,
--     set_user_status, delete_user_account, admin_update_profile, ...
--  5. role_permissions / permission_overrides: someone delegated the
--     Permissions tab could grant themselves anything (including
--     account-approvals, then create an admin). Delegated managers now can't
--     touch their own grants, a role they hold, the Admin/Chairman roles, or
--     the Permissions module itself.
--  6. delete_requests: approve_delete() accepts delete-requests:approve since
--     20261014210000 but never checked who asked, so a delegated approver
--     could approve their own deletion. Same maker-checker rule as everywhere
--     else now.
--  7. can_manage_account(): lets the server functions in src/lib/admin-users.ts
--     check, before calling the Auth Admin API, that the caller may change the
--     target's email/password.
--
-- Calls made with no user (auth.uid() IS NULL: migrations, the auth trigger,
-- service-role maintenance) are not affected by any of the guards.
-- ============================================================================

-- ---------- helper: is this user an Admin or the Chairman? ----------
CREATE OR REPLACE FUNCTION public._is_owner_level(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = _user_id AND role IN ('super_admin', 'chairman')
  );
$$;
REVOKE ALL ON FUNCTION public._is_owner_level(uuid) FROM PUBLIC, anon, authenticated;

-- ============ 1. profiles: column lockdown ============
REVOKE ALL ON public.profiles FROM anon;
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (avatar_url, username) ON public.profiles TO authenticated;

-- handle_new_user() (SECURITY DEFINER) creates every profile; nobody inserts one.
DROP POLICY IF EXISTS "insert own profile" ON public.profiles;

DROP POLICY IF EXISTS "update own profile" ON public.profiles;
CREATE POLICY "update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

ALTER POLICY "read own profile" ON public.profiles TO authenticated;
ALTER POLICY "read team profiles" ON public.profiles TO authenticated;

-- user_roles is written only by SECURITY DEFINER RPCs. No client write policy
-- exists, but the table grants were still open to anon and authenticated.
REVOKE ALL ON public.user_roles FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated;
ALTER POLICY "read own roles" ON public.user_roles TO authenticated;

-- ============ 2. has_permission(): no role, no permission ============
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _module module_key, _action action_key DEFAULT 'view'::text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actions public.action_key[];
  v_result boolean;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;
  IF public.has_role(_user_id, 'super_admin') OR public.has_role(_user_id, 'chairman') THEN RETURN true; END IF;

  -- Pending, rejected, suspended and deactivated accounts have no user_roles
  -- row. Without this, their permission_overrides still granted access.
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id) THEN RETURN false; END IF;

  -- Legacy aliases resolve against a bucket of concrete actions so existing
  -- RLS policies/RPC guards calling has_permission(x,'read'/'write') keep
  -- working unchanged against the new fine-grained grants.
  v_actions := CASE _action
    WHEN 'read' THEN ARRAY['view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete']::public.action_key[]
    WHEN 'write' THEN ARRAY['create','edit','delete']::public.action_key[]
    ELSE ARRAY[_action]
  END;

  SELECT EXISTS (
    SELECT 1 FROM unnest(v_actions) AS a(action)
    WHERE COALESCE(
      (SELECT po.granted FROM public.permission_overrides po
        WHERE po.user_id = _user_id AND po.module = _module AND po.action = a.action),
      EXISTS (
        SELECT 1 FROM public.role_permissions rp
        JOIN public.user_roles ur ON ur.role = rp.role
        WHERE ur.user_id = _user_id AND rp.module = _module AND rp.action = a.action
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- ============ 3. handle_new_user(): no self-requested owner roles ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  user_count int;
  is_first boolean;
  default_factory uuid;
  requested_factory uuid;
  requested_role text;
BEGIN
  SELECT count(*) INTO user_count FROM auth.users;
  is_first := user_count <= 1;

  SELECT id INTO default_factory FROM public.factories WHERE code = 'water' LIMIT 1;
  requested_factory := NULLIF(NEW.raw_user_meta_data->>'requested_factory_id','')::uuid;

  -- Only a note for the approving admin, but approve_user() falls back to it
  -- and the Approve dialog pre-fills it, so the owner roles are never taken
  -- from signup metadata. Unknown roles would fail the FK, so drop those too.
  requested_role := NULLIF(NEW.raw_user_meta_data->>'role_requested','');
  IF requested_role IN ('super_admin', 'chairman')
     OR NOT EXISTS (SELECT 1 FROM public.roles WHERE slug = requested_role) THEN
    requested_role := NULL;
  END IF;

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
    requested_role,
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

-- Clear any owner role already sitting in a pending request.
UPDATE public.profiles SET role_requested = NULL
 WHERE status = 'pending' AND role_requested IN ('super_admin', 'chairman');

-- ============ 4a. user_roles guard ============
CREATE OR REPLACE FUNCTION public._user_roles_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  -- admin_set_user_role replaces a role as DELETE then INSERT. An Admin
  -- changing their own role (super_admin -> chairman) is no longer an owner
  -- by the time the INSERT runs, so remember for the rest of the transaction
  -- that they were one when it started.
  v_owner := public._is_owner_level(v_uid)
             OR current_setting('app.owner_actor', true) = v_uid::text;
  IF v_owner THEN PERFORM set_config('app.owner_actor', v_uid::text, true); END IF;

  -- Nobody but an Admin/Chairman changes their own roles. Even they can't
  -- remove the last owner role (trg_user_roles_keep_an_owner, at commit).
  IF (COALESCE(NEW.user_id, OLD.user_id) = v_uid OR (TG_OP = 'UPDATE' AND OLD.user_id = v_uid))
     AND NOT v_owner THEN
    RAISE EXCEPTION 'You cannot change your own roles';
  END IF;

  IF v_owner THEN RETURN COALESCE(NEW, OLD); END IF;

  IF (TG_OP IN ('UPDATE', 'DELETE') AND OLD.role IN ('super_admin', 'chairman'))
     OR (TG_OP IN ('INSERT', 'UPDATE') AND NEW.role IN ('super_admin', 'chairman')) THEN
    RAISE EXCEPTION 'Only an Admin or the Chairman can grant or remove the Admin or Chairman role';
  END IF;

  -- Removing or replacing any role of an Admin/Chairman account (e.g.
  -- suspending or deleting it) is theirs alone too.
  IF TG_OP IN ('UPDATE', 'DELETE') AND public._is_owner_level(OLD.user_id) THEN
    RAISE EXCEPTION 'Only an Admin or the Chairman can change an Admin or Chairman account';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public._user_roles_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_user_roles_guard ON public.user_roles;
CREATE TRIGGER trg_user_roles_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public._user_roles_guard();

-- Checked at commit, so admin_set_user_role's delete-then-insert of the same
-- role in one transaction is fine.
CREATE OR REPLACE FUNCTION public._user_roles_keep_an_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  IF OLD.role IN ('super_admin', 'chairman')
     AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role IN ('super_admin', 'chairman')) THEN
    RAISE EXCEPTION 'At least one Admin or Chairman account must remain';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._user_roles_keep_an_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_user_roles_keep_an_owner ON public.user_roles;
CREATE CONSTRAINT TRIGGER trg_user_roles_keep_an_owner
  AFTER UPDATE OR DELETE ON public.user_roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._user_roles_keep_an_owner();

-- ============ 4b. profiles guard ============
CREATE OR REPLACE FUNCTION public._profiles_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  IF OLD.id = v_uid THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'You cannot delete your own account';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'active' THEN
      RAISE EXCEPTION 'You cannot suspend or deactivate your own account';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT public._is_owner_level(v_uid) AND public._is_owner_level(OLD.id) THEN
    RAISE EXCEPTION 'Only an Admin or the Chairman can change an Admin or Chairman account';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public._profiles_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_guard ON public.profiles;
CREATE TRIGGER trg_profiles_guard
  BEFORE UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._profiles_guard();

-- ============ 5. role_permissions / permission_overrides guard ============
CREATE OR REPLACE FUNCTION public._permission_grants_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  r record;
BEGIN
  IF v_uid IS NULL OR public._is_owner_level(v_uid) THEN RETURN COALESCE(NEW, OLD); END IF;

  -- Check the row before and after the change: both must be fair game.
  FOR r IN SELECT * FROM (SELECT to_jsonb(OLD) AS j WHERE TG_OP <> 'INSERT'
                          UNION ALL SELECT to_jsonb(NEW) WHERE TG_OP <> 'DELETE') x LOOP
    IF r.j->>'module' = 'permissions' THEN
      RAISE EXCEPTION 'Only an Admin or the Chairman can grant access to permission management';
    END IF;
    IF TG_TABLE_NAME = 'permission_overrides' THEN
      IF (r.j->>'user_id')::uuid = v_uid THEN
        RAISE EXCEPTION 'You cannot change your own permissions';
      END IF;
      IF public._is_owner_level((r.j->>'user_id')::uuid) THEN
        RAISE EXCEPTION 'Only an Admin or the Chairman can change an Admin or Chairman account';
      END IF;
    ELSE
      IF r.j->>'role' IN ('super_admin', 'chairman') THEN
        RAISE EXCEPTION 'Only an Admin or the Chairman can change the Admin or Chairman role';
      END IF;
      IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_uid AND role = r.j->>'role') THEN
        RAISE EXCEPTION 'You cannot change the permissions of a role you hold';
      END IF;
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public._permission_grants_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_permission_overrides_guard ON public.permission_overrides;
CREATE TRIGGER trg_permission_overrides_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.permission_overrides
  FOR EACH ROW EXECUTE FUNCTION public._permission_grants_guard();

DROP TRIGGER IF EXISTS trg_role_permissions_guard ON public.role_permissions;
CREATE TRIGGER trg_role_permissions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public._permission_grants_guard();

-- ============ 6. delete_requests: no approving your own request ============
CREATE OR REPLACE FUNCTION public._delete_requests_maker_checker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.review_status = 'approved' AND OLD.review_status IS DISTINCT FROM 'approved'
     AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.requested_by
     AND NOT public._is_owner_level(NEW.reviewed_by) THEN
    RAISE EXCEPTION 'You cannot approve a deletion you requested yourself';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._delete_requests_maker_checker() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_delete_requests_maker_checker ON public.delete_requests;
CREATE TRIGGER trg_delete_requests_maker_checker
  BEFORE UPDATE OF review_status ON public.delete_requests
  FOR EACH ROW EXECUTE FUNCTION public._delete_requests_maker_checker();

-- ============ 7. can_manage_account() for the server functions ============
-- True when the caller may change the target's login (email/password): an
-- Admin/Chairman may change anyone; anyone else only accounts that are not
-- Admin/Chairman. The caller's own permission is checked separately.
CREATE OR REPLACE FUNCTION public.can_manage_account(target_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND public.is_staff_member()
     AND (public._is_owner_level(auth.uid()) OR NOT public._is_owner_level(target_id));
$$;
REVOKE ALL ON FUNCTION public.can_manage_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_account(uuid) TO authenticated;
