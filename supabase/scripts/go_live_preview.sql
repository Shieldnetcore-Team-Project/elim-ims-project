-- ============================================================================
-- GO-LIVE PREVIEW  (read-only — changes nothing)
-- ----------------------------------------------------------------------------
-- Run this BEFORE go_live_reset.sql. It lists every table with how many rows
-- it holds and what the reset would do to it:
--
--   CLEAR   every row is deleted:
--             - all records: customers, sales, payments, debts, ledger,
--               production, requests, stock movements, goods receipts,
--               purchase orders, expenses, payroll, deliveries, bottle
--               movements, approvals, notifications, audit history
--             - all set-up lists: products, raw materials, suppliers,
--               employees, marketers, vehicles, drivers, routes, containers,
--               commission rates
--   KEEP    left exactly as it is: user accounts and their roles, roles and
--           permissions, approval workflow set-up, company settings,
--           factories, units of measure, production types, and the product /
--           material / expense category lists
--   UNKNOWN a table the script does not know about — if any appear, the reset
--           will refuse to run until they are classified.
-- ============================================================================

WITH plan(table_name, action) AS (
  SELECT t, 'CLEAR' FROM unnest(ARRAY[
    -- records
    'audit_logs','cash_transactions','container_movements','costing_price_options','costing_sheet_items',
    'costing_sheets','customers','customer_account_adjustments','customer_account_transactions',
    'damage_records','debt_payments','debts','delete_requests','deliveries','expenses','goods_receipts',
    'inventory_movements','notifications','payments_received','payroll','product_price_history',
    'production','production_corrections','production_request_items','production_requests','purchase_orders',
    'raw_material_cost_history','raw_material_movements','rep_remittances','rep_return_items',
    'rep_returns','rep_stock','rep_stock_movements','role_grant_requests','sale_items','sales',
    'sales_returns','staff_deductions','staff_loan_repayments','staff_loans',
    'stock_adjustment_requests','stock_dispatch_items','stock_dispatches','workflow_approval_history',
    -- set-up lists
    'container_types','delivery_routes','drivers','employee_documents','employees',
    'product_commission_rates','product_containers','product_units','products','raw_materials',
    'sales_reps','suppliers','vehicles'
  ]) AS t
  UNION ALL
  SELECT t, 'KEEP' FROM unnest(ARRAY[
    'factories','settings','profiles','user_roles','roles','role_permissions','permission_overrides',
    'workflow_configs','workflow_transitions','units_of_measure','production_types',
    'product_categories','material_categories','expense_categories'
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
ORDER BY (COALESCE(p.action, 'UNKNOWN') = 'UNKNOWN') DESC, COALESCE(p.action, 'UNKNOWN'), t.table_name;
