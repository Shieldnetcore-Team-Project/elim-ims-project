-- ============================================================================
-- FIX: cashier role couldn't see the customer dropdown in New Sale
-- ----------------------------------------------------------------------------
-- The `customers` table's RLS read policy is gated on module 'customers'
-- (20260814093000_rls_permission_rewrite.sql:76-77), but `cashier` -- the
-- role whose whole job is recording sales at the register, and who already
-- holds full sales/sales-returns/payments CRUD -- never had any grant on
-- the 'customers' module at all. In practice this meant the "Customer"
-- dropdown in New Sale (customers-brief query in _app.sales.tsx) silently
-- returned empty for a cashier-only account, leaving only "Walk-in"
-- selectable -- discovered while adding the inline customer account panel
-- (outstanding debt / recent payments) to that same dropdown, which would
-- have been just as silently empty. `sales` role already has full
-- customers:* access; cashier only needs to look customers up, not manage
-- them, so it gets view (+ create, since create_sale can create a new
-- customer record for a named walk-in on a cashier's behalf already).
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
VALUES
  ('cashier', 'customers', 'view'),
  ('cashier', 'customers', 'create')
ON CONFLICT (role, module, action) DO NOTHING;
