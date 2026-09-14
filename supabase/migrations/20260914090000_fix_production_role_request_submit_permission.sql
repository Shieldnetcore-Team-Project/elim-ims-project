-- ============================================================================
-- FIX — 'production' role could never submit a production request
-- ----------------------------------------------------------------------------
-- 20260815094000_action_permission_and_status_engine.sql gave the 'production'
-- role the generic CRUD bundle on 'production-requests' (view/create/edit/
-- delete/export/print), assuming that preserved its original maker rights.
-- But production-requests is a maker/checker workflow module: the create
-- flow (both the "New Request" button in the UI and the create_production_
-- request RPC) is gated on the 'submit' action, not 'create'. Without it,
-- production staff could see the Production Requests page and its table but
-- the "New Request" button never rendered for them.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT 'production','production-requests', a FROM unnest(ARRAY['submit','cancel']::action_key[]) a
ON CONFLICT DO NOTHING;
