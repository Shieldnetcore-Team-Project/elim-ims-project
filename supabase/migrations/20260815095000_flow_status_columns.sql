-- ============================================================================
-- APPLY THE CANONICAL WORKFLOW STATUS TO THE 6 MAKER-CHECKER FLOWS
-- ----------------------------------------------------------------------------
-- Every flow gets a `status public.workflow_status` column as its new
-- authoritative state. Legacy ad hoc status columns (approval_status,
-- review_status, the old payroll/writeoff status values) are kept in place
-- and synced by the RPCs in the next migration, so any not-yet-updated
-- frontend query reading the old column name keeps showing correct data.
-- Two columns (payroll.status, debts.writeoff_status) are converted IN PLACE
-- rather than duplicated, since they already meant exactly this and having
-- two differently-named "status" columns on the same table would itself be
-- the kind of inconsistency this migration exists to remove.
-- ============================================================================

-- ============ expenses ============
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS status public.workflow_status NOT NULL DEFAULT 'pending_approval';
UPDATE public.expenses SET status = CASE approval_status
  WHEN 'pending' THEN 'pending_approval'
  WHEN 'approved' THEN 'posted'
  WHEN 'rejected' THEN 'rejected'
  ELSE 'pending_approval'
END;

-- ============ debts: convert writeoff_status in place ============
ALTER TABLE public.debts ALTER COLUMN writeoff_status DROP DEFAULT;
ALTER TABLE public.debts ALTER COLUMN writeoff_status DROP NOT NULL;
ALTER TABLE public.debts DROP CONSTRAINT IF EXISTS debts_writeoff_status_check;
UPDATE public.debts SET writeoff_status = CASE writeoff_status
  WHEN 'requested' THEN 'pending_approval'
  WHEN 'approved' THEN 'posted'
  WHEN 'rejected' THEN 'rejected'
  ELSE NULL
END;
ALTER TABLE public.debts ALTER COLUMN writeoff_status TYPE public.workflow_status USING writeoff_status::public.workflow_status;

-- ============ payments_received ============
ALTER TABLE public.payments_received ADD COLUMN IF NOT EXISTS status public.workflow_status NOT NULL DEFAULT 'pending_confirmation';
UPDATE public.payments_received SET status = CASE review_status
  WHEN 'pending' THEN 'pending_confirmation'
  WHEN 'approved' THEN 'confirmed'
  WHEN 'rejected' THEN 'rejected'
  ELSE 'pending_confirmation'
END;

-- ============ payroll: convert status in place ============
UPDATE public.payroll SET status = 'paid' WHERE status IS NULL; -- guard against any unexpected NULLs before cast
ALTER TABLE public.payroll ALTER COLUMN status DROP DEFAULT;
ALTER TABLE public.payroll DROP CONSTRAINT IF EXISTS payroll_status_check;
UPDATE public.payroll SET status = CASE status
  WHEN 'pending' THEN 'pending_approval'
  WHEN 'pending_approval' THEN 'pending_approval'
  WHEN 'approved' THEN 'approved'
  WHEN 'rejected' THEN 'rejected'
  WHEN 'paid' THEN 'posted'
  ELSE 'pending_approval'
END;
ALTER TABLE public.payroll ALTER COLUMN status TYPE public.workflow_status USING status::public.workflow_status;
ALTER TABLE public.payroll ALTER COLUMN status SET DEFAULT 'pending_approval';
ALTER TABLE public.payroll ALTER COLUMN status SET NOT NULL;

-- ============ stock_adjustment_requests ============
ALTER TABLE public.stock_adjustment_requests ADD COLUMN IF NOT EXISTS status public.workflow_status NOT NULL DEFAULT 'pending_approval';
UPDATE public.stock_adjustment_requests SET status = CASE review_status
  WHEN 'pending' THEN 'pending_approval'
  WHEN 'approved' THEN 'posted'
  WHEN 'rejected' THEN 'rejected'
  ELSE 'pending_approval'
END;

-- ============ role_grant_requests ============
ALTER TABLE public.role_grant_requests ADD COLUMN IF NOT EXISTS status public.workflow_status NOT NULL DEFAULT 'pending_approval';
UPDATE public.role_grant_requests SET status = CASE review_status
  WHEN 'pending' THEN 'pending_approval'
  WHEN 'approved' THEN 'posted'
  WHEN 'rejected' THEN 'rejected'
  ELSE 'pending_approval'
END;
