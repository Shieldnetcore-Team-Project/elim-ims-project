-- ============================================================================
-- Maintenance role, selectable at sign-up
-- ----------------------------------------------------------------------------
-- The sign-up "Role requested" dropdown lists public.roles, so this row puts
-- "Maintenance" there. The role runs the Maintenance page (permission module
-- 'logistics', 20261028290000_maintenance_page.sql): parts inventory, stock
-- in/out, the maintenance log, requests and the vehicles register. It raises
-- issues and requests but does not approve them -- those go to the Admin, as
-- for Austin (20261028300000_aniaustin_maintenance.sql). A new account with
-- this role starts with only the Maintenance page (src/lib/page-access.ts).
-- Safe to run again.
-- ============================================================================

INSERT INTO public.roles (slug, label, description, is_system) VALUES
  ('maintenance', 'Maintenance',
   'Maintenance: runs the Maintenance page -- parts stock, maintenance log, requests and vehicles. Stock-out and requests are approved by the Admin.',
   true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.role_permissions (role, module, action)
SELECT 'maintenance', 'dashboard'::module_key, 'view'::action_key
UNION ALL
SELECT 'maintenance', 'logistics'::module_key, a
FROM unnest(ARRAY['view','create','edit','submit','cancel','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;
