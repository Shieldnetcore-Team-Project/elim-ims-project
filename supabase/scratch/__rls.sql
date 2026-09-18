
-- ---------- RLS policies hardcoded to super_admin, outside has_permission() ----------
DROP POLICY IF EXISTS "permission overrides read own" ON public.permission_overrides;
CREATE POLICY "permission overrides read own" ON public.permission_overrides FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "role permissions write" ON public.role_permissions;
CREATE POLICY "role permissions write" ON public.role_permissions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "permission overrides write" ON public.permission_overrides;
CREATE POLICY "permission overrides write" ON public.permission_overrides FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "workflow configs write" ON public.workflow_configs;
CREATE POLICY "workflow configs write" ON public.workflow_configs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "roles write" ON public.roles;
CREATE POLICY "roles write" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "roles update" ON public.roles;
CREATE POLICY "roles update" ON public.roles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

-- Can't delete a system role, ever -- unchanged. Chairman just also gets to
-- delete non-system roles now, same as super_admin already could.
DROP POLICY IF EXISTS "roles delete" ON public.roles;
CREATE POLICY "roles delete" ON public.roles FOR DELETE TO authenticated
  USING ((public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')) AND NOT is_system);

DROP POLICY IF EXISTS "sales read deleted" ON public.sales;
CREATE POLICY "sales read deleted" ON public.sales FOR SELECT TO authenticated
  USING ((public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')) AND deleted_at IS NOT NULL);

DROP POLICY IF EXISTS "delete requests read" ON public.delete_requests;
CREATE POLICY "delete requests read" ON public.delete_requests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman') OR requested_by = auth.uid());

-- ---------- cleanup: drop the temporary source-reader helper ----------
DROP FUNCTION IF EXISTS public.__temp_get_source(text);
