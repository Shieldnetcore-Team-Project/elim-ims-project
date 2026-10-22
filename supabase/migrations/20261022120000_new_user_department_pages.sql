-- ============================================================================
-- New accounts start with their department's page only
-- ----------------------------------------------------------------------------
-- A new account used to get every page its role allows. Now an account an
-- admin creates (admin_provision_user) or approves from a self-signup
-- (approve_user) gets only its department's page(s); the admin grants more
-- in Roles & Permissions → Page access, as before.
--
-- Pages live in the menu definition (src/lib/nav.ts), not the database, so
-- the app works out which pages the department gets (defaultPageAccess in
-- src/lib/page-access.ts) and passes the lists here right after creating or
-- approving the account:
--   p_granted        the department's pages     -> user_page_access granted
--   p_blocked        every other page            -> user_page_access blocked
--   p_view_modules   the granted pages' modules  -> a view override when the
--                    role doesn't already give it, so the page loads its data
--                    (the same thing ticking a page in Page access does)
-- They are ordinary user_page_access rows, so Page access shows them as
-- Granted / Blocked and "Reset to role default" removes them.
--
-- Only a brand-new account: active, approved in the last hour, approved or
-- created exactly once, with one role and no page decisions yet. So it can't
-- be used to restrict an existing user, and re-approving or giving an existing
-- user another role never wipes pages an admin granted. Admin and Chairman
-- accounts are left alone. Same right as creating/approving the account.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_default_page_access(
  target_id uuid,
  p_granted text[],
  p_blocked text[],
  p_view_modules text[] DEFAULT '{}'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
  v_module text;
  v_rows integer;
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT * INTO v_profile FROM profiles WHERE id = target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  -- Not a brand-new account (or an Admin / Chairman): nothing changes.
  IF public._is_owner_level(target_id)
     OR v_profile.status <> 'active'
     OR v_profile.approved_at IS NULL
     OR v_profile.approved_at < now() - interval '1 hour'
     OR (SELECT count(*) FROM audit_logs
          WHERE entity = 'profiles' AND entity_id = target_id::text
            AND action IN ('approve_user', 'admin_create_user')) <> 1
     OR (SELECT count(*) FROM user_roles WHERE user_id = target_id) <> 1
     OR EXISTS (SELECT 1 FROM user_page_access WHERE user_id = target_id) THEN
    RETURN 0;
  END IF;

  INSERT INTO user_page_access(user_id, page_id, granted)
  SELECT target_id, p, true FROM (SELECT DISTINCT unnest(p_granted) AS p) g
   WHERE btrim(p) <> ''
  UNION ALL
  SELECT target_id, p, false FROM (SELECT DISTINCT unnest(p_blocked) AS p) b
   WHERE btrim(p) <> '' AND p <> ALL (COALESCE(p_granted, '{}'));
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Permission management is never handed out by default (only an Admin or
  -- the Chairman may grant it).
  FOR v_module IN SELECT DISTINCT unnest(p_view_modules) LOOP
    IF v_module <> 'permissions'
       AND NOT public.has_permission(target_id, v_module::module_key, 'view'::action_key) THEN
      INSERT INTO permission_overrides(user_id, module, action, granted, granted_by)
      VALUES (target_id, v_module::module_key, 'view'::action_key, true, v_uid)
      ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_by = v_uid;
    END IF;
  END LOOP;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_default_page_access(uuid, text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_default_page_access(uuid, text[], text[], text[]) TO authenticated;
