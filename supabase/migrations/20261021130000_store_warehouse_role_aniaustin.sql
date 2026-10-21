-- ============================================================================
-- Store & Warehouse role, and aniaustin (Ustin) limited to it
-- ----------------------------------------------------------------------------
-- Factory decision (2026-10-21): Ustin (account "aniaustin") works the Store,
-- the Warehouse and Expenses -- and nothing else (no Suppliers page). This
-- replaces the Warehouse role added for him in 20261021120000.
--
-- New role 'store_warehouse' (label "Store & Warehouse"), built from what the
-- two existing roles already do on those pages, so nothing new is invented:
--   Store       everything the Store role (store_keeper) has: raw materials,
--               preform inventory, approving/issuing Warehouse requests, and
--               confirming QC-inspected deliveries into stock (goods-receiving
--               view/confirm/reject -- the read-only Quality Control page
--               shows for that reason)
--   Warehouse   what the Warehouse role (store_officer) has on the Warehouse
--               tabs: finished-goods, production-requests, preform-production,
--               sales, sales-returns, distribution, customers -- including
--               sending Old / New Jugs to QC
--               + production confirm / reject WITHOUT view: accept or refuse
--               production released to the Warehouse, but no Production page
--   Expenses    view, create, edit, submit, cancel, print, export (raising
--               expenses; approving and posting them stay with Finance)
-- Not included: the Suppliers page, marketer / distributor accounts,
-- inventory overview, production view, and every other module.
--
-- The Store forms pick the supplier of a delivery from the supplier list,
-- which was readable only with Suppliers view. It is now also readable by
-- whoever receives deliveries (raw-materials create / submit, goods-receiving
-- submit / confirm), so the Store works without the Suppliers page. The Store
-- role already read it; QC staff who record or confirm deliveries now can too.
-- Adding or editing suppliers still needs Suppliers rights.
--
-- Pages shared between menus (e.g. Store requests also sits under Production
-- and Procurement, Orders under Retail) appear wherever the menu lists them --
-- they are the same pages, not extra access.
--
-- Then makes it Ustin's ONLY role (previous roles and per-user overrides go to
-- the audit log), when exactly one non-admin account matches "aniaustin";
-- otherwise nothing changes and a notice says why.
-- ============================================================================

INSERT INTO public.roles (slug, label, description, is_system) VALUES
  ('store_warehouse', 'Store & Warehouse',
   'Store & Warehouse: raw materials and preforms, Warehouse stock and dispatches, Old / New Jugs to QC, and expenses.',
   true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.role_permissions (role, module, action)
SELECT 'store_warehouse', module, action FROM public.role_permissions
 WHERE role = 'store_keeper' AND module <> 'suppliers'
UNION
SELECT 'store_warehouse', module, action FROM public.role_permissions
 WHERE role = 'store_officer'
   AND module IN ('finished-goods', 'production-requests', 'preform-production', 'sales',
                  'sales-returns', 'distribution', 'customers', 'dashboard')
UNION
SELECT 'store_warehouse', 'production'::module_key, a FROM unnest(ARRAY['confirm','reject']::action_key[]) a
UNION
SELECT 'store_warehouse', 'expenses'::module_key, a FROM unnest(ARRAY['view','create','edit','submit','cancel','print','export']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Supplier list readable by whoever receives deliveries (see above).
DROP POLICY IF EXISTS "suppliers read for receiving" ON public.suppliers;
CREATE POLICY "suppliers read for receiving" ON public.suppliers FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
      OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'submit'::action_key)
      OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'submit'::action_key)
      OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'confirm'::action_key));

-- Makes p_role the ONLY role of the one non-admin account matching p_match
-- (name or email). Returns what it did; changes nothing otherwise.
CREATE OR REPLACE FUNCTION public._set_only_role(p_match text, p_role text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
  v_label text;
  v_old_roles jsonb;
  v_old_overrides jsonb;
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
  IF public.has_role(v_user, 'super_admin') THEN
    RETURN format('Skipped: %s is an Admin -- not changed', v_name);
  END IF;

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
  INSERT INTO user_roles (user_id, role, factory_id) VALUES (v_user, p_role, v_factory);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'assign_role', 'user_roles', v_user::text,
          jsonb_build_object('roles', v_old_roles, 'permission_overrides', v_old_overrides),
          jsonb_build_object('roles', jsonb_build_array(jsonb_build_object('role', p_role, 'factory_id', v_factory)),
                             'reason', format('%s only (factory decision 2026-10-21)', v_label)));
  RETURN format('%s now has only the %s role', v_name, v_label);
END;
$$;
REVOKE ALL ON FUNCTION public._set_only_role(text, text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._set_only_role('aniaustin', 'store_warehouse');
END $$;
