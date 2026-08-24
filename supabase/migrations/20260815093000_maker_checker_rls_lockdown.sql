-- ============================================================================
-- MAKER-CHECKER PHASE 1 — RLS LOCKDOWN
-- ----------------------------------------------------------------------------
-- Removes the direct-client write paths that the new RPC-driven approval
-- flows would otherwise bypass. Must ship in the same deploy as the frontend
-- changes to expenses/payroll/users, since it removes capabilities those
-- pages previously used directly.
-- ============================================================================

-- ============ expenses: split FOR ALL into scoped INSERT/UPDATE/DELETE ============
-- INSERT: caller must have write access, must self-attribute (submitted_by),
--   and can only ever create a 'pending' row (approval only happens via RPC).
-- UPDATE: only while still pending, and the new row must also still be
--   pending — a raw client PATCH can therefore never flip approval_status
--   away from 'pending', only approve_expense/reject_expense (SECURITY
--   DEFINER, bypasses RLS) can do that.
-- DELETE: only while still pending.
DROP POLICY IF EXISTS "expenses write" ON public.expenses;

CREATE POLICY "expenses insert" ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (
    public.has_permission(auth.uid(), 'expenses', 'write')
    AND approval_status = 'pending'
    AND submitted_by = auth.uid()
  );

CREATE POLICY "expenses update while pending" ON public.expenses FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses', 'write') AND approval_status = 'pending')
  WITH CHECK (approval_status = 'pending');

CREATE POLICY "expenses delete while pending" ON public.expenses FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses', 'write') AND approval_status = 'pending');

-- ============ payroll: RPC-only from here (process_payroll/approve_payroll/reject_payroll) ============
DROP POLICY IF EXISTS "payroll write" ON public.payroll;

-- ============ user_roles: RPC-only from here (request_role_grant/approve_role_grant/...) ============
DROP POLICY IF EXISTS "users write roles" ON public.user_roles;
