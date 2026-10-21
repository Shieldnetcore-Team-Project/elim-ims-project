-- ============================================================================
-- GO-LIVE RESET — permanently deletes all data except users and settings
-- ----------------------------------------------------------------------------
-- THIS CANNOT BE UNDONE. Run go_live_preview.sql first and check the plan.
-- Take a backup first: Settings → Backup in the app, or Supabase Dashboard →
-- Database → Backups.
--
-- What it does (all-or-nothing: if any check fails, NOTHING is changed):
--
--   * DELETES every record: customers, sales and invoices, payments, debts,
--     the customer account ledger, production and production corrections,
--     store requests, stock movements, goods receipts, purchase orders,
--     expenses, payroll and staff loans, deliveries, bottle movements, damage
--     and return records, jug returns and QC jug batches, preform records,
--     marketer day-closes and follow-ups, approvals, notifications and the
--     audit history.
--
--   * DELETES every set-up list: products (and their packaging units,
--     containers and commission rates), raw materials, employees
--     (and their documents), marketers, vehicles, drivers, delivery routes and
--     container types.
--
--   * KEEPS the suppliers (with the details and balances as entered), user
--     accounts and their roles, roles and permissions, approval
--     workflow set-up, company settings, factories, units of measure,
--     production types, and the product / material / expense category lists
--     (the app has no screen to re-create product categories, and Costing
--     relies on them).
--
--   * Then ADDS BACK the standard raw materials (dispenser bottles, sachet
--     film, preforms, caps, water treatment and so on -- migration
--     20261015200000) with zero stock, so every raw-material dropdown always
--     has them, the default Retail Outlet, so the Warehouse can stock it
--     straight away, and the company's marketers and distributors.
--
-- Not covered (Supabase Storage is separate from the database): uploaded
-- files such as expense attachments and employee documents stay in storage.
--
-- Everything runs inside ONE DO block, so it is a single statement: the
-- Supabase SQL Editor runs it all-or-nothing, and an error anywhere undoes
-- the whole reset. (An earlier version used BEGIN/COMMIT and a temp table,
-- which the SQL Editor does not keep between statements.)
--
-- Run the whole file in the Supabase SQL Editor. The result at the bottom
-- should say RESET COMPLETE.
-- ============================================================================

DO $reset$
DECLARE
  cleared text[] := ARRAY[
    -- records
    'audit_logs','cash_transactions','chairmans_gift_items','chairmans_gifts','container_movements','costing_price_options','costing_sheet_items',
    'costing_sheets','customers','customer_followups','customer_marketer_history','customer_account_adjustments','customer_account_transactions',
    'damage_records','debt_payments','debts','delete_requests','deliveries','expenses','goods_receipts',
    'inventory_movements','jug_returns','marketer_day_closes','notifications','outlet_day_reconciliations','payments_received',
    'bottle_transfers','department_stock','department_stock_movements','preform_exceptions','preform_holdings',
    'preform_issues','preform_movements','preform_qc_inspections','preform_shift_records','preform_stockings','payroll','posting_assessments','qc_jug_batches','product_price_history',
    'production','production_corrections','production_releases','production_request_items','production_requests','purchase_orders',
    'raw_material_cost_history','raw_material_movements','rep_remittances','rep_return_items',
    'rep_returns','rep_stock','rep_stock_movements','role_grant_requests','sale_items','sales',
    'sales_returns','staff_deductions','staff_loan_repayments','staff_loans',
    'stock_adjustment_requests','stock_dispatch_items','stock_dispatches','workflow_approval_history',
    -- set-up lists
    'container_types','delivery_routes','drivers','employee_documents','employees','material_suppliers',
    'product_commission_rates','product_containers','product_units','products','raw_materials',
    'sales_reps','vehicles'];
  kept text[] := ARRAY[
    'factories','settings','profiles','user_roles','roles','role_permissions','permission_overrides',
    'workflow_configs','workflow_transitions','units_of_measure','production_types','user_page_access',
    'product_categories','material_categories','expense_categories',
    -- kept at go-live by the factory's decision (2026-10-21)
    'suppliers'];
  t text;
  n bigint;
  bad text;
  kept_before jsonb := '{}'::jsonb;
  to_truncate text[] := '{}';
