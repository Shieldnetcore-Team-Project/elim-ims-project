-- ============================================================================
-- GOODS RECEIVING — damaged/accepted quantity split (spec: Goods Receiving)
-- ----------------------------------------------------------------------------
-- goods_receipts only ever tracked a single `quantity` and posted all of it to
-- raw_materials.current_stock on confirm — damaged material would have
-- silently inflated usable stock. Spec requires capturing Ordered (via the
-- linked PO)/Received/Damaged/Accepted quantities separately, and only the
-- accepted portion may ever reach stock. Modeled on the same
-- accepted/damaged split confirm_production_batch/inspect_sales_return
-- already use (20260820090000_damage_records_and_sales_returns.sql), damaged
-- quantity feeds the same damage_records ledger, tagged 'INVENTORY' per that
-- migration's own established convention for raw materials.
-- ============================================================================

ALTER TABLE public.goods_receipts
  ADD COLUMN damaged_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  ADD COLUMN accepted_quantity numeric(14,3) GENERATED ALWAYS AS (quantity - damaged_quantity) STORED;
ALTER TABLE public.goods_receipts
  ADD CONSTRAINT goods_receipts_damaged_le_quantity CHECK (damaged_quantity <= quantity);

CREATE OR REPLACE FUNCTION public.submit_goods_receipt(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_purchase_order_id uuid := NULLIF(payload->>'purchase_order_id','')::uuid;
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_damaged numeric := COALESCE(NULLIF(payload->>'damaged_quantity','')::numeric, 0);
  v_unit_cost numeric := NULLIF(payload->>'unit_cost','')::numeric;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_purchase_request_id uuid := NULLIF(payload->>'purchase_request_id','')::uuid;
  v_delivery_reference text := payload->>'delivery_reference';
  v_remarks text := payload->>'remarks';
  v_material raw_materials%ROWTYPE;
  v_po purchase_orders%ROWTYPE;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_damaged < 0 OR v_damaged > v_qty THEN RAISE EXCEPTION 'Damaged quantity must be between 0 and the received quantity'; END IF;

  IF v_purchase_order_id IS NOT NULL THEN
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_purchase_order_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
    IF v_po.status NOT IN ('issued','partially_received') THEN RAISE EXCEPTION 'Purchase order is %, not open for receiving', v_po.status; END IF;
    IF v_qty > (v_po.quantity_ordered - v_po.quantity_received) THEN
      RAISE EXCEPTION 'Quantity exceeds the % still outstanding on this purchase order', (v_po.quantity_ordered - v_po.quantity_received);
    END IF;
    v_material_id := v_po.material_id;
    v_supplier_id := COALESCE(v_supplier_id, v_po.supplier_id);
    v_purchase_request_id := v_po.purchase_request_id;
    v_unit_cost := COALESCE(v_unit_cost, v_po.unit_cost);
  END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;

  IF v_purchase_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM production_requests WHERE id = v_purchase_request_id AND factory_id = v_material.factory_id) THEN
      RAISE EXCEPTION 'Purchase request not found for this factory';
    END IF;
  END IF;

  v_number := 'GR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO goods_receipts(factory_id, receipt_number, material_id, quantity, damaged_quantity, unit, unit_cost, supplier_id,
                              purchase_request_id, purchase_order_id, delivery_reference, remarks, submitted_by)
  VALUES (v_material.factory_id, v_number, v_material_id, v_qty, v_damaged, v_material.unit, v_unit_cost, v_supplier_id,
          v_purchase_request_id, v_purchase_order_id, v_delivery_reference, v_remarks, v_uid)
  RETURNING id INTO v_id;

  PERFORM public.record_workflow_action('goods-receiving', v_id, 'submit', NULL, 'pending_confirmation', v_remarks);
  RETURN jsonb_build_object('id', v_id, 'receipt_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_goods_receipt(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_goods_receipt(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req goods_receipts%ROWTYPE;
  v_before numeric;
  v_po_received numeric;
  v_po_status text;
BEGIN
  SELECT * INTO v_req FROM goods_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt not found'; END IF;
  IF NOT public.has_permission(v_uid, 'goods-receiving', 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot confirm a goods receipt you submitted yourself — dual control requires a different person';
  END IF;

  PERFORM public.assert_valid_transition(v_req.status, 'confirmed');
  UPDATE goods_receipts SET status = 'confirmed', confirmed_by = v_uid, confirmed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'confirm', v_req.status, 'confirmed', p_comment);

  PERFORM public.assert_valid_transition('confirmed', 'posted');
  SELECT current_stock INTO v_before FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
  UPDATE raw_materials SET
    current_stock = current_stock + v_req.accepted_quantity,
    unit_cost = COALESCE(v_req.unit_cost, unit_cost),
    supplier_id = COALESCE(v_req.supplier_id, supplier_id),
    updated_at = now()
  WHERE id = v_req.material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_req.factory_id, v_req.material_id, 'received', v_req.accepted_quantity, v_req.unit_cost, v_req.receipt_number,
          COALESCE(v_req.remarks, 'Goods receipt confirmed'), v_uid, v_before, v_before + v_req.accepted_quantity);

  IF v_req.damaged_quantity > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, material_id, quantity, unit, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'INVENTORY', v_req.receipt_number, v_req.material_id, v_req.damaged_quantity, v_req.unit,
            'Damaged on goods receipt', v_req.submitted_by, v_uid, 'posted');
  END IF;

  UPDATE goods_receipts SET status = 'posted' WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'post', 'confirmed', 'posted', p_comment);

  IF v_req.purchase_order_id IS NOT NULL THEN
    UPDATE purchase_orders SET quantity_received = quantity_received + v_req.quantity
    WHERE id = v_req.purchase_order_id
    RETURNING quantity_received, (CASE WHEN quantity_received >= quantity_ordered THEN 'received' ELSE 'partially_received' END)
    INTO v_po_received, v_po_status;
    UPDATE purchase_orders SET status = v_po_status WHERE id = v_req.purchase_order_id;

    IF v_po_status = 'received' THEN
      UPDATE production_requests SET production_status = 'completed'
      WHERE id = (SELECT purchase_request_id FROM purchase_orders WHERE id = v_req.purchase_order_id) AND request_type = 'purchase';
    END IF;
  ELSIF v_req.purchase_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed' WHERE id = v_req.purchase_request_id AND request_type = 'purchase';
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'confirm_goods_receipt', 'goods_receipts', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.accepted_quantity));

  RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_req.accepted_quantity);
END; $$;
GRANT EXECUTE ON FUNCTION public.confirm_goods_receipt(uuid, text) TO authenticated;
