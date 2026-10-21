-- ============================================================================
-- Warehouse Manager: post finished products to marketers, distributors and
-- the retail outlet -- nothing else
-- ----------------------------------------------------------------------------
-- New role 'warehouse_manager' (label "Warehouse Manager"). Narrower than the
-- Warehouse role (store_officer), which also confirms production, receives
-- goods, handles sales, returns and preforms. This one can:
--   dashboard        view
--   finished-goods   view, print, export     (Warehouse stock page; products
--                                             readable for the dispatch form)
--   distribution     view, create, submit, print, export
--                                            (Distribution page: dispatch stock
--                                             to marketers, distributors and the
--                                             retail outlet -- create_stock_dispatch)
-- It cannot cancel, reverse or confirm dispatches, or reach any other page.
-- Vehicle / driver / route on a dispatch are optional and stay hidden without
-- Logistics access. A super_admin can widen it in Role Management.
--
-- Then gives the role to Gideon (the factory's decision, 2026-10-21) as his
-- ONLY role, so he sees just the Warehouse and Distribution pages. Done only
-- when exactly one active account matches "gideon" by name or email and it is
-- not an Admin; otherwise nothing is changed and a notice says why -- assign
-- the role in Admin Panel → Users instead. His previous roles and any
-- per-user permission overrides are written to the audit log before removal.
-- ============================================================================

INSERT INTO public.roles (slug, label, description, is_system) VALUES
  ('warehouse_manager', 'Warehouse Manager',
   'Warehouse Manager: views Warehouse stock and posts finished products to marketers, distributors and the retail outlet.',
   true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.role_permissions (role, module, action)
SELECT 'warehouse_manager', 'dashboard'::module_key, 'view'::action_key
UNION ALL
SELECT 'warehouse_manager', 'finished-goods'::module_key, a
FROM unnest(ARRAY['view','print','export']::action_key[]) a
UNION ALL
SELECT 'warehouse_manager', 'distribution'::module_key, a
FROM unnest(ARRAY['view','create','submit','print','export']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Makes the one account matching p_match a Warehouse Manager and nothing else.
-- Returns what it did; changes nothing unless exactly one non-admin matches.
CREATE OR REPLACE FUNCTION public._assign_warehouse_manager(p_match text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
  v_old_roles jsonb;
  v_old_overrides jsonb;
BEGIN
  SELECT count(*) INTO v_count FROM profiles p
   WHERE (p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%');
  IF v_count <> 1 THEN
    RETURN format('Skipped: %s accounts match "%s" -- assign the Warehouse Manager role in Admin Panel → Users', v_count, p_match);
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE (p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%');
  IF public.has_role(v_user, 'super_admin') THEN
    RETURN format('Skipped: %s is an Admin -- not changed', v_name);
  END IF;

  -- The factory he already works in; else the only factory there is.
  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  IF v_factory IS NULL AND (SELECT count(*) FROM factories) = 1 THEN
    SELECT id INTO v_factory FROM factories;
  END IF;
  IF v_factory IS NULL THEN
    RETURN format('Skipped: could not tell which factory %s works in -- assign the role in Admin Panel → Users', v_name);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('role', role, 'factory_id', factory_id)), '[]'::jsonb)
    INTO v_old_roles FROM user_roles WHERE user_id = v_user;
  SELECT COALESCE(jsonb_agg(to_jsonb(o) - 'user_id'), '[]'::jsonb)
    INTO v_old_overrides FROM permission_overrides o WHERE o.user_id = v_user;

  DELETE FROM permission_overrides WHERE user_id = v_user;
  DELETE FROM user_roles WHERE user_id = v_user;
  INSERT INTO user_roles (user_id, role, factory_id) VALUES (v_user, 'warehouse_manager', v_factory);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'assign_role', 'user_roles', v_user::text,
          jsonb_build_object('roles', v_old_roles, 'permission_overrides', v_old_overrides),
          jsonb_build_object('roles', jsonb_build_array(jsonb_build_object('role', 'warehouse_manager', 'factory_id', v_factory)),
                             'reason', 'Warehouse Manager only: Warehouse and Distribution (factory decision 2026-10-21)'));
  RETURN format('%s is now Warehouse Manager only', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public._assign_warehouse_manager(text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._assign_warehouse_manager('gideon');
END $$;
