-- ============================================================================
-- GO-LIVE RESET — permanently deletes all transaction records
-- ----------------------------------------------------------------------------
-- THIS CANNOT BE UNDONE. Run go_live_preview.sql first and check the plan.
--
-- What it does (all-or-nothing: if any check fails, NOTHING is changed):
--
--   * DELETES every customer and every row in the transaction tables: sales
--     and invoices, payments, debts, the customer account ledger and adjustments,
--     production, stock movements, goods receipts, purchase orders, expenses,
--     payroll and staff loans, requests and approvals, deliveries, damage and
--     return records, notifications, and the audit history.
--
--   * KEEPS users, roles, permissions, settings and factories, and every
--     set-up list: products, raw materials (all names, units, prices, reorder
--     levels — every dropdown), suppliers, employees, categories, units,
--     vehicles, drivers, sales reps and routes.
--
--   * ZEROES quantities and balances on the kept lists: finished-goods stock,
--     raw-material stock and stock value, and supplier balances. Prices and
--     cost per unit stay.
--
-- Not covered (Supabase Storage is separate from the database): uploaded
-- files such as expense attachments and employee documents stay in storage.
--
-- Run the whole file in the Supabase SQL Editor. The result at the bottom
-- should say RESET COMPLETE.
-- ============================================================================

BEGIN;

-- 0. Refuse to run if the database has a table this script doesn't know about.
DO $$
DECLARE unknown text;
BEGIN
  SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO unknown
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     AND table_name <> ALL (ARRAY[
       -- cleared
       'audit_logs','cash_transactions','costing_price_options','costing_sheet_items','costing_sheets',
       'customers','customer_account_adjustments','customer_account_transactions','damage_records','debt_payments','debts',
       'delete_requests','deliveries','expenses','goods_receipts','inventory_movements','notifications',
       'payments_received','payroll','product_price_history','production','production_request_items',
       'production_requests','purchase_orders','raw_material_cost_history','raw_material_movements',
       'rep_remittances','rep_return_items','rep_returns','rep_stock','rep_stock_movements',
       'role_grant_requests','sale_items','sales','sales_returns','staff_deductions','staff_loan_repayments',
       'staff_loans','stock_adjustment_requests','stock_dispatch_items','stock_dispatches',
       'workflow_approval_history',
       -- kept
       'factories','settings','profiles','user_roles','roles','role_permissions','permission_overrides',
       'workflow_configs','workflow_transitions','units_of_measure','material_categories','product_categories',
       'expense_categories','production_types','product_units','products','raw_materials','suppliers',
       'employees','employee_documents','drivers','vehicles','sales_reps','delivery_routes'
     ]);
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'Unclassified table(s): %. Nothing was changed. Tell the developer to classify them first.', unknown;
  END IF;
END $$;

-- 1. Remember how many rows every kept table has, to prove none were lost.
CREATE TEMP TABLE _kept_before ON COMMIT DROP AS
SELECT t AS table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::int AS n
  FROM unnest(ARRAY[
    'factories','settings','profiles','user_roles','roles','role_permissions','permission_overrides',
    'workflow_configs','workflow_transitions','units_of_measure','material_categories','product_categories',
    'expense_categories','production_types','product_units','products','raw_materials','suppliers',
    'employees','employee_documents','drivers','vehicles','sales_reps','delivery_routes'
  ]) AS t;

-- 2. Zeroing stock would otherwise trip the automatic re-order triggers and
--    write purchase / production requests and history rows. Switch them off
--    for the reset (they are switched back on in step 5).
ALTER TABLE public.raw_materials DISABLE TRIGGER trg_auto_reorder_purchase_request;
ALTER TABLE public.raw_materials DISABLE TRIGGER raw_materials_cost_history;
ALTER TABLE public.products      DISABLE TRIGGER trg_auto_reorder_production_request;
ALTER TABLE public.products      DISABLE TRIGGER products_price_history;

-- 3. Zero quantities and balances on the lists that stay.
UPDATE public.products      SET current_stock = 0;
UPDATE public.raw_materials SET opening_stock = 0, current_stock = 0, current_value = 0;
UPDATE public.suppliers     SET outstanding_balance = 0;

