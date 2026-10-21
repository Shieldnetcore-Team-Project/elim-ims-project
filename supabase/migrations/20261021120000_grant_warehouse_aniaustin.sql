-- ============================================================================
-- Give aniaustin the Warehouse role
-- ----------------------------------------------------------------------------
-- Factory decision (2026-10-21): aniaustin works in the Warehouse -- every
-- Warehouse page (Stock, Store requests, Good bottles, Orders, Returns, Reps &
-- outlet stock, Dispenser & jugs, Bottle tracking, Customers) and sending Old
-- / New Jugs to Quality Control, who verify them and post the good ones to
-- the Production Manager (send_jugs_to_qc, 20261021100000).
--
-- That is the existing Warehouse role (slug store_officer). The role is ADDED:
-- any role the account already has is kept. Done only when exactly one
-- account matches "aniaustin" by name or email; otherwise nothing changes and
-- a notice says why -- assign the role in Admin Panel → Users instead.
-- ============================================================================

-- Adds p_role to the one account matching p_match (name or email). Returns
-- what it did; changes nothing unless exactly one account matches.
CREATE OR REPLACE FUNCTION public._grant_role_to_match(p_match text, p_role text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
  v_label text;
BEGIN
  SELECT label INTO v_label FROM roles WHERE slug = p_role;
  IF NOT FOUND THEN RETURN format('Skipped: role %s does not exist', p_role); END IF;
  SELECT count(*) INTO v_count FROM profiles p
   WHERE (p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%');
  IF v_count <> 1 THEN
    RETURN format('Skipped: %s accounts match "%s" -- assign the %s role in Admin Panel → Users', v_count, p_match, v_label);
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE (p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%');

  -- The factory they already work in; else the only factory there is.
  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  IF v_factory IS NULL AND (SELECT count(*) FROM factories) = 1 THEN
    SELECT id INTO v_factory FROM factories;
  END IF;
  IF v_factory IS NULL THEN
    RETURN format('Skipped: could not tell which factory %s works in -- assign the role in Admin Panel → Users', v_name);
  END IF;
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = v_user AND role = p_role AND factory_id = v_factory) THEN
    RETURN format('%s already has the %s role', v_name, v_label);
  END IF;

  INSERT INTO user_roles (user_id, role, factory_id) VALUES (v_user, p_role, v_factory);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'assign_role', 'user_roles', v_user::text,
          jsonb_build_object('role', p_role, 'factory_id', v_factory,
                             'reason', format('%s role added (factory decision 2026-10-21)', v_label)));
  RETURN format('%s now has the %s role', v_name, v_label);
END;
$$;
REVOKE ALL ON FUNCTION public._grant_role_to_match(text, text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._grant_role_to_match('aniaustin', 'store_officer');
END $$;
