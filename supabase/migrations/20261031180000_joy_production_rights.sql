-- ============================================================================
-- Grand Joy: record dispenser production and post it to the Warehouse
-- ----------------------------------------------------------------------------
-- User (2026-10-31): Joy has the Production page to take stock of the filled
-- dispensers -- Dispenser/Jug Water (New Jug) / (Old Jug) -- and post them to
-- the Warehouse. For her account only, no role changed:
--   * Production rights view, create and submit (permission_overrides) --
--     create_production needs create; release_to_warehouse accepts create,
--     submit or edit (as Blessing, 20261027140000);
--   * the "Production › Production" page allowed in her page access. Her
--     Quality Control pages are not touched.
-- With 20261031170000 she also sees the finished products in the box.
--
-- Applied when exactly one non-admin account matches "grand joy" by name or
-- email; otherwise nothing changes and a notice says why. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
BEGIN
  v_count := (SELECT count(*) FROM profiles p
               WHERE p.full_name ILIKE '%grand joy%' OR p.email ILIKE '%grand joy%' OR p.email ILIKE '%grandjoy%');
  IF v_count <> 1 THEN
    RAISE NOTICE 'Skipped: % accounts match "grand joy" -- give her the Production rights in Admin Panel -> Users', v_count;
    RETURN;
  END IF;
  v_user := (SELECT p.id FROM profiles p
              WHERE p.full_name ILIKE '%grand joy%' OR p.email ILIKE '%grand joy%' OR p.email ILIKE '%grandjoy%');
  v_name := (SELECT COALESCE(p.full_name, p.email) FROM profiles p WHERE p.id = v_user);
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RAISE NOTICE 'Skipped: % is an Admin / Chairman -- already has every right', v_name;
    RETURN;
  END IF;

  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, 'production'::module_key, a, true
    FROM unnest(ARRAY['view','create','submit']::action_key[]) AS a
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();

  INSERT INTO user_page_access (user_id, page_id, granted)
  VALUES (v_user, 'Production › Production', true)
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();

  v_factory := (SELECT factory_id FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant', 'permission_overrides', v_user::text,
          jsonb_build_object('module', 'production', 'actions', jsonb_build_array('view', 'create', 'submit'),
                             'page', 'Production › Production',
                             'reason', format('%s records dispenser production and posts it to the Warehouse (2026-10-31)', v_name)));
  RAISE NOTICE '% can now record production and post it to the Warehouse', v_name;
END $$;
