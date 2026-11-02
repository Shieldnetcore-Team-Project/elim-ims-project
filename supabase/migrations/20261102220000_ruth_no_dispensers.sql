-- ============================================================================
-- Ruth: no Dispenser+Water on her Production page
-- ----------------------------------------------------------------------------
-- User (2026-11-02): "take off dispenser+Water from Ruth production page,
-- she's not assigned to stock it or release it, is for Gideon".
--
-- Ruth gets a product rule (user_product_rules, 20261101140000) for every
-- product EXCEPT the dispensers -- names without "dispenser" or "jug" (Dispenser+Water, Dispenser Jug, Jug Water):
--   ^(?!.*(dispenser|jug))
-- Her Production page and Products Report then leave the dispensers out (the
-- product dropdowns, the batch list, the report on screen); printed and
-- downloaded reports still list every product. Her other pages are as they
-- were.
--
-- Applied when exactly one non-admin account matches "ruth" by name or email
-- (as 20261027150000); otherwise nothing changes and a notice says why. Needs
-- 20261101140000 first. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_pattern constant text := '^(?!.*(dispenser|jug))';
BEGIN
  IF to_regclass('public.user_product_rules') IS NULL THEN
    RAISE EXCEPTION 'Run 20261101140000_warehouse_product_assignments.sql first (it creates user_product_rules), then this again';
  END IF;
  v_count := (SELECT count(*) FROM profiles p WHERE p.full_name ILIKE '%ruth%' OR p.email ILIKE '%ruth%');
  IF v_count <> 1 THEN
    RAISE NOTICE 'Skipped: % accounts match "ruth" -- set her products by hand', v_count;
    RETURN;
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%ruth%' OR p.email ILIKE '%ruth%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RAISE NOTICE 'Skipped: % is an Admin / Chairman -- not limited', v_name;
    RETURN;
  END IF;

  DELETE FROM user_product_rules WHERE user_id = v_user;
  INSERT INTO user_product_rules(user_id, name_pattern, label)
  VALUES (v_user, v_pattern, 'Every product except Dispenser+Water and Dispenser Jug');
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), NULL, 'set_product_rules', 'user_product_rules', v_user::text,
          jsonb_build_object('who', v_name, 'patterns', jsonb_build_array(v_pattern),
                             'reason', 'Dispensers are Gideon''s; not on Ruth''s Production page'));
  RAISE NOTICE '% no longer sees the dispensers on Production (printed reports still list everything)', v_name;
END $$;
