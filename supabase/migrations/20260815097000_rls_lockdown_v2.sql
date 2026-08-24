-- ============================================================================
-- RLS LOCKDOWN v2
-- ----------------------------------------------------------------------------
-- Closes a real gap: the original "debts write" / "payments write" FOR ALL
-- policies were gated on the legacy 'write' alias, which resolves true for
-- anyone holding just 'create' (the maker grant) — meaning a raw REST PATCH
-- could flip debts.writeoff_status or payments_received.status directly,
-- bypassing every self-approval check in the new RPCs entirely. Every
-- legitimate write to these two tables already goes through an RPC
-- (record_payment / request_debt_writeoff / approve_* / post_* / reject_* /
-- cancel_* / reverse_*), so both become RPC-only, same as payroll/user_roles.
-- ============================================================================

DROP POLICY IF EXISTS "debts write" ON public.debts;
DROP POLICY IF EXISTS "debts write payments" ON public.debt_payments;
DROP POLICY IF EXISTS "payments write" ON public.payments_received;

-- expenses: the pending-only guard from the first RLS lockdown only checked
-- the legacy approval_status column. Extend it to also cover the new status
-- column, so a raw client UPDATE/DELETE can never move an expense past
-- pending_approval outside of post_expense/reject_expense/cancel_expense.
DROP POLICY IF EXISTS "expenses update while pending" ON public.expenses;
DROP POLICY IF EXISTS "expenses delete while pending" ON public.expenses;

CREATE POLICY "expenses update while pending" ON public.expenses FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses'::module_key, 'edit'::action_key) AND status = 'pending_approval' AND approval_status = 'pending')
  WITH CHECK (status = 'pending_approval' AND approval_status = 'pending');

CREATE POLICY "expenses delete while pending" ON public.expenses FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses'::module_key, 'delete'::action_key) AND status = 'pending_approval' AND approval_status = 'pending');

-- expenses insert: the original policy never constrained the NEW status
-- column, so a crafted INSERT could set status='posted' directly at
-- creation time even though approval_status was pinned to 'pending'.
DROP POLICY IF EXISTS "expenses insert" ON public.expenses;
CREATE POLICY "expenses insert" ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (
    public.has_permission(auth.uid(), 'expenses'::module_key, 'create'::action_key)
    AND status = 'pending_approval'
    AND approval_status = 'pending'
    AND submitted_by = auth.uid()
  );
