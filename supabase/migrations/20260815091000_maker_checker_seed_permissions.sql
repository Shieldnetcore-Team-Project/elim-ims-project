-- ============================================================================
-- MAKER-CHECKER PHASE 1 — APPROVE-TIER PERMISSION GRANTS
-- ----------------------------------------------------------------------------
-- Bumps existing role_permissions rows from 'read'/'write' up to 'approve'
-- (never removes access — approve implies write implies read per the ranked
-- has_permission() rewrite) and adds the few genuinely new rows needed
-- (users approve for chairman, since nobody had any 'users' row before; and
-- read on the new 'approvals' queue page for chairman/accountant).
-- super_admin is untouched — it has no role_permissions rows and bypasses
-- has_permission() unconditionally, same as before this migration.
-- ============================================================================

-- Expenses: accountant becomes maker+checker (self-approval still blocked by
-- the RPC's submitted_by check, not by permission tier); chairman becomes checker.
UPDATE public.role_permissions SET access = 'approve' WHERE role = 'accountant' AND module = 'expenses';
UPDATE public.role_permissions SET access = 'approve' WHERE role = 'chairman' AND module = 'expenses';

-- Debt write-offs: chairman is the sole checker; accountant stays write-only
-- (creates the write-off request, cannot approve their own).
UPDATE public.role_permissions SET access = 'approve' WHERE role = 'chairman' AND module = 'debts';

-- Payment confirmation: accountant and chairman become checkers; cashier stays
-- write-only (records payments at the counter, cannot self-confirm).
UPDATE public.role_permissions SET access = 'approve' WHERE role = 'accountant' AND module = 'payments';
UPDATE public.role_permissions SET access = 'approve' WHERE role = 'chairman' AND module = 'payments';

-- Payroll: chairman is the sole checker; payroll_officer stays write-only.
UPDATE public.role_permissions SET access = 'approve' WHERE role = 'chairman' AND module = 'payroll';

-- Stock write-offs (reductions only): chairman is the sole checker for both
-- raw-materials and finished-goods; inventory_officer/store_officer stay write-only.
UPDATE public.role_permissions SET access = 'approve' WHERE role = 'chairman' AND module = 'raw-materials';
UPDATE public.role_permissions SET access = 'approve' WHERE role = 'chairman' AND module = 'finished-goods';

-- Role grants: nobody but super_admin has any 'users' access today, so this
-- is a new row, not an upgrade. Chairman becomes the checker for role grants.
INSERT INTO public.role_permissions (role, module, access) VALUES ('chairman', 'users', 'approve')
ON CONFLICT (role, module) DO UPDATE SET access = 'approve';

-- Approvals queue page: read-only visibility for the two checker roles.
INSERT INTO public.role_permissions (role, module, access) VALUES
  ('chairman', 'approvals', 'read'),
  ('accountant', 'approvals', 'read')
ON CONFLICT (role, module) DO NOTHING;
