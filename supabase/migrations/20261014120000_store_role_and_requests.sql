-- ============================================================================
-- Store: the raw-materials store, and who requests from it
-- ----------------------------------------------------------------------------
-- The Store holds all raw materials: stock is received and entered there
-- (including QC-inspected supplier deliveries), and it issues materials to
-- Production. The Warehouse raises the requests -- which product to make and
-- the raw materials it needs -- through the existing production_requests
-- flow; the Store approves a request and confirms it, which releases the
-- materials to Production (approve_production_request /
-- confirm_production_request).
--
-- New role 'store_keeper' (label "Store"). Not to be confused with
-- 'store_officer', which is the Warehouse (finished products) role -- its slug
-- predates the rename and is kept so existing assignments carry over.
-- super_admin can adjust any of this from Role Management / Permission Matrix.
-- ============================================================================

INSERT INTO public.roles (slug, label, description, is_system) VALUES
  ('store_keeper', 'Store', 'Store: stocks and receives all raw materials, approves Warehouse requests and issues the materials to Production.', true)
ON CONFLICT (slug) DO NOTHING;

-- Store: full raw-materials work (same bundle the inventory officer has),
-- request approve/reject/confirm(issue), and accepting QC-passed deliveries
-- into raw-materials stock.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'store_keeper', module, action
FROM public.role_permissions
WHERE role = 'inventory_officer' AND module = 'raw-materials'::module_key
UNION ALL
SELECT 'store_keeper', 'production-requests'::module_key, a
FROM unnest(ARRAY['view','approve','reject','confirm','print','export']::action_key[]) a
UNION ALL
SELECT 'store_keeper', 'goods-receiving'::module_key, a
FROM unnest(ARRAY['view','confirm','reject']::action_key[]) a
UNION ALL
SELECT 'store_keeper', m::module_key, 'view'::action_key
FROM unnest(ARRAY['raw-materials','suppliers','dashboard']) m
ON CONFLICT DO NOTHING;

-- Warehouse raises requests to the Store (and can withdraw its own).
INSERT INTO public.role_permissions (role, module, action)
SELECT 'store_officer', 'production-requests'::module_key, a
FROM unnest(ARRAY['view','submit','cancel','print']::action_key[]) a
ON CONFLICT DO NOTHING;
