-- ============================================================================
-- Marry Oluwafemi: the Accountant page, every tab, and invoice printing
-- ----------------------------------------------------------------------------
-- User (2026-11-02): "enable Marry Oluwafemi to print invoices in accountant
-- page, enable her all the pages" -- confirmed: every tab of the Accountant
-- page and nothing else. For her account only -- no role is changed:
--   * rights the Accountant tabs and their print / payment actions check
--     (permission_overrides): All activity, Postings to assess, Retail
--     cash-up, Invoices, Payments received, Marketer & retail accounts, Reps
--     & outlets, Cash remitted, Distributor/Office Delivery, Customers.
--     Invoice printing reads sale_invoice_lines (finance / sales view) and
--     rep_posting_lines (finance / distribution view).
--   * the "Accountant" page allowed, every other page in the menu blocked
--     (user_page_access), so only it is in her menu.
-- An admin can give pages back in Admin Panel → Users → Page access.
--
-- Applied when exactly one non-admin account matches "oluwafemi" by name or
-- email; otherwise nothing changes and a notice says why. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
  v_keep constant text := 'Accountant';
  -- Every page in the menu (src/lib/nav.ts) as of this migration.
  v_pages constant text[] := ARRAY[
    'Dashboard','Approval Center','Retail › POS','Retail › All activity','Retail › Retail Outlet',
    'Retail › Transaction Summary','Retail › Posting Log','Retail › Jars','Retail › Sales Returns',
    'Production › Production','Production › Store Requests','Production › Products Report',
    'Quality Control › Inspections','Quality Control › Good bottles','Quality Control › Bottle tracking',
    'Store › Raw Materials','Store › Preform Inventory','Store › Requests','Store › Issue preforms',
    'Store › Issued out','Store › Jugs','Store › Brands','Warehouse › Stock','Warehouse › Activity Log',
    'Warehouse › Products Report','Warehouse › Store requests','Warehouse › Returns',
    'Warehouse › Dispenser & jugs','Warehouse › Finished Products','Costing',
    'Procurement › Purchase Requests','Procurement › Purchase Orders','Finance Overview','Accountant',
    'Payments › Overview','Payments › Ledger','Payments › Debts','Payments › Record Payments',
    'Marketer & Retail Accounts › Marketer & retail accounts',
    'Marketer & Retail Accounts › Distributor/Office Delivery accounts',
    'Marketer & Retail Accounts › Credits/Outstandings','Marketer & Retail Accounts › Postings to assess',
    'Marketer & Retail Accounts › Retail cash-up','Marketer & Retail Accounts › Cash remitted',
    'Marketer & Retail Accounts › Reps & outlets','Marketer & Retail Accounts › Customers',
    'Marketer & Retail Accounts › Performance & commission','Financial Reports','Expenses','Payroll',
    'Maintenance','All Reports','Suppliers','Employees','Admin Panel › Users & Factory',
    'Admin Panel › Pending','Admin Panel › Delete Requests','Admin Panel › Deleted Sales',
    'Admin Panel › Permissions','Admin Panel › Audit Log','Admin Panel › Auth Users','System Settings'];
BEGIN
  SELECT count(*) INTO v_count FROM profiles p
   WHERE p.full_name ILIKE '%oluwafemi%' OR p.email ILIKE '%oluwafemi%';
  IF v_count <> 1 THEN
    RAISE NOTICE 'Skipped: % accounts match "oluwafemi" -- set her pages in Admin Panel → Users', v_count;
    RETURN;
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%oluwafemi%' OR p.email ILIKE '%oluwafemi%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RAISE NOTICE 'Skipped: % is an Admin / Chairman -- already has every page', v_name;
    RETURN;
  END IF;

  -- The rights the Accountant tabs check. No approve / reverse / delete.
  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, g.m::module_key, g.a::action_key, true
    FROM (VALUES
      ('finance', 'view'), ('finance', 'create'), ('finance', 'edit'), ('finance', 'post'),
      ('finance', 'print'), ('finance', 'export'),
      ('payments', 'view'), ('payments', 'create'), ('payments', 'post'),
      ('payments', 'print'), ('payments', 'export'),
      ('debts', 'view'), ('debts', 'create'), ('debts', 'print'),
      ('sales', 'view'), ('sales', 'print'),
      ('distribution', 'view'), ('distribution', 'create'), ('distribution', 'print'),
      ('customers', 'view'), ('customers', 'create'), ('customers', 'edit'),
      ('marketer-accounts', 'view'), ('marketer-accounts', 'create'), ('marketer-accounts', 'edit'),
      ('marketer-accounts', 'print'),
      ('distributor-accounts', 'view'), ('distributor-accounts', 'create'),
      ('distributor-accounts', 'print')
    ) AS g(m, a)
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();

  -- Accountant page in, every other page out (any page decided earlier too).
  INSERT INTO user_page_access (user_id, page_id, granted)
  SELECT v_user, p, p = v_keep
    FROM (SELECT unnest(v_pages) AS p
          UNION SELECT page_id FROM user_page_access WHERE user_id = v_user) pages
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = EXCLUDED.granted, granted_at = now();

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant', 'user_page_access', v_user::text,
          jsonb_build_object('page', v_keep, 'only', true,
                             'modules', jsonb_build_array('finance', 'payments', 'debts', 'sales',
                               'distribution', 'customers', 'marketer-accounts', 'distributor-accounts'),
                             'reason', format('Accountant page, every tab and invoice printing, for %s (2026-11-02)', v_name)));
  RAISE NOTICE '% now has the Accountant page (every tab) and can print invoices', v_name;
END $$;
