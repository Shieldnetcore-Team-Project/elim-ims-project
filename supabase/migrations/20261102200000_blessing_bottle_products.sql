-- ============================================================================
-- Blessing (bottle production): sees bottle products only
-- ----------------------------------------------------------------------------
-- User (2026-11-02): "isolate the activity so that bottle production can not
-- see dispenser and sachet activity but printing report will be printing all
-- products, just like we did in the warehouse".
--
-- Blessing, the production manager who posts the bottle batches, gets the
-- same product rule as Kemi in the Warehouse (user_product_rules,
-- 20261101140000): names containing "bottle water". The Production page and
-- its Products Report then show her only those products on screen; printed
-- and downloaded reports still list every product. Grand Joy (dispensers) is
-- not limited. Admins and the Chairman never are.
--
-- Applied when exactly one non-admin account matches "blessing" by name or
-- email; otherwise nothing changes and a notice says why. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
BEGIN
  -- Needs the product rules from 20261101140000_warehouse_product_assignments.
  IF to_regclass('public.user_product_rules') IS NULL THEN
    RAISE EXCEPTION 'Run 20261101140000_warehouse_product_assignments.sql first (it creates user_product_rules), then this again';
  END IF;
  v_count := (SELECT count(*) FROM profiles p
               WHERE p.full_name ILIKE '%blessing%' OR p.email ILIKE '%blessing%');
  IF v_count <> 1 THEN
    RAISE NOTICE 'Skipped: % accounts match "blessing" -- set her products by hand', v_count;
    RETURN;
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%blessing%' OR p.email ILIKE '%blessing%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RAISE NOTICE 'Skipped: % is an Admin / Chairman -- not limited', v_name;
    RETURN;
  END IF;

  DELETE FROM user_product_rules WHERE user_id = v_user;
  INSERT INTO user_product_rules(user_id, name_pattern, label)
  VALUES (v_user, 'bottle water', 'Bottle Water (all sizes)');
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), NULL, 'set_product_rules', 'user_product_rules', v_user::text,
          jsonb_build_object('who', v_name, 'patterns', jsonb_build_array('bottle water'),
                             'reason', 'Bottle production sees bottle products only'));
  RAISE NOTICE '% now sees bottle products only (printed reports still list everything)', v_name;
END $$;
