-- ============================================================================
-- SPLIT SALES RETURNS FROM SALES
-- ----------------------------------------------------------------------------
-- "Sales" and "Sales Returns" are two separate sidebar pages, but every gate
-- behind Sales Returns (its RLS policy, create_sales_return, inspect_sales_return,
-- cancel_sales_return) checks module 'sales' -- the same module the Sales page
-- itself uses. So granting/denying one has always silently granted/denied the
-- other too, with no way to separate them. This migration gives Sales Returns
-- its own module, 'sales-returns', and copies the current 'sales' grants onto
-- it so nobody's effective access changes the moment this runs.
-- ============================================================================

-- ============ 1. module_key: add 'sales-returns' ============
-- 'inventory' is a legacy value (superseded by raw-materials/finished-goods,
-- no longer in get_my_permissions()'s v_modules below) but old role_permissions
-- rows still carry it, so it has to stay in this list or the ALTER fails.
ALTER DOMAIN public.module_key DROP CONSTRAINT module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
  'finance','inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
  'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
  'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns'
));

-- ============ 2. get_my_permissions(): surface the new module to the UI ============
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS TABLE(module public.module_key, action public.action_key)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_action public.action_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
    'finance','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns'
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

-- ============ 3. sales_returns RLS: check the new module ============
DROP POLICY IF EXISTS "sales returns read" ON public.sales_returns;
CREATE POLICY "sales returns read" ON public.sales_returns FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales-returns'::module_key, 'view'::action_key));

-- ============ 4. sales-returns RPCs: check the new module ============
CREATE OR REPLACE FUNCTION public.create_sales_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_sale_id uuid := NULLIF(payload->>'sale_id','')::uuid;
  v_customer_id uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity_returned')::numeric;
  v_reason text := payload->>'reason';
  v_product products%ROWTYPE;
  v_number text; v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales-returns'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity returned must be > 0'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  IF v_sale_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM sales WHERE id = v_sale_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Sale not found for this factory';
    END IF;
  END IF;

  v_number := 'SR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned, unit, reason, received_by)
  VALUES (v_factory, v_number, v_sale_id, v_customer_id, v_product_id, v_qty, v_product.unit, v_reason, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'return_number', v_number);
END; $$;

CREATE OR REPLACE FUNCTION public.inspect_sales_return(p_id uuid, p_accepted numeric, p_damaged numeric, p_rejected numeric, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales_returns%ROWTYPE;
  v_before numeric;
BEGIN
  SELECT * INTO v_row FROM sales_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales-returns'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Inspection must be done by someone other than who logged the return';
  END IF;
  IF v_row.status <> 'received' THEN RAISE EXCEPTION 'This return has already been inspected'; END IF;
  IF COALESCE(p_accepted,0) < 0 OR COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN
    RAISE EXCEPTION 'Quantities cannot be negative';
  END IF;
  IF COALESCE(p_accepted,0) + COALESCE(p_damaged,0) + COALESCE(p_rejected,0) <> v_row.quantity_returned THEN
    RAISE EXCEPTION 'Accepted + damaged + rejected must equal the % returned', v_row.quantity_returned;
  END IF;

  UPDATE sales_returns SET
    accepted_quantity = p_accepted, damaged_quantity = COALESCE(p_damaged,0), rejected_quantity = COALESCE(p_rejected,0),
    inspected_by = v_uid, inspected_at = now(), status = 'completed', notes = p_notes
  WHERE id = p_id;

  IF COALESCE(p_accepted,0) > 0 THEN
    SELECT current_stock INTO v_before FROM products WHERE id = v_row.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + p_accepted, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'returned', p_accepted, v_row.return_number, 'Accepted sales return', v_uid, v_before, v_before + p_accepted);
  END IF;

  IF COALESCE(p_damaged,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'SALES_RETURN', v_row.return_number, v_row.product_id, p_damaged, v_row.unit, 'Damaged on sales return inspection', v_uid, 'posted');
  END IF;

  RETURN jsonb_build_object('completed', true, 'accepted', p_accepted, 'damaged', p_damaged, 'rejected', p_rejected);
END; $$;

CREATE OR REPLACE FUNCTION public.cancel_sales_return(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row sales_returns%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM sales_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales-returns'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.status <> 'received' THEN RAISE EXCEPTION 'Only an uninspected return can be cancelled'; END IF;
  UPDATE sales_returns SET status = 'cancelled', notes = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('cancelled', true);
END; $$;

-- ============ 5. seed role_permissions: copy today's 'sales' grants onto 'sales-returns' ============
-- Keeps every existing role's effective access to the Sales Returns page
-- identical to what it was a moment ago, now expressed as its own module
-- instead of piggybacking on 'sales'.
INSERT INTO public.role_permissions (role, module, action)
SELECT role, 'sales-returns', action FROM public.role_permissions WHERE module = 'sales'
ON CONFLICT DO NOTHING;
