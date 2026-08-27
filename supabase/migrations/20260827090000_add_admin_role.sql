-- ============================================================================
-- ADD 'admin' ROLE
-- ----------------------------------------------------------------------------
-- Adds a distinct system role 'admin', separate from 'super_admin'. Unlike
-- super_admin (which has_permission()/is_admin() short-circuit to true for),
-- 'admin' carries NO module access until a super_admin grants it rows in
-- public.role_permissions via Role Management (src/routes/_app.permissions.tsx).
--
-- is_system = true so it can't be deleted from the UI ("roles delete" policy
-- in 20260816093000). FKs on user_roles.role and profiles.role_requested
-- both point at roles(slug), so seeding this row is all that's needed for it
-- to be assignable and requestable at signup.
-- ============================================================================

INSERT INTO public.roles (slug, label, is_system) VALUES
  ('admin', 'Admin', true)
ON CONFLICT (slug) DO NOTHING;
