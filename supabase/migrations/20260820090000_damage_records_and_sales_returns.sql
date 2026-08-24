-- ============================================================================
-- DAMAGE RECORDS (central ledger) + SALES RETURNS (staged inspection)
-- ----------------------------------------------------------------------------
-- damage_records is never written to directly by a user action of its own --
-- it's populated as a side effect of the flows that already determine
-- something is damaged (Store confirming a production batch, an approved
-- stock write-off, a sales-return inspection), so "damage" can never just
-- silently change a quantity: every row here traces back to a real
-- maker-checker transaction elsewhere. DELIVERY and STORE/INVENTORY are
-- included in the source_type CHECK per spec even though only PRODUCTION,
-- STORE/INVENTORY (via stock_adjustment_requests) and SALES_RETURN are wired
-- up to actually write rows today.
--
-- sales_returns replaces the old finished-goods "Log Return" button, which
-- was already broken (it submitted movement_type='returned' into
-- stock_adjustment_requests, whose CHECK constraint only allows
-- 'adjusted'/'damaged', and whose request_stock_adjustment() requires a
-- NEGATIVE delta -- a return can never have been posted through it). Returns
-- now go through their own RECEIVED -> INSPECTED (accept/damage/reject split)
-- -> only the accepted portion ever reaches sellable stock, and only after
-- someone other than the receiver inspects it.
-- ============================================================================

-- ============ 1. damage_records ============
CREATE TABLE public.damage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference_number text UNIQUE NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('PRODUCTION','STORE','SALES_RETURN','DELIVERY','INVENTORY')),
  source_reference text,
  product_id uuid REFERENCES public.products(id),
  material_id uuid REFERENCES public.raw_materials(id),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit text,
  reason text,
  reported_by uuid NOT NULL REFERENCES auth.users(id),
  approved_by uuid REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT damage_records_item_check CHECK (
    (product_id IS NOT NULL AND material_id IS NULL) OR (product_id IS NULL AND material_id IS NOT NULL)
  )
);
GRANT SELECT ON public.damage_records TO authenticated;
GRANT ALL ON public.damage_records TO service_role;
ALTER TABLE public.damage_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "damage records read" ON public.damage_records FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'reports'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key)
  );
-- No INSERT/UPDATE policy: written only from within SECURITY DEFINER RPCs below.
CREATE TRIGGER damage_records_touch BEFORE UPDATE ON public.damage_records FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ 2. confirm_production_batch(): also logs damage/reject to the ledger ============
CREATE OR REPLACE FUNCTION public.confirm_production_batch(
  p_id uuid, p_actual_received numeric, p_damaged numeric, p_rejected numeric, p_comment text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_row production%ROWTYPE; v_accepted numeric; v_before numeric;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production', 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Store confirmation must be done by someone other than who recorded the batch';
  END IF;
  IF p_actual_received IS NULL OR p_actual_received < 0 THEN RAISE EXCEPTION 'Actual quantity received must be >= 0'; END IF;
  IF COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN RAISE EXCEPTION 'Damaged/rejected quantities cannot be negative'; END IF;
  IF COALESCE(p_damaged,0) + COALESCE(p_rejected,0) > p_actual_received THEN
    RAISE EXCEPTION 'Damaged + rejected cannot exceed actual quantity received';
  END IF;
  v_accepted := p_actual_received - COALESCE(p_damaged,0) - COALESCE(p_rejected,0);

  PERFORM public.assert_valid_transition(v_row.status, 'confirmed');
  UPDATE production SET
    actual_quantity_received = p_actual_received, damaged_quantity = COALESCE(p_damaged,0),
    rejected_quantity = COALESCE(p_rejected,0), accepted_quantity = v_accepted,
    confirmed_by = v_uid, confirmed_at = now(), status = 'confirmed'
  WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'confirm', v_row.status, 'confirmed', p_comment);

  PERFORM public.assert_valid_transition('confirmed', 'posted');
  SELECT current_stock INTO v_before FROM products WHERE id = v_row.product_id FOR UPDATE;
  UPDATE products SET current_stock = current_stock + v_accepted, updated_at = now() WHERE id = v_row.product_id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_row.factory_id, v_row.product_id, 'produced', v_accepted, v_row.production_number,
          'Production batch confirmed by Store', v_uid, v_before, v_before + v_accepted);
  UPDATE production SET status = 'posted' WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'post', 'confirmed', 'posted', p_comment);

  IF COALESCE(p_damaged,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_damaged, v_row.unit, 'Damaged during Store confirmation', v_uid, 'posted');
  END IF;
  IF COALESCE(p_rejected,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_rejected, v_row.unit, 'Rejected during Store confirmation', v_uid, 'posted');
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_production_batch', 'production', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_accepted, 'accepted_quantity', v_accepted));

  RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_accepted);
