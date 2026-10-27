-- ============================================================================
-- Ruth: no Quality Control, Warehouse or Store pages
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-27): Ruth has nothing to do with Quality
-- Control, the Warehouse or the Store. For her account only -- no role is
-- changed and her other pages stay as they are:
--   * every Quality Control, Warehouse and Store page is blocked in her page
--     access, so they leave her menu.
-- An admin can give them back in Admin Panel → Users → Page access.
-- Records she already made stay on record.
--
-- Applied when exactly one non-admin account matches "ruth" by name or
-- email; otherwise nothing changes and a notice says why. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._no_qc_store_warehouse_for(p_match text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
  -- The Quality Control, Store and Warehouse pages (src/lib/nav.ts) as of
  -- this migration.
  v_pages constant text[] := ARRAY[
    'Quality Control › Inspections','Quality Control › Good bottles','Quality Control › Bottle tracking',
    'Store › Raw Materials','Store › Preform Inventory','Store › Requests','Store › Issue preforms',
    'Store › Issued out','Store › Brands',
    'Warehouse › Stock','Warehouse › Store requests','Warehouse › Orders','Warehouse › Returns',
    'Warehouse › Reps & outlet stock','Warehouse › Dispenser & jugs','Warehouse › Customers',
    'Warehouse › Finished Products'];
BEGIN
  SELECT count(*) INTO v_count FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF v_count <> 1 THEN
    RETURN format('Skipped: %s accounts match "%s" -- block the pages in Admin Panel → Users', v_count, p_match);
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RETURN format('Skipped: %s is an Admin / Chairman -- not changed', v_name);
  END IF;

  INSERT INTO user_page_access (user_id, page_id, granted)
  SELECT v_user, p, false FROM unnest(v_pages) AS p
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = false, granted_at = now();

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'remove_page', 'user_page_access', v_user::text,
          jsonb_build_object('pages', to_jsonb(v_pages), 'granted', false,
                             'reason', format('No Quality Control, Warehouse or Store for %s (factory decision 2026-10-27)', v_name)));
  RETURN format('%s no longer has the Quality Control, Warehouse or Store pages', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public._no_qc_store_warehouse_for(text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._no_qc_store_warehouse_for('ruth');
END $$;
