-- ============================================================================
-- ROLE PERMISSIONS — inventory_officer approves production material requests
-- ----------------------------------------------------------------------------
-- Described workflow: production (water/nylon) sends a raw-material request
-- to Inventory, who approves it and releases the physical stock. Until now,
-- only chairman/accountant (20260816100000_role_permission_seed_goods_
-- receiving_purchase.sql:29, 20260914110000_finance_receive_requests_and_
-- create_po.sql:20-22) could approve/reject production_requests -- inventory
-- itself never held the approve action, only submit/cancel. This adds
-- inventory_officer alongside them (not instead of -- chairman/accountant
-- stay as-is, e.g. for the separate 'purchase'-type requests that go to a
-- supplier and legitimately belong to Finance).
--
-- approve_production_request()/reject_production_request() also check
-- has_production_scope_access() for request_type='production_material'
-- (20260819090000_production_scope_types_packaging.sql:400,430) -- that's a
-- per-user profiles.production_scope attribute (default 'BOTH'), independent
-- of role, so it doesn't block this grant for an inventory_officer covering
-- both lines.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
VALUES
  ('inventory_officer', 'production-requests', 'approve'),
  ('inventory_officer', 'production-requests', 'reject')
ON CONFLICT (role, module, action) DO NOTHING;