BEGIN
  -- 0. Refuse to run if the database has a table this script doesn't know about.
  SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO bad
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     AND table_name <> ALL (cleared || kept);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Unclassified table(s): %. Nothing was changed. Tell the developer to classify them first.', bad;
  END IF;

  -- 1. Remember how many rows every kept table has, to prove none were lost.
  FOREACH t IN ARRAY kept LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      kept_before := kept_before || jsonb_build_object(t, n);
    END IF;
  END LOOP;

  -- 2. Delete everything else. One TRUNCATE, no CASCADE: if any KEPT table
  --    still points at one being cleared, PostgreSQL refuses and the whole
  --    reset is undone instead of silently deleting more. TRUNCATE does not
  --    fire row triggers, so no re-order requests or history rows are written.
  --    Tables listed here but missing from this database are skipped.
  FOREACH t IN ARRAY cleared LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      to_truncate := to_truncate || format('public.%I', t);
    END IF;
  END LOOP;
  EXECUTE 'TRUNCATE TABLE ' || array_to_string(to_truncate, ', ') || ' RESTART IDENTITY';

  -- 3. Prove it worked. Any failure raises an error, which undoes everything.
  bad := NULL;
  FOREACH t IN ARRAY cleared LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n <> 0 THEN bad := concat_ws(', ', bad, t); END IF;
    END IF;
  END LOOP;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Not empty after reset: %. Nothing was changed.', bad; END IF;

  FOR t IN SELECT jsonb_object_keys(kept_before) LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n <> (kept_before ->> t)::bigint THEN bad := concat_ws(', ', bad, t); END IF;
  END LOOP;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'A kept list lost rows: %. Nothing was changed.', bad; END IF;
END
$reset$;

-- Put back the standard raw materials every dropdown needs, zero stock.
-- Defined by migration 20261014160000 (list extended in 20261015200000);
-- skipped if that migration hasn't been applied yet.
DO $seed$
BEGIN
  IF to_regprocedure('public.seed_standard_raw_materials()') IS NOT NULL THEN
    PERFORM public.seed_standard_raw_materials();
  END IF;
  -- The default Retail Outlet (migration 20261014170000), so the Warehouse can
  -- stock the outlet straight away.
  IF to_regprocedure('public.seed_retail_outlet()') IS NOT NULL THEN
    PERFORM public.seed_retail_outlet();
  END IF;
  -- The company's marketers (migration 20261015160000).
  IF to_regprocedure('public.seed_marketers()') IS NOT NULL THEN
    PERFORM public.seed_marketers();
  END IF;
  -- The company's distributors (migration 20261015180000).
  IF to_regprocedure('public.seed_distributors()') IS NOT NULL THEN
    PERFORM public.seed_distributors();
  END IF;
END
$seed$;

-- What is left: users, settings and categories, plus the standard raw
-- materials (zero stock), retail outlet, marketers and distributors.
SELECT 'RESET COMPLETE' AS result,
       (SELECT COUNT(*) FROM public.suppliers)          AS suppliers_kept,
       (SELECT COUNT(*) FROM public.profiles)           AS user_accounts_kept,
       (SELECT COUNT(*) FROM public.roles)              AS roles_kept,
       (SELECT COUNT(*) FROM public.product_categories) AS product_categories_kept,
       (SELECT COUNT(*) FROM public.products)           AS products_left,
       (SELECT COUNT(*) FROM public.raw_materials)      AS raw_materials_left,
       (SELECT COALESCE(SUM(current_value), 0) FROM public.raw_materials) AS raw_material_value_left,
       (SELECT COUNT(*) FROM public.customers)          AS customers_left,
       (SELECT COUNT(*) FROM public.sales)              AS sales_left;
