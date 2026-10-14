-- ============================================================================
-- Admin Panel: each tab is its own grantable permission
-- ----------------------------------------------------------------------------
-- The Admin Panel was one unit: the whole page needed `users`, and the Delete
-- Requests / Deleted Sales tabs (plus everything behind Permissions) were
-- hard-wired to super_admin/chairman. An admin couldn't hand someone just one
-- tab. Now every tab has a module of its own, grantable per role or per user
-- (Permissions -> Page access) like any other page:
--
--   Users            users               (existing)
--   Pending          account-approvals   (existing)
--   Delete Requests  delete-requests     (new)
--   Deleted Sales    deleted-sales       (new)
--   Permissions      permissions         (new) roles, role permissions,
--                                         per-user page access, workflows
--   Audit Log        audit-logs          (existing)
--   Factory          users               (a count of users per factory)
--   Auth Users       auth-users          (new)
--
-- The rules and functions behind those tabs that only accepted
-- super_admin/chairman now also accept the matching permission, so a granted
-- tab works rather than loading empty. super_admin and chairman keep
-- everything, and nobody gains access they didn't have before this migration.
--
-- Note: whoever is granted `permissions` (edit) can change any role's or
-- user's access, including their own -- grant it as you would admin rights.
-- ============================================================================

-- ============ 1. New module keys ============
ALTER DOMAIN public.module_key DROP CONSTRAINT IF EXISTS module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
  'finance','inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
  'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
  'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns',
  'delete-requests','deleted-sales','permissions','auth-users'
));

-- ============ 2. get_my_permissions(): include them ============
-- Same as 20260923190000, with the four new modules in the list.
CREATE OR REPLACE FUNCTION public.get_my_permissions()
 RETURNS TABLE(module module_key, action action_key)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_action public.action_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
    'finance','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns',
    'delete-requests','deleted-sales','permissions','auth-users'
  ]::public.module_key[];
  v_concrete_actions public.action_key[] := ARRAY[
    'view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete'
  ]::public.action_key[];
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman') THEN
    FOREACH v_module IN ARRAY v_modules LOOP
      FOREACH v_action IN ARRAY v_concrete_actions LOOP
        module := v_module; action := v_action; RETURN NEXT;
      END LOOP;
    END LOOP;
    RETURN;
  END IF;
  FOREACH v_module IN ARRAY v_modules LOOP
    FOREACH v_action IN ARRAY v_concrete_actions LOOP
      IF public.has_permission(v_uid, v_module, v_action) THEN
        module := v_module; action := v_action; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  RETURN;
END;
$function$;

-- ============ 3. Row-level rules behind the tabs ============
-- Delete Requests: see every request (requesters still see their own).
DROP POLICY IF EXISTS "delete requests read" ON public.delete_requests;
CREATE POLICY "delete requests read" ON public.delete_requests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR requested_by = auth.uid()
      OR public.has_permission(auth.uid(), 'delete-requests'::module_key, 'view'::action_key));

-- Deleted Sales: read soft-deleted sales.
DROP POLICY IF EXISTS "sales read deleted" ON public.sales;
CREATE POLICY "sales read deleted" ON public.sales FOR SELECT TO authenticated
  USING ((public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
          OR public.has_permission(auth.uid(), 'deleted-sales'::module_key, 'view'::action_key))
         AND deleted_at IS NOT NULL);

-- Permissions: roles, role permissions, per-user overrides, workflow set-up.
DROP POLICY IF EXISTS "permission overrides read own" ON public.permission_overrides;
CREATE POLICY "permission overrides read own" ON public.permission_overrides FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'view'::action_key));

DROP POLICY IF EXISTS "role permissions write" ON public.role_permissions;
CREATE POLICY "role permissions write" ON public.role_permissions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key));

DROP POLICY IF EXISTS "permission overrides write" ON public.permission_overrides;
CREATE POLICY "permission overrides write" ON public.permission_overrides FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key));

DROP POLICY IF EXISTS "workflow configs write" ON public.workflow_configs;
CREATE POLICY "workflow configs write" ON public.workflow_configs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key));

DROP POLICY IF EXISTS "roles write" ON public.roles;
CREATE POLICY "roles write" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'create'::action_key));

DROP POLICY IF EXISTS "roles update" ON public.roles;
CREATE POLICY "roles update" ON public.roles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
      OR public.has_permission(auth.uid(), 'permissions'::module_key, 'edit'::action_key));

-- A system role can still never be deleted.
DROP POLICY IF EXISTS "roles delete" ON public.roles;
CREATE POLICY "roles delete" ON public.roles FOR DELETE TO authenticated
  USING ((public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')
          OR public.has_permission(auth.uid(), 'permissions'::module_key, 'delete'::action_key))
         AND NOT is_system);

-- ============ 4. Functions behind Delete Requests / Deleted Sales ============
-- Each starts with an admin-only guard, written in slightly different ways
-- across migrations, e.g.
--   IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
--   IF NOT public.has_role(auth.uid(), 'super_admin') THEN
-- For every live version of each function, find that guard (any spacing,
-- v_uid or auth.uid(), with or without chairman) and add the matching
-- permission to it. Only the guard changes; CREATE OR REPLACE keeps owners
-- and grants. A function whose guard isn't recognised is left as it is and
-- reported -- it stays admin-only rather than blocking this migration.
DO $do$
DECLARE
  r record;
  p record;
  v_def text;
  v_new text;
  -- IF NOT ( has_role(X,'super_admin') [OR has_role(X,'chairman')] ) THEN   (parentheses optional)
  c_guard constant text :=
    'IF\s+NOT\s*\(?\s*(public\.)?has_role\(\s*(v_uid|auth\.uid\(\))\s*,\s*''super_admin''(::[a-z_]+)?\s*\)'
    || '(\s+OR\s+(public\.)?has_role\(\s*(v_uid|auth\.uid\(\))\s*,\s*''chairman''(::[a-z_]+)?\s*\))?\s*\)?\s*THEN';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('approve_delete',              'delete-requests', 'approve'),
      ('reject_delete',               'delete-requests', 'reject'),
      ('restore_sale',                'deleted-sales',   'edit'),
      ('purge_expired_deleted_sales', 'deleted-sales',   'delete')
    ) AS t(fn, module, action)
  LOOP
    FOR p IN
      SELECT pr.oid, pr.oid::regprocedure AS sig
        FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
       WHERE n.nspname = 'public' AND pr.proname = r.fn
    LOOP
      v_def := pg_get_functiondef(p.oid);
      IF v_def !~ c_guard THEN
        RAISE NOTICE 'Guard not recognised in %, left admin-only', p.sig;
        CONTINUE;
      END IF;
      v_new := regexp_replace(v_def, c_guard,
        format('IF NOT (public.has_role(auth.uid(), ''super_admin'') OR public.has_role(auth.uid(), ''chairman'') OR public.has_permission(auth.uid(), %L::module_key, %L::action_key)) THEN',
               r.module, r.action),
        'g');
      EXECUTE v_new;
      RAISE NOTICE '% now also accepts %:%', p.sig, r.module, r.action;
    END LOOP;
  END LOOP;
END
$do$;
