-- =============================================================================
-- 20260803120700_realtime_publication.sql
-- Only operationally "live" tables join the realtime publication — dashboards,
-- approval queues, the audit feed, and user notifications. Static lookups
-- (departments, uoms, ...) are deliberately excluded: nothing subscribes to
-- change events on data that only an admin edits a few times a year.
--
-- All seven have a real primary key (UUID or BIGSERIAL), so the default
-- REPLICA IDENTITY is sufficient — no per-table ALTER TABLE ... REPLICA
-- IDENTITY needed.
-- =============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE
  public.inventory_transactions,
  public.sales_orders,
  public.purchase_orders,
  public.delivery_runs,
  public.activity_log,
  public.deletion_requests,
  public.notifications;
