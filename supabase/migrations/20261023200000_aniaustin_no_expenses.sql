-- ============================================================================
-- aniaustin (Ustin): no Expenses page
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-23): Austin no longer works Expenses. His
-- Store & Warehouse role (20261021130000) included Expenses; this takes it
-- away from his account only -- the role is left as it is:
--   * every Expenses right is switched off for him (permission_overrides,
--     granted = false), so the database refuses expenses for him too;
--   * the Expenses page is blocked in his page access, so it leaves his menu.
-- An admin can give it back in Admin Panel → Users → Page access /
-- Permissions. Expenses he already raised stay on record.
--
-- Applied when exactly one non-admin account matches "aniaustin" by name or
-- email; otherwise nothing changes and a notice says why. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._no_expenses_for(p_match text)
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
    RETURN format('Skipped: %s accounts match "%s" -- remove Expenses in Admin Panel → Users', v_count, p_match);
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RETURN format('Skipped: %s is an Admin / Chairman -- not changed', v_name);
  END IF;

  -- Every Expenses right off.
  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, 'expenses'::module_key, a, false
    FROM unnest(ARRAY['view','create','edit','delete','submit','approve','reject','confirm','post','reverse',
                      'cancel','export','print']::action_key[]) AS a
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = false, granted_at = now();

  -- The page out of his menu.
  INSERT INTO user_page_access (user_id, page_id, granted)
  VALUES (v_user, 'Expenses', false)
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = false, granted_at = now();

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'remove_page', 'permission_overrides', v_user::text,
          jsonb_build_object('module', 'expenses', 'page', 'Expenses', 'granted', false,
                             'reason', format('No Expenses for %s (factory decision 2026-10-23)', v_name)));
  RETURN format('%s no longer has the Expenses page', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public._no_expenses_for(text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._no_expenses_for('aniaustin');
END $$;
