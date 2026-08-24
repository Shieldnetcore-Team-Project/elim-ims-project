-- ============================================================================
-- GOODS RECEIVING DUAL CONTROL — schema (spec 16)
-- ----------------------------------------------------------------------------
-- New module 'goods-receiving' + table `goods_receipts`, wired into the same
-- workflow engine (workflow_status/record_workflow_action/
-- workflow_approval_progress/assert_valid_transition/workflow_configs) that
-- expenses/debts/payments/payroll/stock-writeoffs already use. RPCs land in
-- the next migration.
-- ============================================================================

-- ============ 1. module_key: add 'goods-receiving' ============
-- module_key is a text DOMAIN (unlike movement_type, a real enum), so this
-- can be added and used in the same transaction/file with no restriction.
ALTER DOMAIN public.module_key DROP CONSTRAINT module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard', 'sales', 'production', 'production-requests', 'raw-materials', 'finished-goods',
  'inventory', 'expenses', 'payroll', 'payments', 'receipts-payments', 'cash-flow', 'debts',
  'customers', 'suppliers', 'employees', 'reports', 'users', 'account-approvals', 'audit-logs',
  'settings', 'costing', 'logistics', 'approvals', 'goods-receiving'
));

-- get_my_permissions() hardcodes its module list -- add the new one here too
-- (same signature/return type, plain replace, no DROP needed).
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS TABLE(module public.module_key, action public.action_key)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_action public.action_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','raw-materials','finished-goods',
    'inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics','approvals','goods-receiving'
  ]::public.module_key[];
  v_concrete_actions public.action_key[] := ARRAY[
    'view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete'
  ]::public.action_key[];
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF public.has_role(v_uid, 'super_admin') THEN
    FOREACH v_module IN ARRAY v_modules LOOP
      FOREACH v_action IN ARRAY v_concrete_actions LOOP
        module := v_module; action := v_action; RETURN NEXT;
      END LOOP;
    END LOOP;
    RETURN;
  END IF;
  FOREACH v_module IN ARRAY v_modules LOOP
    FOREACH v_action IN ARRAY v_concrete_actions LOOP
      IF public.has_permission(v_uid, v_module, v_action) THEN
        module := v_module; action := v_action; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  RETURN;
END;
$$;

-- ============ 2. goods_receipts ============
CREATE TABLE public.goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  receipt_number text UNIQUE NOT NULL,
  material_id uuid NOT NULL REFERENCES public.raw_materials(id),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit text,
  unit_cost numeric(14,2),
  supplier_id uuid REFERENCES public.suppliers(id),
  purchase_request_id uuid REFERENCES public.production_requests(id),
  delivery_reference text,
  remarks text,
  status public.workflow_status NOT NULL DEFAULT 'pending_confirmation',
  submitted_by uuid NOT NULL REFERENCES auth.users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz,
  reject_reason text
);
GRANT SELECT ON public.goods_receipts TO authenticated;
GRANT ALL ON public.goods_receipts TO service_role;
ALTER TABLE public.goods_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "goods receipts read" ON public.goods_receipts FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key));
-- No INSERT/UPDATE policy: RPC-only, same pattern as stock_adjustment_requests/debts.

-- ============ 3. workflow_transitions: allow the maker to cancel their own
-- still-pending submission (the only leg not already covered) ============
INSERT INTO public.workflow_transitions (from_status, to_status) VALUES ('pending_confirmation','cancelled')
ON CONFLICT DO NOTHING;

-- ============ 4. workflow_configs ============
INSERT INTO public.workflow_configs (module, transaction_type, maker_label, checker_label, final_status, required_approvals, description) VALUES
  ('goods-receiving', 'goods_receipt', 'Receiving Officer', 'Authorized Checker', 'posted', 1,
   'Goods received against a purchase/production request, confirmed by a different person before posting to stock.')
ON CONFLICT (module) DO NOTHING;
