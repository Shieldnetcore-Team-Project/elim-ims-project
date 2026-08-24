-- ============================================================================
-- ROLE PERMISSIONS — purchase-orders
-- ----------------------------------------------------------------------------
-- Same per-flow INSERT ... SELECT ... UNION ALL ... ON CONFLICT DO NOTHING
-- shape used throughout the earlier role-permission seed migrations.
--
-- inventory_officer issues POs off requests they (or a colleague) already got
-- approved, and can cancel one that was issued in error; chairman gets
-- oversight (view/print/export/cancel) as the escalation path, matching
-- their role on goods-receiving and production-requests.
-- ============================================================================
INSERT INTO public.role_permissions (role, module, action)
SELECT 'inventory_officer','purchase-orders', a FROM unnest(ARRAY['view','create','cancel','print','export']::action_key[]) a
UNION ALL
SELECT 'chairman','purchase-orders', a FROM unnest(ARRAY['view','cancel','print','export']::action_key[]) a
ON CONFLICT DO NOTHING;
