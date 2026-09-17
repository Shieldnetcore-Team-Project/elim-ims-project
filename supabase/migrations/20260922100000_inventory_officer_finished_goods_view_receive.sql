-- ============================================================================
-- ROLE PERMISSIONS — inventory_officer: view + receive only on Finished Goods
-- ----------------------------------------------------------------------------
-- inventory_officer previously had zero grants on the finished-goods module,
-- so the page-level `RequireAccess module="finished-goods"` check (which
-- needs 'view') was already blocking them entirely. This grants exactly:
--   - finished-goods: view       -> see the Available Stock table, history,
--                                    packaging/conversion rules (read-only)
--   - production: view/confirm/reject -> "receive" a submitted production
--                                    batch into finished-goods stock, or
--                                    reject a bad one (the app's actual
--                                    goods-receiving flow for finished goods,
--                                    see confirm_production_batch /
--                                    reject_production_batch RPCs)
-- No create/edit/submit/approve/post/cancel on finished-goods is granted, so
-- Add/Edit Product, Adjust Stock, Log Damage, Transfer, and write-off
-- approve/post/cancel stay unavailable to this role (also newly hidden in
-- the UI, not just blocked server-side -- see src/routes/_app.finished-goods.tsx).
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT 'inventory_officer', 'finished-goods', a FROM unnest(ARRAY['view']::action_key[]) a
UNION ALL
SELECT 'inventory_officer', 'production', a FROM unnest(ARRAY['view','confirm','reject']::action_key[]) a
ON CONFLICT DO NOTHING;
