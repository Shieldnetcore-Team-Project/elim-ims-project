-- ============================================================================
-- ROLE PERMISSIONS — goods-receiving + purchase-type production-requests
-- ----------------------------------------------------------------------------
-- Same per-flow INSERT ... SELECT ... UNION ALL ... ON CONFLICT DO NOTHING
-- shape used throughout 20260815094000_action_permission_and_status_engine.sql.
-- Sensible existing-role defaults -- super_admin can reassign via the
-- Role Management / Permission Matrix pages without a migration.
-- ============================================================================

-- Goods receiving: inventory_officer is the Receiving Officer (maker);
-- store_officer physically checks what arrived (checker); chairman can also
-- confirm as a fallback/escalation path.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'inventory_officer','goods-receiving', a FROM unnest(ARRAY['view','submit','cancel']::action_key[]) a
UNION ALL
SELECT 'store_officer','goods-receiving', a FROM unnest(ARRAY['view','confirm','reject']::action_key[]) a
UNION ALL
SELECT 'chairman','goods-receiving', a FROM unnest(ARRAY['view','confirm','reject']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Production-requests: inventory_officer gains maker rights for the new
-- purchase-type flow (was view-only); chairman becomes the checker (was
-- view-only too -- nobody could legally approve before this fix). The
-- `production` role's existing full-CRUD bundle on this module (the
-- original materials-request maker path) is untouched.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'inventory_officer','production-requests', a FROM unnest(ARRAY['submit','cancel']::action_key[]) a
UNION ALL
SELECT 'chairman','production-requests', a FROM unnest(ARRAY['approve','reject']::action_key[]) a
ON CONFLICT DO NOTHING;
