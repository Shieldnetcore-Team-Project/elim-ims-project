-- ============================================================================
-- Oluwakemi Arogundade: the Warehouse, all of it, and nothing else
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-27): Oluwakemi Arogundade
-- (arogundadeoluwakemi613@gmail.com) works the Warehouse -- every Warehouse
-- tab and feature, so she posts to the retail shop, marketers and
-- distributors -- and has no other page. For her account:
--   * her role becomes the Warehouse role (store_officer) only: Stock,
--     Store requests, Orders, Returns, Reps & outlet stock, Dispenser & jugs,
--     Customers, Finished Products, accepting production releases, posting
--     (20261017100000 and earlier). Any other role she had is removed;
--   * per-user permission overrides are cleared, so nothing granted or
--     denied earlier gets in the way;
--   * every Warehouse page is allowed in her page access and every other
--     page is blocked.
-- Her previous roles, overrides and page access go to the audit log first.
-- An admin can change any of it in Admin Panel → Users.
--
-- Matched by her email; nothing changes (a notice says why) unless exactly
-- one account has it and it is not an Admin / Chairman. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._warehouse_only_for(p_email text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
  v_old jsonb;
  -- Every page in the menu (src/lib/nav.ts) as of this migration.
  v_pages constant text[] := ARRAY[
    'Dashboard','Approval Center','Retail › Retail Outlet','Retail › Sales & POS','Retail › Sales Returns',
    'Production › Production','Production › Store Requests','Production › Products Report',
    'Quality Control › Inspections','Quality Control › Good bottles','Quality Control › Bottle tracking',
    'Store › Raw Materials','Store › Preform Inventory','Store › Requests','Store › Issue preforms',
    'Store › Issued out','Store › Brands','Warehouse › Stock','Warehouse › Store requests',
    'Warehouse › Orders','Warehouse › Returns','Warehouse › Reps & outlet stock',
    'Warehouse › Dispenser & jugs','Warehouse › Customers','Warehouse › Finished Products',
    'Distribution','Costing','Procurement › Purchase Requests','Procurement › Purchase Orders',
    'Finance Overview','Accountant','Payments › Overview','Payments › Ledger','Payments › Debts',
    'Payments › Record Payments','Marketer & Retail Accounts › Marketer & retail accounts',
    'Marketer & Retail Accounts › Distributor accounts',
    'Marketer & Retail Accounts › Credit sales (distributors)',
    'Marketer & Retail Accounts › Postings to assess','Marketer & Retail Accounts › Retail cash-up',
    'Marketer & Retail Accounts › Cash remitted','Marketer & Retail Accounts › Performance & commission',
    'Financial Reports','Expenses','Payroll','Vehicles, Drivers & Deliveries','All Reports',
    'Customers','Suppliers','Employees','Admin Panel › Users & Factory','Admin Panel › Pending',
    'Admin Panel › Delete Requests','Admin Panel › Deleted Sales','Admin Panel › Permissions',
    'Admin Panel › Audit Log','Admin Panel › Auth Users','System Settings'];
BEGIN
  SELECT count(*) INTO v_count FROM profiles p WHERE lower(btrim(p.email)) = lower(btrim(p_email));
  IF v_count <> 1 THEN
    RETURN format('Skipped: %s accounts have %s -- set her up in Admin Panel → Users', v_count, p_email);
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE lower(btrim(p.email)) = lower(btrim(p_email));
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RETURN format('Skipped: %s is an Admin / Chairman -- not changed', v_name);
  END IF;

  -- The factory she already works in; else the Water factory.
  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  IF v_factory IS NULL THEN SELECT id INTO v_factory FROM factories WHERE code = 'water'; END IF;
  IF v_factory IS NULL THEN
    RETURN format('Skipped: could not tell which factory %s works in -- set her up in Admin Panel → Users', v_name);
  END IF;

  SELECT jsonb_build_object(
           'roles', (SELECT COALESCE(jsonb_agg(jsonb_build_object('role', role, 'factory_id', factory_id)), '[]'::jsonb)
                       FROM user_roles WHERE user_id = v_user),
           'overrides', (SELECT COALESCE(jsonb_agg(to_jsonb(o) - 'user_id'), '[]'::jsonb)
                           FROM permission_overrides o WHERE o.user_id = v_user),
           'pages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('page', page_id, 'granted', granted)), '[]'::jsonb)
                       FROM user_page_access WHERE user_id = v_user))
    INTO v_old;

  -- Role: Warehouse only.
  DELETE FROM user_roles WHERE user_id = v_user AND NOT (role = 'store_officer' AND factory_id = v_factory);
  INSERT INTO user_roles (user_id, role, factory_id)
  SELECT v_user, 'store_officer', v_factory
   WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = v_user AND role = 'store_officer' AND factory_id = v_factory);
  DELETE FROM permission_overrides WHERE user_id = v_user;

  -- Pages: every Warehouse tab in, everything else out (pages decided
  -- earlier included).
  INSERT INTO user_page_access (user_id, page_id, granted)
  SELECT v_user, p, p LIKE 'Warehouse › %'
    FROM (SELECT unnest(v_pages) AS p
          UNION SELECT page_id FROM user_page_access WHERE user_id = v_user) pages
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = EXCLUDED.granted, granted_at = now();

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'assign_role', 'user_roles', v_user::text, v_old,
          jsonb_build_object('role', 'store_officer', 'pages', 'Warehouse only',
                             'reason', format('Warehouse only for %s (factory decision 2026-10-27)', v_name)));
  RETURN format('%s now has the Warehouse, and only the Warehouse', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public._warehouse_only_for(text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._warehouse_only_for('arogundadeoluwakemi613@gmail.com');
END $$;
