-- ============================================================================
-- Every Quality Control tab for Grand Joy (QC manager)
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-26): Grand Joy, the QC manager, gets all of
-- Quality Control: Received from Store, Preforms, Purchase Orders,
-- Inspections, Old & New Jugs, Good bottles, Bottle tracking and Reports.
--
-- Those tabs hang off three pages (src/lib/nav.ts → Quality Control):
--   Quality Control › Inspections      goods-receiving   Received from Store,
--                                                        Purchase Orders,
--                                                        Inspections, Old & New Jugs
--   Quality Control › Good bottles     preform-production Preforms, Good bottles
--   Quality Control › Bottle tracking  distribution      Bottle tracking
-- and Reports shows with Inspections or Good bottles. For her account only --
-- no role is changed: each page is allowed in her page access and its
-- module's view right is switched on (permission_overrides). What she may do
-- on each tab beyond viewing still follows her role.
--
-- Applied when exactly one non-admin account matches the name or email;
-- otherwise nothing changes and a notice says why (give the pages in Admin
-- Panel → Users → Page access instead). Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._grant_qc_pages_for(p_match text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
  v_page record;
BEGIN
  SELECT count(*) INTO v_count FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF v_count <> 1 THEN
    RETURN format('Skipped: %s accounts match "%s" -- give the Quality Control pages in Admin Panel → Users', v_count, p_match);
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RETURN format('Skipped: %s is an Admin / Chairman and already has every page', v_name);
  END IF;

  FOR v_page IN
    SELECT * FROM (VALUES
      ('Quality Control › Inspections', 'goods-receiving'),
      ('Quality Control › Good bottles', 'preform-production'),
      ('Quality Control › Bottle tracking', 'distribution')) AS x(page_id, module)
  LOOP
    INSERT INTO permission_overrides (user_id, module, action, granted)
    VALUES (v_user, v_page.module::module_key, 'view'::action_key, true)
    ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();
    INSERT INTO user_page_access (user_id, page_id, granted)
    VALUES (v_user, v_page.page_id, true)
    ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();
  END LOOP;

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant_page', 'permission_overrides', v_user::text,
          jsonb_build_object('pages', jsonb_build_array('Quality Control › Inspections', 'Quality Control › Good bottles',
                                                        'Quality Control › Bottle tracking'),
                             'granted', true,
                             'reason', format('All Quality Control tabs for %s, QC manager (factory decision 2026-10-26)', v_name)));
  RETURN format('%s now has every Quality Control tab', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public._grant_qc_pages_for(text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._grant_qc_pages_for('grand joy');
END $$;
