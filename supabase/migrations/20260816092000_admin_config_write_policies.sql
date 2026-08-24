-- ============================================================================
-- ADMIN CONFIG WRITE POLICIES
-- ----------------------------------------------------------------------------
-- role_permissions, permission_overrides, and workflow_configs only had SELECT
-- policies for authenticated users (writes were service_role-only), because
-- until now nothing in the app needed to edit them from the client. The
-- Administration > Roles & Permissions and > Approval Workflows pages need
-- to, so this adds narrowly-scoped write policies — super_admin only, since
-- these tables control every other permission check in the system and a
-- mistake here is a full-system access change, not a per-record one.
-- ============================================================================

DROP POLICY IF EXISTS "role permissions write" ON public.role_permissions;
CREATE POLICY "role permissions write" ON public.role_permissions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

DROP POLICY IF EXISTS "permission overrides write" ON public.permission_overrides;
CREATE POLICY "permission overrides write" ON public.permission_overrides FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

DROP POLICY IF EXISTS "workflow configs write" ON public.workflow_configs;
CREATE POLICY "workflow configs write" ON public.workflow_configs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));
