-- ============================================================================
-- Finance (accountant) can receive/approve purchase requests and issue POs
-- ----------------------------------------------------------------------------
-- Purchase requests are production_requests rows with request_type='purchase'
-- (see 20260723100000_production_requests.sql), including the auto-generated
-- ones from the low-stock reorder trigger (20260913090000_procurement_auto_
-- reorder.sql) -- that trigger only creates the *request*; a person with
-- purchase-orders:create still has to issue the actual PO via
-- create_purchase_order() (20260817091000_purchase_orders_rpcs.sql).
--
-- Previously only 'chairman' could view/approve/reject production-requests
-- and only 'inventory_officer' could create purchase-orders -- 'accountant'
-- (the Finance role) had no grant on either module, so finance could not
-- receive incoming purchase requests or issue a PO themselves, whether for
-- an auto-generated request or a manual one.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
VALUES
  ('accountant', 'production-requests', 'view'),
  ('accountant', 'production-requests', 'approve'),
  ('accountant', 'production-requests', 'reject'),
  ('accountant', 'purchase-orders', 'create')
ON CONFLICT (role, module, action) DO NOTHING;
