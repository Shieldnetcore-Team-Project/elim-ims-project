-- ============================================================================
-- Ruth: bottle water only (by her email)
-- ----------------------------------------------------------------------------
-- User (2026-11-04): Ruth (ruthyebom@gmail.com) saw Dispenser Jug+Water in
-- the production hall and the Good jugs from QC -- her product rule from
-- 20261102220000 was never set (that script matched her by name and skips
-- when not exactly one account matches). Set here by her email: bottle water
-- of every size, nothing else. Safe to run again.
-- ============================================================================

DO $$
DECLARE v_user uuid; v_name text;
BEGIN
  SELECT id, COALESCE(full_name, email) INTO v_user, v_name FROM profiles
   WHERE lower(btrim(email)) = 'ruthyebom@gmail.com';
  IF v_user IS NULL THEN
    RAISE NOTICE 'No account with ruthyebom@gmail.com -- nothing changed';
    RETURN;
  END IF;
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RAISE NOTICE '% is an Admin / Chairman -- not limited', v_name;
    RETURN;
  END IF;
  DELETE FROM user_product_rules WHERE user_id = v_user;
  INSERT INTO user_product_rules(user_id, name_pattern, label)
  VALUES (v_user, 'bottle water', 'Bottle Water (all sizes)');
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), NULL, 'set_product_rules', 'user_product_rules', v_user::text,
          jsonb_build_object('who', v_name, 'patterns', jsonb_build_array('bottle water'),
                             'reason', 'Ruth makes bottle water only (2026-11-04)'));
  RAISE NOTICE '% now sees bottle water only', v_name;
END $$;
