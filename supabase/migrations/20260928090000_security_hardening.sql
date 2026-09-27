-- Security hardening: close the gaps that only required "signed in".
--
-- Public signup is open and confirmation emails are off, so anyone on the
-- internet can get an `authenticated` session. Their profile starts 'pending'
-- with no row in user_roles, so has_permission() already refuses them
-- everywhere it's used. The policies below were the exceptions: they checked
-- the role name only, which let a brand-new, unapproved account read every
-- staff profile, read/overwrite/delete HR files and receipts, replace the
-- company logo, and write arbitrary audit_logs rows.

-- ============ helper: approved member of staff ============
-- True once an admin has approved the account and given it a role. Pending,
-- rejected, suspended and deactivated accounts have no user_roles row
-- (set_user_status deletes it), so they all come back false.
CREATE OR REPLACE FUNCTION public.is_staff_member()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid());
$$;

REVOKE ALL ON FUNCTION public.is_staff_member() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff_member() TO authenticated;

-- ============ workflow_transitions: RLS was never enabled ============
-- Only `authenticated` has a grant (SELECT), and the SECURITY DEFINER guards
-- that read it bypass RLS, so this keeps behaviour identical while removing
-- the one table without RLS.
ALTER TABLE public.workflow_transitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflow transitions read" ON public.workflow_transitions;
CREATE POLICY "workflow transitions read" ON public.workflow_transitions
  FOR SELECT TO authenticated
  USING (true);

-- ============ profiles: team directory is staff-only ============
-- "read own profile" stays, so a pending user can still see their own status.
DROP POLICY IF EXISTS "read team profiles" ON public.profiles;
CREATE POLICY "read team profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (public.is_staff_member());

-- ============ audit_logs: no anonymous or forged-author rows ============
-- src/lib/audit.ts always writes user_id = the caller. SECURITY DEFINER RPCs
-- insert as the table owner and are unaffected.
DROP POLICY IF EXISTS "insert audit logs" ON public.audit_logs;
CREATE POLICY "insert audit logs" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============ storage: bucket limits ============
UPDATE storage.buckets
   SET file_size_limit = 5 * 1024 * 1024,
       allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp','image/gif','image/svg+xml']
 WHERE id IN ('avatars', 'company-logos');

UPDATE storage.buckets
   SET file_size_limit = 10 * 1024 * 1024
 WHERE id IN ('employee-files', 'expense-attachments');

-- ============ storage: employee-files (HR documents, staff photos) ============
DROP POLICY IF EXISTS "auth read employee files" ON storage.objects;
DROP POLICY IF EXISTS "auth upload employee files" ON storage.objects;
DROP POLICY IF EXISTS "auth delete employee files" ON storage.objects;

CREATE POLICY "auth read employee files" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'employee-files'
         AND public.has_permission(auth.uid(), 'employees'::public.module_key, 'read'::public.action_key));

CREATE POLICY "auth upload employee files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'employee-files'
              AND public.has_permission(auth.uid(), 'employees'::public.module_key, 'write'::public.action_key));

CREATE POLICY "auth delete employee files" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'employee-files'
         AND public.has_permission(auth.uid(), 'employees'::public.module_key, 'write'::public.action_key));

-- ============ storage: expense-attachments (receipts) ============
DROP POLICY IF EXISTS "auth read expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "auth upload expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "auth delete own expense attachments" ON storage.objects;

CREATE POLICY "auth read expense attachments" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'expense-attachments'
         AND public.has_permission(auth.uid(), 'expenses'::public.module_key, 'read'::public.action_key));

CREATE POLICY "auth upload expense attachments" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'expense-attachments'
              AND public.has_permission(auth.uid(), 'expenses'::public.module_key, 'write'::public.action_key));

CREATE POLICY "auth delete own expense attachments" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'expense-attachments'
         AND (owner = auth.uid()
              OR public.has_permission(auth.uid(), 'expenses'::public.module_key, 'write'::public.action_key)));

-- ============ storage: company-logos (public read stays) ============
DROP POLICY IF EXISTS "auth upload company logos" ON storage.objects;
DROP POLICY IF EXISTS "auth update company logos" ON storage.objects;
DROP POLICY IF EXISTS "auth delete company logos" ON storage.objects;

CREATE POLICY "auth upload company logos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'company-logos'
              AND public.has_permission(auth.uid(), 'settings'::public.module_key, 'write'::public.action_key));

CREATE POLICY "auth update company logos" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'company-logos'
         AND public.has_permission(auth.uid(), 'settings'::public.module_key, 'write'::public.action_key))
  WITH CHECK (bucket_id = 'company-logos'
              AND public.has_permission(auth.uid(), 'settings'::public.module_key, 'write'::public.action_key));

CREATE POLICY "auth delete company logos" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'company-logos'
         AND public.has_permission(auth.uid(), 'settings'::public.module_key, 'write'::public.action_key));

-- ============ storage: avatars (public read stays) ============
-- src/routes/_app.settings.tsx uploads to `${userId}/...`, so each user may
-- only write inside their own folder.
DROP POLICY IF EXISTS "auth upload avatars" ON storage.objects;
DROP POLICY IF EXISTS "auth update avatars" ON storage.objects;
DROP POLICY IF EXISTS "auth delete avatars" ON storage.objects;

CREATE POLICY "auth upload avatars" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars'
              AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "auth update avatars" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "auth delete avatars" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