-- 4. Delete every transaction record. One statement, no CASCADE: if any table
--    that is being KEPT still points at one being cleared, PostgreSQL refuses
--    and the whole script is rolled back instead of silently deleting more.
TRUNCATE TABLE
  public.audit_logs, public.cash_transactions, public.costing_price_options, public.costing_sheet_items,
  public.costing_sheets, public.customers, public.customer_account_adjustments, public.customer_account_transactions,
  public.damage_records, public.debt_payments, public.debts, public.delete_requests, public.deliveries,
  public.expenses, public.goods_receipts, public.inventory_movements, public.notifications,
  public.payments_received, public.payroll, public.product_price_history, public.production,
  public.production_request_items, public.production_requests, public.purchase_orders,
  public.raw_material_cost_history, public.raw_material_movements, public.rep_remittances,
  public.rep_return_items, public.rep_returns, public.rep_stock, public.rep_stock_movements,
  public.role_grant_requests, public.sale_items, public.sales, public.sales_returns,
  public.staff_deductions, public.staff_loan_repayments, public.staff_loans,
  public.stock_adjustment_requests, public.stock_dispatch_items, public.stock_dispatches,
  public.workflow_approval_history
RESTART IDENTITY;

-- 5. Switch the triggers back on.
ALTER TABLE public.raw_materials ENABLE TRIGGER trg_auto_reorder_purchase_request;
ALTER TABLE public.raw_materials ENABLE TRIGGER raw_materials_cost_history;
ALTER TABLE public.products      ENABLE TRIGGER trg_auto_reorder_production_request;
ALTER TABLE public.products      ENABLE TRIGGER products_price_history;

-- 6. Prove it worked. Any failure raises an error, which cancels everything.
DO $$
DECLARE
  bad text;
  cleared text[] := ARRAY[
    'audit_logs','cash_transactions','costing_price_options','costing_sheet_items','costing_sheets',
    'customers','customer_account_adjustments','customer_account_transactions','damage_records','debt_payments','debts',
    'delete_requests','deliveries','expenses','goods_receipts','inventory_movements','notifications',
    'payments_received','payroll','product_price_history','production','production_request_items',
    'production_requests','purchase_orders','raw_material_cost_history','raw_material_movements',
    'rep_remittances','rep_return_items','rep_returns','rep_stock','rep_stock_movements',
    'role_grant_requests','sale_items','sales','sales_returns','staff_deductions','staff_loan_repayments',
    'staff_loans','stock_adjustment_requests','stock_dispatch_items','stock_dispatches',
    'workflow_approval_history'];
BEGIN
  SELECT string_agg(t, ', ') INTO bad FROM unnest(cleared) t
   WHERE (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::int <> 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Not empty after reset: %. Nothing was changed.', bad; END IF;

  SELECT string_agg(b.table_name, ', ') INTO bad FROM _kept_before b
   WHERE (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', b.table_name), false, true, '')))[1]::text::int <> b.n;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'A kept list lost rows: %. Nothing was changed.', bad; END IF;

  IF EXISTS (SELECT 1 FROM public.products WHERE current_stock <> 0)
     OR EXISTS (SELECT 1 FROM public.raw_materials WHERE current_stock <> 0 OR current_value <> 0 OR opening_stock <> 0)
     OR EXISTS (SELECT 1 FROM public.suppliers WHERE outstanding_balance <> 0) THEN
    RAISE EXCEPTION 'Some quantities or balances are not zero. Nothing was changed.';
  END IF;

  IF (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN
        ('trg_auto_reorder_purchase_request','raw_materials_cost_history',
         'trg_auto_reorder_production_request','products_price_history')
        AND tgenabled = 'D') > 0 THEN
    RAISE EXCEPTION 'A trigger was left switched off. Nothing was changed.';
  END IF;
END $$;

COMMIT;

-- What is left: kept lists (with zero stock) and empty transaction tables.
SELECT 'RESET COMPLETE' AS result,
       (SELECT COUNT(*) FROM public.products)      AS products_kept,
       (SELECT COUNT(*) FROM public.raw_materials) AS raw_materials_kept,
       (SELECT COUNT(*) FROM public.customers)     AS customers_left,
       (SELECT COUNT(*) FROM public.suppliers)     AS suppliers_kept,
       (SELECT COUNT(*) FROM public.sales)         AS sales_left,
       (SELECT COALESCE(SUM(current_stock), 0) FROM public.products)      AS finished_stock_total,
       (SELECT COALESCE(SUM(current_stock), 0) FROM public.raw_materials) AS raw_material_stock_total;
