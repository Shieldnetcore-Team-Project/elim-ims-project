-- ============================================================================
-- DISTRIBUTION (Sales Reps) — role permission seed
-- ----------------------------------------------------------------------------
-- Same shape as 20260816103000_role_permission_seed_production_confirmation.sql.
-- role_permissions.role is now text FK -> roles.slug; module/action are the
-- module_key / action_key domains.
--
--   store_officer  issues dispatches out of the store and inspects rep
--                  returns coming back in  -> view/create/edit/reverse/confirm/cancel
--   sales          maintains the rep directory and logs rep returns; rep
--                  SALES themselves go through the existing 'sales' grant
--                  -> view/create/edit/submit/cancel
--   accountant /   record remittances and read rep accounts -> view/post/export/print
--   cashier
--   chairman       oversight / escalation checker -> view/confirm/reverse
--   logistics      read-only visibility of what left the store -> view
--
-- super_admin needs no row (has_permission() short-circuits).
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT 'store_officer', 'distribution', a
FROM unnest(ARRAY['view','create','edit','reverse','confirm','cancel']::action_key[]) a
UNION ALL
SELECT 'sales', 'distribution', a
FROM unnest(ARRAY['view','create','edit','submit','cancel']::action_key[]) a
UNION ALL
SELECT 'accountant', 'distribution', a
FROM unnest(ARRAY['view','post','export','print']::action_key[]) a
UNION ALL
SELECT 'cashier', 'distribution', a
FROM unnest(ARRAY['view','post']::action_key[]) a
UNION ALL
SELECT 'chairman', 'distribution', a
FROM unnest(ARRAY['view','confirm','reverse']::action_key[]) a
UNION ALL
SELECT 'logistics', 'distribution', a
FROM unnest(ARRAY['view']::action_key[]) a
ON CONFLICT DO NOTHING;