END; $$;
GRANT EXECUTE ON FUNCTION public.confirm_production_batch(uuid, numeric, numeric, numeric, text) TO authenticated;

-- ============ 3. post_stock_adjustment(): also logs 'damaged' write-offs to the ledger ============
CREATE OR REPLACE FUNCTION public.post_stock_adjustment(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_unit_cost numeric; v_unit text;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot post a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'posted');

  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, unit_cost, unit INTO v_before, v_unit_cost, v_unit FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    UPDATE raw_materials SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_unit_cost, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  ELSE
    SELECT current_stock, unit INTO v_before, v_unit FROM products WHERE id = v_req.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, v_req.movement_type::movement_type, v_req.quantity_delta, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  END IF;

  IF v_req.movement_type = 'damaged' THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, material_id, quantity, unit, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            CASE WHEN v_req.entity_type = 'finished_good' THEN 'STORE' ELSE 'INVENTORY' END,
            p_id::text, v_req.product_id, v_req.material_id, abs(v_req.quantity_delta), v_unit,
            v_req.reason, v_req.submitted_by, v_uid, 'posted');
  END IF;

  UPDATE stock_adjustment_requests SET status = 'posted', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action(v_module, p_id, 'post', v_req.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'post_stock_adjustment', v_req.entity_type, COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity_delta));
  RETURN jsonb_build_object('posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.post_stock_adjustment(uuid, text) TO authenticated;

-- ============ 4. sales_returns ============
CREATE TABLE public.sales_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  return_number text UNIQUE NOT NULL,
  sale_id uuid REFERENCES public.sales(id),
  customer_id uuid REFERENCES public.customers(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity_returned numeric(14,3) NOT NULL CHECK (quantity_returned > 0),
  unit text,
  reason text,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','completed','cancelled')),
  accepted_quantity numeric(14,3),
  damaged_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  rejected_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  received_by uuid NOT NULL REFERENCES auth.users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  inspected_by uuid REFERENCES auth.users(id),
  inspected_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.sales_returns TO authenticated;
GRANT ALL ON public.sales_returns TO service_role;
ALTER TABLE public.sales_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sales returns read" ON public.sales_returns FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key));
-- No INSERT/UPDATE policy: RPC-only.

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
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.create_sales_return(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.inspect_sales_return(p_id uuid, p_accepted numeric, p_damaged numeric, p_rejected numeric, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales_returns%ROWTYPE;
  v_before numeric;
BEGIN
  SELECT * INTO v_row FROM sales_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.inspect_sales_return(uuid, numeric, numeric, numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_sales_return(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row sales_returns%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM sales_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.status <> 'received' THEN RAISE EXCEPTION 'Only an uninspected return can be cancelled'; END IF;
  UPDATE sales_returns SET status = 'cancelled', notes = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_sales_return(uuid, text) TO authenticated;

-- ============ 5. role permissions: who can submit vs inspect a sales return ============
-- sales/cashier log the return (front-of-house, same people who take the sale);
-- store_officer physically inspects condition (same role that already verifies
-- production batches); chairman is the escalation/oversight path, as elsewhere.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'sales','sales', a FROM unnest(ARRAY['submit','cancel']::action_key[]) a
UNION ALL
SELECT 'cashier','sales', a FROM unnest(ARRAY['submit','cancel']::action_key[]) a
UNION ALL
SELECT 'store_officer','sales', a FROM unnest(ARRAY['view','confirm']::action_key[]) a
UNION ALL
SELECT 'chairman','sales', a FROM unnest(ARRAY['confirm']::action_key[]) a
ON CONFLICT DO NOTHING;
