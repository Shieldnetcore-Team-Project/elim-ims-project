-- ============================================================================
-- MAKER-CHECKER PHASE 1 — SCHEMA
-- ----------------------------------------------------------------------------
-- Purely additive: new domain, new access tier on access_level/module_key,
-- new nullable/defaulted columns on expenses/debts/payments_received/payroll,
-- two new request tables (stock_adjustment_requests, role_grant_requests),
-- and a rank-based rewrite of has_permission()/get_my_permissions() that is
-- backward compatible with every existing 'read'/'write' check.
-- ============================================================================

-- ============ review_status domain ============
CREATE DOMAIN public.review_status AS text CHECK (VALUE IN ('pending', 'approved', 'rejected'));

-- ============ extend access_level with 'approve' ============
ALTER DOMAIN public.access_level DROP CONSTRAINT access_level_check;
ALTER DOMAIN public.access_level ADD CONSTRAINT access_level_check CHECK (VALUE IN ('read', 'write', 'approve'));

-- ============ extend module_key with 'approvals' (cross-flow queue page) ============
ALTER DOMAIN public.module_key DROP CONSTRAINT module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard', 'sales', 'production', 'production-requests', 'raw-materials', 'finished-goods',
  'inventory', 'expenses', 'payroll', 'payments', 'receipts-payments', 'cash-flow', 'debts',
  'customers', 'suppliers', 'employees', 'reports', 'users', 'account-approvals', 'audit-logs',
  'settings', 'costing', 'logistics', 'approvals'
));

-- ============ has_permission() / get_my_permissions() — rank-based rewrite ============
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _module public.module_key, _level public.access_level DEFAULT 'read')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_rank int;
  v_override_rank int;
  v_best_rank int;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;

  IF public.has_role(_user_id, 'super_admin') THEN
    RETURN true;
  END IF;

  v_rank := CASE _level WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'approve' THEN 3 END;

  SELECT CASE access WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'approve' THEN 3 END INTO v_override_rank
    FROM public.permission_overrides
   WHERE user_id = _user_id AND module = _module;
  IF v_override_rank IS NOT NULL THEN
    RETURN v_override_rank >= v_rank;
  END IF;

  SELECT MAX(CASE rp.access WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'approve' THEN 3 END) INTO v_best_rank
    FROM public.role_permissions rp
    JOIN public.user_roles ur ON ur.role = rp.role
   WHERE ur.user_id = _user_id AND rp.module = _module;

  RETURN COALESCE(v_best_rank, 0) >= v_rank;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS TABLE(module public.module_key, access public.access_level)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard', 'sales', 'production', 'production-requests', 'raw-materials', 'finished-goods',
    'inventory', 'expenses', 'payroll', 'payments', 'receipts-payments', 'cash-flow', 'debts',
    'customers', 'suppliers', 'employees', 'reports', 'users', 'account-approvals', 'audit-logs',
    'settings', 'costing', 'logistics', 'approvals'
  ]::public.module_key[];
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  FOREACH v_module IN ARRAY v_modules LOOP
    IF public.has_permission(v_uid, v_module, 'approve') THEN
      module := v_module; access := 'approve'; RETURN NEXT;
    ELSIF public.has_permission(v_uid, v_module, 'write') THEN
      module := v_module; access := 'write'; RETURN NEXT;
    ELSIF public.has_permission(v_uid, v_module, 'read') THEN
      module := v_module; access := 'read'; RETURN NEXT;
    END IF;
  END LOOP;
  RETURN;
END;
$$;

-- ============ expenses: maker/checker columns ============
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES auth.users(id);
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id);
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

UPDATE public.expenses SET submitted_by = recorded_by WHERE submitted_by IS NULL;

-- ============ debts: write-off request columns ============
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS writeoff_status text CHECK (writeoff_status IN ('requested', 'approved', 'rejected'));
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS writeoff_requested_by uuid REFERENCES auth.users(id);
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS writeoff_requested_at timestamptz;
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS writeoff_reason text;
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS writeoff_reviewed_by uuid REFERENCES auth.users(id);
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS writeoff_reviewed_at timestamptz;
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS writeoff_reject_reason text;

-- ============ payments_received: non-blocking review columns ============
ALTER TABLE public.payments_received ADD COLUMN IF NOT EXISTS review_status public.review_status NOT NULL DEFAULT 'pending';
ALTER TABLE public.payments_received ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id);
ALTER TABLE public.payments_received ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE public.payments_received ADD COLUMN IF NOT EXISTS review_note text;

-- Grandfather every pre-existing receipt as already reviewed so historical
-- rows don't flood the new confirmation queue with nobody able to attest to them.
UPDATE public.payments_received SET review_status = 'approved', reviewed_at = created_at WHERE review_status = 'pending';

-- ============ payroll: maker/checker columns + real status constraint ============
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES auth.users(id);
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS submitted_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id);
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS review_reason text;

-- Existing rows predate the status-machine: pending -> pending_approval (never
-- actually blocked before, just makes them visible in the new queue), leave
-- already-paid rows untouched rather than retroactively forcing review.
UPDATE public.payroll SET status = 'pending_approval' WHERE status = 'pending';
ALTER TABLE public.payroll DROP CONSTRAINT IF EXISTS payroll_status_check;
ALTER TABLE public.payroll ADD CONSTRAINT payroll_status_check CHECK (status IN ('pending_approval', 'approved', 'rejected', 'paid'));
ALTER TABLE public.payroll ALTER COLUMN status SET DEFAULT 'pending_approval';

-- ============ stock adjustment requests (reductions only) ============
CREATE TABLE public.stock_adjustment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('raw_material', 'finished_good')),
  material_id uuid REFERENCES public.raw_materials(id),
  product_id uuid REFERENCES public.products(id),
  quantity_delta numeric(14,3) NOT NULL CHECK (quantity_delta < 0),
  movement_type text NOT NULL DEFAULT 'adjusted' CHECK (movement_type IN ('adjusted', 'damaged')),
  reason text,
  submitted_by uuid NOT NULL REFERENCES auth.users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  review_status public.review_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_reason text,
  CHECK (
    (entity_type = 'raw_material' AND material_id IS NOT NULL AND product_id IS NULL) OR
    (entity_type = 'finished_good' AND product_id IS NOT NULL AND material_id IS NULL)
  )
);
GRANT SELECT, INSERT ON public.stock_adjustment_requests TO authenticated;
GRANT ALL ON public.stock_adjustment_requests TO service_role;
ALTER TABLE public.stock_adjustment_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stock adjustment requests read" ON public.stock_adjustment_requests FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'raw-materials', 'read') OR
    public.has_permission(auth.uid(), 'finished-goods', 'read')
  );
-- INSERT is RPC-only (request_stock_adjustment is SECURITY DEFINER); no direct
-- client INSERT/UPDATE policy is granted so approval state can't be forged client-side.

-- ============ role grant requests ============
CREATE TABLE public.role_grant_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  factory_id uuid REFERENCES public.factories(id),
  action text NOT NULL DEFAULT 'grant' CHECK (action IN ('grant', 'revoke')),
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  review_status public.review_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_reason text
);
GRANT SELECT ON public.role_grant_requests TO authenticated;
GRANT ALL ON public.role_grant_requests TO service_role;
ALTER TABLE public.role_grant_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "role grant requests read" ON public.role_grant_requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'users', 'read'));
-- INSERT/UPDATE are RPC-only (request_role_grant/request_role_revoke/approve_role_grant/reject_role_grant).
