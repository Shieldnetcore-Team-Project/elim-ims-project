-- ============================================================================
-- Dashboard for Oladayo and Austin
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-23): Oladayo and Austin (account
-- "aniaustin") get the Dashboard page. For each account only -- no role is
-- changed:
--   * the Dashboard right is switched on (permission_overrides, view);
--   * the Dashboard page is allowed in their page access.
-- What the Dashboard shows follows their role as for everyone else; the
-- figures on it are still limited by their other rights.
--
-- Applied per account when exactly one non-admin account matches the name
-- or email; otherwise nothing changes for it and a notice says why (give the
-- page in Admin Panel → Users → Page access instead). Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._grant_dashboard_for(p_match text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
BEGIN
  SELECT count(*) INTO v_count FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF v_count <> 1 THEN
    RETURN format('Skipped: %s accounts match "%s" -- give the Dashboard in Admin Panel → Users', v_count, p_match);
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RETURN format('Skipped: %s is an Admin / Chairman and already has the Dashboard', v_name);
  END IF;

  INSERT INTO permission_overrides (user_id, module, action, granted)
  VALUES (v_user, 'dashboard'::module_key, 'view'::action_key, true)
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();
  INSERT INTO user_page_access (user_id, page_id, granted)
  VALUES (v_user, 'Dashboard', true)
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant_page', 'permission_overrides', v_user::text,
          jsonb_build_object('module', 'dashboard', 'page', 'Dashboard', 'granted', true,
                             'reason', format('Dashboard for %s (factory decision 2026-10-23)', v_name)));
  RETURN format('%s now has the Dashboard', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public._grant_dashboard_for(text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._grant_dashboard_for('oladayo');
  RAISE NOTICE '%', public._grant_dashboard_for('aniaustin');
END $$;
