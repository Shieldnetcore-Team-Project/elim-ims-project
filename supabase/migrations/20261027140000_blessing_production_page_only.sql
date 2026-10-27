-- ============================================================================
-- Blessing: Production page only
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-27): Blessing is the production manager who
-- posts batches of products after production. She no longer works Quality
-- Control. For her account only -- no role is changed:
--   * the "Production › Production" page is allowed, with the rights to view
--     and post batches there (permission_overrides);
--   * every other page, Quality Control included, is blocked in her page
--     access, so it leaves her menu.
-- An admin can give pages back in Admin Panel → Users → Page access.
-- Records she already made stay on record.
--
-- Applied when exactly one non-admin account matches "blessing" by name or
-- email; otherwise nothing changes and a notice says why. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._production_page_only_for(p_match text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
  v_keep constant text := 'Production › Production';
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
  SELECT count(*) INTO v_count FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF v_count <> 1 THEN
    RETURN format('Skipped: %s accounts match "%s" -- set her pages in Admin Panel → Users', v_count, p_match);
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%' || p_match || '%' OR p.email ILIKE '%' || p_match || '%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RETURN format('Skipped: %s is an Admin / Chairman -- not changed', v_name);
  END IF;

  -- Rights to post batches on the Production page.
  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, 'production'::module_key, a, true
    FROM unnest(ARRAY['view','create','submit']::action_key[]) AS a
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();

  -- Production page in, every other page out (any page decided earlier too).
  INSERT INTO user_page_access (user_id, page_id, granted)
  SELECT v_user, p, p = v_keep
    FROM (SELECT unnest(v_pages) AS p
          UNION SELECT page_id FROM user_page_access WHERE user_id = v_user) pages
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = EXCLUDED.granted, granted_at = now();

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'remove_page', 'user_page_access', v_user::text,
          jsonb_build_object('page', v_keep, 'only', true,
                             'reason', format('Production page only for %s, no Quality Control (factory decision 2026-10-27)', v_name)));
  RETURN format('%s now has only the Production page', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public._production_page_only_for(text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._production_page_only_for('blessing');
END $$;
