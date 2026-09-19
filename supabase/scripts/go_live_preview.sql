-- ============================================================================
-- GO-LIVE PREVIEW  (read-only — changes nothing)
-- ----------------------------------------------------------------------------
-- Run this BEFORE go_live_reset.sql. It lists every table with how many rows
-- it holds and what the reset would do to it:
--
--   CLEAR   every row is deleted (customers and everything tied to them, sales,
--           payments, debts, ledger, production, stock movements, expenses,
--           payroll, requests, audit history, ...)
--   KEEP    left exactly as it is (users, roles, permissions, settings,
--           factories, products, raw materials, suppliers, employees,
--           categories, units, vehicles, drivers, ...)
--   UNKNOWN a table the script does not know about — if any appear, the reset
--           will refuse to run until they are classified.
--
-- Products, raw materials and suppliers are KEPT, but their quantities and
-- balances are set to zero by the reset (see the second result).
-- ============================================================================

WITH plan(table_name, action) AS (
  SELECT t, 'CLEAR' FROM unnest(ARRAY[
    'audit_logs','cash_transactions','costing_price_options','costing_sheet_items','costing_sheets',
    'customers','customer_account_adjustments','customer_account_transactions','damage_records','debt_payments','debts',
    'delete_requests','deliveries','expenses','goods_receipts','inventory_movements','notifications',
    'payments_received','payroll','product_price_history','production','production_request_items',
    'production_requests','purchase_orders','raw_material_cost_history','raw_material_movements',
    'rep_remittances','rep_return_items','rep_returns','rep_stock','rep_stock_movements',
    'role_grant_requests','sale_items','sales','sales_returns','staff_deductions','staff_loan_repayments',
    'staff_loans','stock_adjustment_requests','stock_dispatch_items','stock_dispatches',
    'workflow_approval_history'
  ]) AS t
  UNION ALL
  SELECT t, 'KEEP' FROM unnest(ARRAY[
    'factories','settings','profiles','user_roles','roles','role_permissions','permission_overrides',
    'workflow_configs','workflow_transitions','units_of_measure','material_categories','product_categories',
    'expense_categories','production_types','product_units','products','raw_materials','suppliers',
    'employees','employee_documents','drivers','vehicles','sales_reps','delivery_routes'
  ]) AS t
)
SELECT
  t.table_name,
  COALESCE(p.action, 'UNKNOWN') AS action,
  (xpath('/row/c/text()',
     query_to_xml(format('select count(*) as c from public.%I', t.table_name), false, true, '')))[1]::text::int AS rows_now
FROM information_schema.tables t
LEFT JOIN plan p ON p.table_name = t.table_name
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY (COALESCE(p.action, 'UNKNOWN') = 'CLEAR') DESC, COALESCE(p.action, 'UNKNOWN'), t.table_name;

-- What "keep, but zero the quantities" means, by factory:
SELECT 'products' AS list, f.name AS factory, COUNT(*) AS items_kept,
       COALESCE(SUM(p.current_stock), 0) AS stock_now, 0 AS stock_after_reset
  FROM public.products p JOIN public.factories f ON f.id = p.factory_id GROUP BY f.name
UNION ALL
SELECT 'raw_materials', f.name, COUNT(*), COALESCE(SUM(r.current_stock), 0), 0
  FROM public.raw_materials r JOIN public.factories f ON f.id = r.factory_id GROUP BY f.name
UNION ALL
SELECT 'suppliers (balance owed)', f.name, COUNT(*), COALESCE(SUM(s.outstanding_balance), 0), 0
  FROM public.suppliers s JOIN public.factories f ON f.id = s.factory_id GROUP BY f.name
ORDER BY 1, 2;
