-- ============================================================================
-- Acceptance tests: Marry Oluwafemi gets the Accountant page only
-- (20261102230000_marry_accountant_page.sql). The migration ran before her
-- account existed (skipped); here it runs again once she has one.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('a1000000-0000-0000-0000-000000000001', 'marry.oluwafemi@test');
INSERT INTO profiles(id, email, full_name)
SELECT 'a1000000-0000-0000-0000-000000000001', 'marry.oluwafemi@test', 'Marry Oluwafemi'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = 'a1000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = 'a1000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'a1000000-0000-0000-0000-000000000001', 'sales', f.id FROM factories f WHERE f.code = 'water';
-- An earlier decision that must be overturned.
INSERT INTO user_page_access(user_id, page_id, granted)
VALUES ('a1000000-0000-0000-0000-000000000001', 'Retail › POS', true)
ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true;

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the migration grants the Accountant page, blocks the rest and gives print rights
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

DO $$
DECLARE u uuid := 'a1000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.check((SELECT granted FROM user_page_access WHERE user_id = u AND page_id = 'Accountant'), 'Accountant allowed');
  PERFORM pg_temp.check(NOT (SELECT granted FROM user_page_access WHERE user_id = u AND page_id = 'Retail › POS'), 'POS blocked');
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access WHERE user_id = u AND granted) = 1, 'only one page');
  PERFORM pg_temp.check(public.has_permission(u, 'finance'::module_key, 'view'::action_key), 'finance view');
  PERFORM pg_temp.check(public.has_permission(u, 'finance'::module_key, 'print'::action_key), 'finance print');
  PERFORM pg_temp.check(public.has_permission(u, 'distribution'::module_key, 'view'::action_key), 'distribution view');
  PERFORM pg_temp.check(public.has_permission(u, 'payments'::module_key, 'create'::action_key), 'payments create');
  PERFORM pg_temp.check(NOT public.has_permission(u, 'finance'::module_key, 'delete'::action_key), 'no delete');
END $$;

-- @@ Test 2: she can read invoice lines (what invoice printing calls)
DO $$
BEGIN
  PERFORM set_config('test.uid', 'a1000000-0000-0000-0000-000000000001', true);
  PERFORM * FROM public.sale_invoice_lines(ARRAY[]::uuid[]);
END $$;
