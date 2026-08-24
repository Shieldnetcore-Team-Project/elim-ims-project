-- ============================================================================
-- PURCHASE ORDERS — schema
-- ----------------------------------------------------------------------------
-- Closes the gap between an approved purchase-type production_request and
-- goods receiving: today approval just stamps a free-text po_number onto the
-- request with no real document, no supplier-facing artifact, and nothing
-- for goods receiving to match against. This adds a real purchase_orders
-- entity: one PO per approved purchase request, auto-numbered, printable,
-- carrying its own received-quantity/status so goods receiving can post
-- partial or full receipts against it.
-- ============================================================================

-- ============ 1. module_key: add 'purchase-orders' ============
ALTER DOMAIN public.module_key DROP CONSTRAINT module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard', 'sales', 'production', 'production-requests', 'purchase-orders', 'raw-materials', 'finished-goods',
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
    'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
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

-- ============ 2. production_requests: allow 'po_issued' as an intermediate status ============
ALTER TABLE public.production_requests DROP CONSTRAINT IF EXISTS production_requests_production_status_check;
ALTER TABLE public.production_requests ADD CONSTRAINT production_requests_production_status_check
  CHECK (production_status IN ('pending','approved','po_issued','materials_issued','completed','rejected','cancelled'));

-- ============ 3. purchase_orders ============
CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  po_number text UNIQUE NOT NULL,
  purchase_request_id uuid NOT NULL UNIQUE REFERENCES public.production_requests(id),
  supplier_id uuid REFERENCES public.suppliers(id),
  material_id uuid NOT NULL REFERENCES public.raw_materials(id),
  quantity_ordered numeric(14,3) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received numeric(14,3) NOT NULL DEFAULT 0,
  unit text,
  unit_cost numeric(14,2),
  expected_delivery_date date,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','partially_received','received','cancelled')),
  notes text,
  issued_by uuid REFERENCES auth.users(id),
  issued_by_name text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.purchase_orders TO authenticated;
GRANT ALL ON public.purchase_orders TO service_role;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "purchase orders read" ON public.purchase_orders FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'purchase-orders'::module_key, 'view'::action_key));
-- No INSERT/UPDATE policy: RPC-only, same pattern as goods_receipts/production_requests.

-- ============ 4. goods_receipts: match against a purchase order ============
ALTER TABLE public.goods_receipts ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES public.purchase_orders(id);
