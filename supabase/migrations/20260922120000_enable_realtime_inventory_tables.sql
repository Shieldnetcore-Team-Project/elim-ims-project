-- ============================================================================
-- REALTIME: add the tables behind Raw Materials / Finished Goods activity to
-- the supabase_realtime publication, so Postgres Changes events fire when a
-- stock adjustment, receipt, edit, etc. happens. The frontend's
-- useRealtimeInvalidate() hook (src/lib/realtime.ts), used from
-- _app.raw-materials.tsx and _app.finished-goods.tsx, subscribes to these
-- and invalidates the matching TanStack Query caches so every open tab
-- picks the change up without a manual refresh.
--
-- No table here had been added to supabase_realtime before this migration.
-- Default REPLICA IDENTITY (primary key) is fine -- the frontend only uses
-- change events as an "invalidate and refetch" signal, it doesn't read the
-- old/new row payload.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE
  public.raw_materials,
  public.material_categories,
  public.suppliers,
  public.stock_adjustment_requests,
  public.goods_receipts,
  public.damage_records,
  public.raw_material_movements,
  public.products,
  public.product_categories,
  public.production,
  public.inventory_movements,
  public.product_price_history,
  public.product_units;
