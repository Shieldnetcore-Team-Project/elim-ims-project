-- ============================================================================
-- Gideon: accept (or refuse) Production releases in the Warehouse -- again
-- ----------------------------------------------------------------------------
-- User report (2026-10-31): Joy released 857 Dispenser/Jug Water to the
-- Warehouse, but Gideon had no Accept button. The button (and
-- accept_production_release) needs production:confirm; refusing needs
-- production:reject. 20261028130000 gave him both as per-user rights, but
-- they are not in effect on the live system (not run there, or changed since
-- in the Admin Panel). Re-applied here, for his account only -- his role is
-- not widened. Prints his rights afterwards and the releases waiting.
--
-- Matches gideonsunday24@gmail.com, exactly one account; otherwise nothing
-- changes and a notice says why. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_factory uuid;
  v_r record;
BEGIN
  v_count := (SELECT count(*) FROM profiles WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com');
  IF v_count <> 1 THEN
    RAISE NOTICE 'Skipped: % accounts have gideonsunday24@gmail.com -- give him Production confirm/reject in Admin Panel -> Users', v_count;
    RETURN;
  END IF;
  v_user := (SELECT id FROM profiles WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com');

  INSERT INTO permission_overrides (user_id, module, action, granted) VALUES
    (v_user, 'production', 'confirm', true),
    (v_user, 'production', 'reject', true)
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();

  v_factory := (SELECT factory_id FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant_permission', 'permission_overrides', v_user::text,
          jsonb_build_object('rights', jsonb_build_array('production:confirm', 'production:reject'),
                             'reason', 'Gideon accepts Production releases (dispensers from Joy) in the Warehouse (2026-10-31)'));

  RAISE NOTICE 'Gideon: accept = %, refuse = %, see releases = %',
    public.has_permission(v_user, 'production'::module_key, 'confirm'::action_key),
    public.has_permission(v_user, 'production'::module_key, 'reject'::action_key),
    public.has_permission(v_user, 'production'::module_key, 'view'::action_key)
      OR public.has_permission(v_user, 'finished-goods'::module_key, 'view'::action_key);
  FOR v_r IN
    SELECT r.release_number, p.name, r.quantity, r.released_by_name, r.released_by = v_user AS by_him
      FROM production_releases r JOIN products p ON p.id = r.product_id
     WHERE r.status = 'pending' ORDER BY r.released_at
  LOOP
    RAISE NOTICE 'Waiting: % -- % x % (released by %)%', v_r.release_number, v_r.name, trim_scale(v_r.quantity),
      COALESCE(v_r.released_by_name, '?'), CASE WHEN v_r.by_him THEN ' -- released by Gideon himself, someone else must accept' ELSE '' END;
  END LOOP;
END $$;
