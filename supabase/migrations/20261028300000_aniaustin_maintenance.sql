-- ============================================================================
-- Austin runs the Maintenance page
-- ----------------------------------------------------------------------------
-- User decision (2026-10-28): Austin (account "aniaustin") gets the
-- Maintenance page (permission module 'logistics'): parts inventory, stock in
-- and out, adjustments, the maintenance log, requests and their purchases,
-- and the vehicles register. For his account only -- no role is changed:
--   * every Maintenance right is switched on (permission_overrides);
--   * the Maintenance page is allowed in his page access.
-- Taking stock out (an issue, parts used on a log entry, or lowering a count)
-- waits for approval, and decide_maintenance_issue() /
-- decide_maintenance_request() don't let anyone but an admin approve their
-- own: what Austin raises goes to the Admin.
--
-- Applied when exactly one non-admin account matches; otherwise nothing
-- changes and a notice says why (give the page in Admin Panel → Users →
-- Page access instead). Needs 20261028290000_maintenance_page.sql first.
-- Safe to run again.
-- ============================================================================
DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
BEGIN
  SELECT count(*) INTO v_count FROM profiles p
   WHERE p.full_name ILIKE '%aniaustin%' OR p.email ILIKE '%aniaustin%';
  IF v_count <> 1 THEN
    RAISE NOTICE 'Skipped: % accounts match "aniaustin" -- give Maintenance in Admin Panel → Users', v_count;
    RETURN;
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%aniaustin%' OR p.email ILIKE '%aniaustin%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RAISE NOTICE 'Skipped: % is an Admin / Chairman and already has Maintenance', v_name;
    RETURN;
  END IF;

  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, 'logistics'::module_key, a::action_key, true
    FROM unnest(ARRAY['view','create','edit','submit','approve','reject','cancel',
                      'delete','export','print']) AS a
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();
  INSERT INTO user_page_access (user_id, page_id, granted)
  VALUES (v_user, 'Maintenance', true)
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant_page', 'permission_overrides', v_user::text,
          jsonb_build_object('module', 'logistics', 'page', 'Maintenance', 'granted', true,
                             'reason', format('Maintenance for %s (user decision 2026-10-28)', v_name)));
  RAISE NOTICE '% now has Maintenance', v_name;
END $$;
