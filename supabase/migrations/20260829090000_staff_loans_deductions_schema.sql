-- ============================================================================
-- STAFF LOANS + FINES/CONTRIBUTIONS — schema
-- ----------------------------------------------------------------------------
-- Payroll already reads basic salary + allowances straight off employees.*
-- (process_payroll, 20260816110000). What it lacks is any record of a soft
-- loan a staff took before payday, a repayment schedule, or a place to log a
-- fine / staff contribution so it lands on the next salary run.
--
--   staff_loans            one row per loan, one-time or installment repay,
--                          maker -> checker before it becomes deductible
--   staff_loan_repayments  the per-period slices a payroll run schedules and
--                          then confirms when it is posted (paid)
--   staff_deductions       fines / contributions for a given payroll period,
--                          also maker -> checker
--
-- All three are RPC-only (no INSERT/UPDATE policy) exactly like
-- sales_returns / damage_records in 20260820090000. Read is gated on the
-- payroll module's view action.
-- ============================================================================

-- ============ 1. staff_loans ============
CREATE TABLE public.staff_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  loan_number text UNIQUE NOT NULL,
  principal numeric(14,2) NOT NULL CHECK (principal > 0),
  disbursed_on date NOT NULL DEFAULT current_date,
  repayment_type text NOT NULL CHECK (repayment_type IN ('one_time','installment')),
  installment_mode text CHECK (installment_mode IN ('amount','months')),
  installment_amount numeric(14,2) CHECK (installment_amount IS NULL OR installment_amount > 0),
  installment_months integer CHECK (installment_months IS NULL OR installment_months > 0),
  amount_repaid numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_repaid >= 0),
  outstanding numeric(14,2) GENERATED ALWAYS AS (principal - amount_repaid) STORED,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','settled','cancelled','rejected')),
  reason text,
  remarks text,
  submitted_by uuid REFERENCES auth.users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- an installment loan must say how it is sized
  CONSTRAINT staff_loans_installment_shape CHECK (
    repayment_type = 'one_time'
    OR (installment_mode = 'amount'  AND installment_amount IS NOT NULL)
    OR (installment_mode = 'months'  AND installment_months IS NOT NULL)
  )
);
GRANT SELECT ON public.staff_loans TO authenticated;
GRANT ALL ON public.staff_loans TO service_role;
ALTER TABLE public.staff_loans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff loans read" ON public.staff_loans FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'payroll'::module_key, 'view'::action_key));
CREATE TRIGGER staff_loans_touch BEFORE UPDATE ON public.staff_loans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_staff_loans_employee ON public.staff_loans(employee_id, status);

-- ============ 2. staff_loan_repayments ============
CREATE TABLE public.staff_loan_repayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES public.staff_loans(id) ON DELETE CASCADE,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  payroll_id uuid REFERENCES public.payroll(id) ON DELETE SET NULL,
  period_month integer NOT NULL,
  period_year integer NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','paid','void')),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
GRANT SELECT ON public.staff_loan_repayments TO authenticated;
GRANT ALL ON public.staff_loan_repayments TO service_role;
ALTER TABLE public.staff_loan_repayments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff loan repayments read" ON public.staff_loan_repayments FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'payroll'::module_key, 'view'::action_key));
CREATE INDEX idx_staff_loan_repayments_payroll ON public.staff_loan_repayments(payroll_id);
CREATE INDEX idx_staff_loan_repayments_loan ON public.staff_loan_repayments(loan_id, status);

-- ============ 3. staff_deductions (fines / contributions) ============
CREATE TABLE public.staff_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  reference_number text UNIQUE NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fine','contribution','other')),
  label text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year integer NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','applied','void','rejected')),
  reason text,
  applied_payroll_id uuid REFERENCES public.payroll(id) ON DELETE SET NULL,
  submitted_by uuid REFERENCES auth.users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.staff_deductions TO authenticated;
GRANT ALL ON public.staff_deductions TO service_role;
ALTER TABLE public.staff_deductions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff deductions read" ON public.staff_deductions FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'payroll'::module_key, 'view'::action_key));
CREATE TRIGGER staff_deductions_touch BEFORE UPDATE ON public.staff_deductions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_staff_deductions_period
  ON public.staff_deductions(employee_id, period_year, period_month, status);
