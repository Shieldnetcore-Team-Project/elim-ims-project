-- ============================================================================
-- Production by product: Ruth bottles, Gideon dispensers and sachet
-- ----------------------------------------------------------------------------
-- User (2026-11-02): "ruth should not see sachet water, she's only handling
-- bottle water of all types, 35cl, 50cl and 75cl, she can stock and release
-- bottle water and then gideon should stock and release dispenser and
-- sachet water" (and Dispenser Jug is Gideon's too).
--
--   Ruth    product rule "bottle water" (every size), as Kemi and Blessing.
--           Her Production page and Products Report show bottle water only;
--           printed / downloaded reports still list every product.
--   Gideon  the Production page and the rights to record and release
--           batches (production view / create / submit, as Grand Joy,
--           20261031180000), and his rule from 20261101140000 kept:
--           "dispenser|jug water" and "sachet" -- Dispenser+Water, Dispenser
--           Jug, Jug Water and Sachet Water.
-- Replaces 20261102220000_ruth_no_dispensers (Ruth: everything but
-- dispensers) -- she now has bottle water only.
--
-- Ruth: exactly one non-admin account matching "ruth" (as 20261027150000).
-- Gideon: gideonsunday24@gmail.com (as 20261101140000). Otherwise that
-- person is skipped with a notice. Needs 20261101140000 first (the rules
-- table). Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
BEGIN
  IF to_regclass('public.user_product_rules') IS NULL THEN
    RAISE EXCEPTION 'Run 20261101140000_warehouse_product_assignments.sql first (it creates user_product_rules), then this again';
  END IF;

  -- ---- Ruth: bottle water only ----
  v_count := (SELECT count(*) FROM profiles p WHERE p.full_name ILIKE '%ruth%' OR p.email ILIKE '%ruth%');
  IF v_count <> 1 THEN
    RAISE NOTICE 'Ruth skipped: % accounts match "ruth" -- set her products by hand', v_count;
  ELSE
    SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
     WHERE p.full_name ILIKE '%ruth%' OR p.email ILIKE '%ruth%';
    IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
      RAISE NOTICE 'Ruth skipped: % is an Admin / Chairman -- not limited', v_name;
    ELSE
      DELETE FROM user_product_rules WHERE user_id = v_user;
      INSERT INTO user_product_rules(user_id, name_pattern, label)
      VALUES (v_user, 'bottle water', 'Bottle Water (all sizes)');
      INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
      VALUES (auth.uid(), NULL, 'set_product_rules', 'user_product_rules', v_user::text,
              jsonb_build_object('who', v_name, 'patterns', jsonb_build_array('bottle water'),
                                 'reason', 'Ruth stocks and releases bottle water only'));
      RAISE NOTICE '% now sees bottle water only on Production', v_name;
    END IF;
  END IF;

  -- ---- Gideon: Production page and rights, dispensers and sachet ----
  v_count := (SELECT count(*) FROM profiles WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com');
  IF v_count <> 1 THEN
    RAISE NOTICE 'Gideon skipped: % accounts have gideonsunday24@gmail.com', v_count;
    RETURN;
  END IF;
  v_user := (SELECT id FROM profiles WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com');
  v_name := (SELECT COALESCE(full_name, email) FROM profiles WHERE id = v_user);
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RAISE NOTICE 'Gideon skipped: % is an Admin / Chairman', v_name;
    RETURN;
  END IF;

  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, 'production'::module_key, a, true
    FROM unnest(ARRAY['view', 'create', 'submit']::action_key[]) AS a
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();
  INSERT INTO user_page_access (user_id, page_id, granted)
  VALUES (v_user, 'Production › Production', true)
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();

  DELETE FROM user_product_rules WHERE user_id = v_user;
  INSERT INTO user_product_rules(user_id, name_pattern, label) VALUES
    (v_user, 'dispenser|jug water', 'Dispenser / Jug Water'),
    (v_user, 'sachet', 'Sachet Water');

  v_factory := (SELECT factory_id FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant', 'permission_overrides', v_user::text,
          jsonb_build_object('module', 'production', 'actions', jsonb_build_array('view', 'create', 'submit'),
                             'page', 'Production › Production',
                             'products', jsonb_build_array('Dispenser / Jug Water', 'Sachet Water'),
                             'reason', format('%s stocks and releases dispensers and sachet water (2026-11-02)', v_name)));
  RAISE NOTICE '% can now record and release dispensers and sachet water on Production', v_name;
END $$;
