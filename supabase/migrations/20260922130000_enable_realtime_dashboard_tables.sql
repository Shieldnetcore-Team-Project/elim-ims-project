-- ============================================================================
-- REALTIME: extend supabase_realtime to the tables the Dashboard's role
-- variants (Admin, Sales, Inventory, Production, Store, Finance) read, so
-- the same useRealtimeInvalidate() live-refresh pattern used on Raw
-- Materials / Finished Goods (20260922120000_enable_realtime_inventory_tables.sql)
-- also covers dashboard KPIs and recent-activity feeds.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE
  public.sales,
  public.debts,
  public.expenses,
  public.audit_logs,
  public.payroll,
  public.role_grant_requests,
  public.payments_received,
  public.customers,
  public.production_requests,
  public.deliveries,
  public.purchase_orders,
  public.sales_returns;
