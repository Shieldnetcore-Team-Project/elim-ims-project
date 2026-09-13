-- ============================================================================
-- Cashier role can create sales but couldn't read the product list
-- ----------------------------------------------------------------------------
-- The `cashier` role has full sales:* access (create/edit/delete/submit/
-- cancel/view/export/print) but no finished-goods grant at all, and the
-- products table's RLS SELECT policy is gated on finished-goods:view/read,
-- not on sales. In practice this meant a cashier's "New Sale" product
-- dropdown returned zero rows -- the same symptom as the has_permission bug
-- fixed in 20260912110000, but caused by a real seeding gap rather than the
-- broken function. Every other role with sales create/edit already carries
-- this exact grant (e.g. the `sales` role has finished-goods:view); cashier
-- was the only one missing it.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
VALUES ('cashier', 'finished-goods', 'view')
ON CONFLICT (role, module, action) DO NOTHING;
