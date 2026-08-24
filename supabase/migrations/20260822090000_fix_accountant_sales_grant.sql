-- ============================================================================
-- FIX: accountant never got a working 'sales' grant
-- ----------------------------------------------------------------------------
-- 20260814090000_rbac_foundation.sql seeded ('accountant','sales','read') --
-- but 'read'/'write' are only meaningful as the QUERY action passed to
-- has_permission() (where they expand into a list of concrete actions to
-- check for); a *stored* role_permissions row with the literal value 'read'
-- never equals any concrete action_key, so it can never satisfy any check.
-- 20260815094000_action_permission_and_status_engine.sql's "comprehensive
-- reseed" fixed this for every other role's legacy grant (chairman got
-- ('chairman','sales','view') at that point) but missed accountant's sales
-- grant specifically. Net effect: accountant has had zero working read
-- access to the `sales` table this whole time -- Finance Overview's
-- "Revenue (this month)" KPI and the new Sales Returns visibility both
-- depend on this and were silently returning nothing for accountant.
-- ============================================================================
INSERT INTO public.role_permissions (role, module, action)
SELECT 'accountant','sales', a FROM unnest(ARRAY['view','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;
