-- ============================================================================
-- PURCHASE ORDERS — RPCs
-- ----------------------------------------------------------------------------
-- create_purchase_order() turns an approved purchase-type production_request
-- into a formal, auto-numbered PO. approve_production_request() no longer
-- stamps a fake po_number at approval time -- that number now only exists
-- once a real purchase_orders row is issued. submit_goods_receipt()/
-- confirm_goods_receipt() are extended to optionally match against a PO,
-- posting partial/full quantity_received and flipping its status, while the
-- existing PO-less path (direct material receipt) keeps working unchanged.
-- ============================================================================

-- ============ 1. approve_production_request(): drop the fake po_number stamp ============
CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a request you submitted yourself';
  END IF;

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved'
  WHERE id = p_id;

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_production_request(uuid, text) TO authenticated;

-- ============ 2. create_purchase_order(): issue a PO from an approved purchase request ============
CREATE OR REPLACE FUNCTION public.create_purchase_order(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_request_id uuid := (payload->>'purchase_request_id')::uuid;
  v_issued_by_name text := payload->>'issued_by_name';
  v_quantity numeric := (payload->>'quantity_ordered')::numeric;
  v_unit_cost numeric := NULLIF(payload->>'unit_cost','')::numeric;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_expected date := NULLIF(payload->>'expected_delivery_date','')::date;
  v_notes text := payload->>'notes';
  v_req production_requests%ROWTYPE;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'purchase-orders', 'create'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_issued_by_name IS NULL OR btrim(v_issued_by_name) = '' THEN RAISE EXCEPTION 'Issuer name is required'; END IF;

  SELECT * INTO v_req FROM production_requests WHERE id = v_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase request not found'; END IF;
  IF v_req.request_type <> 'purchase' THEN RAISE EXCEPTION 'Only purchase-type requests can have a purchase order'; END IF;
  IF v_req.approval_status <> 'approved' THEN RAISE EXCEPTION 'Request must be approved before a purchase order can be issued'; END IF;
  IF EXISTS (SELECT 1 FROM purchase_orders WHERE purchase_request_id = v_request_id) THEN
    RAISE EXCEPTION 'A purchase order already exists for this request';
  END IF;

  IF v_quantity IS NULL OR v_quantity <= 0 THEN v_quantity := v_req.quantity_requested; END IF;
  IF v_supplier_id IS NULL THEN v_supplier_id := v_req.supplier_id; END IF;

  v_number := 'PO-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO purchase_orders(factory_id, po_number, purchase_request_id, supplier_id, material_id,
                               quantity_ordered, unit, unit_cost, expected_delivery_date, notes,
                               issued_by, issued_by_name)
  VALUES (v_req.factory_id, v_number, v_request_id, v_supplier_id, v_req.material_id,
          v_quantity, v_req.unit, v_unit_cost, v_expected, v_notes,
          v_uid, v_issued_by_name)
  RETURNING id INTO v_id;

  UPDATE production_requests SET po_number = v_number, production_status = 'po_issued' WHERE id = v_request_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_req.factory_id, 'create', 'purchase_orders', v_id::text, jsonb_build_object('po_number', v_number, 'quantity_ordered', v_quantity));

  RETURN jsonb_build_object('id', v_id, 'po_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_purchase_order(jsonb) TO authenticated;

-- ============ 3. cancel_purchase_order(): void a PO before it's (fully) received ============
CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid(); v_po purchase_orders%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'purchase-orders', 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_po FROM purchase_orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF v_po.status = 'received' THEN RAISE EXCEPTION 'Cannot cancel a fully received purchase order'; END IF;
  IF v_po.status = 'cancelled' THEN RAISE EXCEPTION 'Purchase order is already cancelled'; END IF;

  UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason WHERE id = p_id;
  UPDATE production_requests SET production_status = 'cancelled' WHERE id = v_po.purchase_request_id AND production_status IN ('approved','po_issued');

  RETURN jsonb_build_object('cancelled', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order(uuid, text) TO authenticated;

-- ============ 4. submit_goods_receipt(): optionally match against an issued PO ============
CREATE OR REPLACE FUNCTION public.submit_goods_receipt(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_purchase_order_id uuid := NULLIF(payload->>'purchase_order_id','')::uuid;
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
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

  INSERT INTO goods_receipts(factory_id, receipt_number, material_id, quantity, unit, unit_cost, supplier_id,
                              purchase_request_id, purchase_order_id, delivery_reference, remarks, submitted_by)
  VALUES (v_material.factory_id, v_number, v_material_id, v_qty, v_material.unit, v_unit_cost, v_supplier_id,
          v_purchase_request_id, v_purchase_order_id, v_delivery_reference, v_remarks, v_uid)
  RETURNING id INTO v_id;

  PERFORM public.record_workflow_action('goods-receiving', v_id, 'submit', NULL, 'pending_confirmation', v_remarks);
  RETURN jsonb_build_object('id', v_id, 'receipt_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_goods_receipt(jsonb) TO authenticated;

-- ============ 5. confirm_goods_receipt(): post PO quantity_received/status too ============
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
    current_stock = current_stock + v_req.quantity,
    unit_cost = COALESCE(v_req.unit_cost, unit_cost),
    supplier_id = COALESCE(v_req.supplier_id, supplier_id),
    updated_at = now()
  WHERE id = v_req.material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_req.factory_id, v_req.material_id, 'received', v_req.quantity, v_req.unit_cost, v_req.receipt_number,
          COALESCE(v_req.remarks, 'Goods receipt confirmed'), v_uid, v_before, v_before + v_req.quantity);

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
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity));

  RETURN jsonb_build_object('confirmed', true, 'posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.confirm_goods_receipt(uuid, text) TO authenticated;
