-- ============================================================================
-- GOODS RECEIVING DUAL CONTROL — RPCs (spec 16)
-- ----------------------------------------------------------------------------
-- Modeled directly on request_stock_adjustment/approve_stock_adjustment/
-- post_stock_adjustment (20260816091000_workflow_engine_retrofit.sql:560-676).
-- Per spec 16's own "simpler variant" (2 human steps: maker submits, checker
-- confirms), confirm_goods_receipt does the confirm AND post transitions in
-- one call rather than requiring a separate post step.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_goods_receipt(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_unit_cost numeric := NULLIF(payload->>'unit_cost','')::numeric;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_purchase_request_id uuid := NULLIF(payload->>'purchase_request_id','')::uuid;
  v_delivery_reference text := payload->>'delivery_reference';
  v_remarks text := payload->>'remarks';
  v_material raw_materials%ROWTYPE;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;

  IF v_purchase_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM production_requests WHERE id = v_purchase_request_id AND factory_id = v_material.factory_id) THEN
      RAISE EXCEPTION 'Purchase request not found for this factory';
    END IF;
  END IF;

  v_number := 'GR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO goods_receipts(factory_id, receipt_number, material_id, quantity, unit, unit_cost, supplier_id,
                              purchase_request_id, delivery_reference, remarks, submitted_by)
  VALUES (v_material.factory_id, v_number, v_material_id, v_qty, v_material.unit, v_unit_cost, v_supplier_id,
          v_purchase_request_id, v_delivery_reference, v_remarks, v_uid)
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

  IF v_req.purchase_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed' WHERE id = v_req.purchase_request_id AND request_type = 'purchase';
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'confirm_goods_receipt', 'goods_receipts', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity));

  RETURN jsonb_build_object('confirmed', true, 'posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.confirm_goods_receipt(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_goods_receipt(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req goods_receipts%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a goods receipt'; END IF;
  SELECT * INTO v_req FROM goods_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt not found'; END IF;
  IF NOT public.has_permission(v_uid, 'goods-receiving', 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a goods receipt you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'rejected');

  UPDATE goods_receipts SET status = 'rejected', confirmed_by = v_uid, confirmed_at = now(), reject_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'reject', v_req.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_goods_receipt(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_goods_receipt(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req goods_receipts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving', 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM goods_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt not found'; END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'cancelled');

  UPDATE goods_receipts SET status = 'cancelled' WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'cancel', v_req.status, 'cancelled', p_reason);
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_goods_receipt(uuid, text) TO authenticated;

-- Retire the instant, single-person receiving path.
REVOKE EXECUTE ON FUNCTION public.receive_raw_material(jsonb) FROM authenticated;
