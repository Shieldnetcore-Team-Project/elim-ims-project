-- ============================================================================
-- RAW MATERIALS: moving-average cost ledger (current_value)
-- ----------------------------------------------------------------------------
-- "Total Value" on the Raw Materials page was current_stock * unit_cost --
-- unit_cost is a single flat field (in fact auto-overwritten to the LATEST
-- receipt's cost by confirm_goods_receipt), so that multiplication misprices
-- any stock actually bought at an older cost. This adds a current_value
-- column maintained in lockstep with current_stock by every function that
-- already mutates it:
--   - stock INCREASES (new material entry, goods receipt, positive
--     adjustment, transfer-in) add quantity * the cost specific to THAT
--     transaction.
--   - stock DECREASES (issue, damaged/negative adjustment, transfer-out,
--     production-request release) subtract quantity * the material's
--     current AVERAGE cost (current_value / current_stock at that moment) --
--     not unit_cost, which is just the last purchase price, not what's
--     actually on hand.
-- This is the standard "moving average cost" method. current_value stays
-- correct regardless of how many times unit_cost changes afterward.
-- ============================================================================

ALTER TABLE public.raw_materials ADD COLUMN IF NOT EXISTS current_value numeric(14,2) NOT NULL DEFAULT 0;
UPDATE public.raw_materials SET current_value = current_stock * unit_cost;

CREATE OR REPLACE FUNCTION public.avg_unit_cost(v_value numeric, v_stock numeric, v_fallback numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v_stock > 0 THEN v_value / v_stock ELSE COALESCE(v_fallback, 0) END;
$$;

-- ============ request_new_material(): seed current_value on creation ============
CREATE OR REPLACE FUNCTION public.request_new_material(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_name text := payload->>'name';
  v_category_id uuid := NULLIF(payload->>'category_id','')::uuid;
  v_unit text := payload->>'unit';
  v_opening numeric := COALESCE((payload->>'opening_stock')::numeric, 0);
  v_unit_cost numeric := COALESCE((payload->>'unit_cost')::numeric, 0);
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_reorder numeric := COALESCE((payload->>'reorder_level')::numeric, 0);
  v_minimum numeric := COALESCE((payload->>'minimum_stock')::numeric, 0);
  v_remarks text := payload->>'remarks';
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_name IS NULL OR btrim(v_name) = '' THEN RAISE EXCEPTION 'Material name is required'; END IF;
  IF v_unit IS NULL OR btrim(v_unit) = '' THEN RAISE EXCEPTION 'Unit is required'; END IF;

  INSERT INTO raw_materials(factory_id, name, category_id, unit, opening_stock, current_stock, unit_cost, current_value,
                             supplier_id, reorder_level, minimum_stock, remarks, approval_status, active, created_by)
  VALUES (v_factory, btrim(v_name), v_category_id, btrim(v_unit), v_opening, v_opening, v_unit_cost, v_opening * v_unit_cost,
          v_supplier_id, v_reorder, v_minimum, v_remarks, 'approved', true, v_uid)
  RETURNING id INTO v_id;

  IF v_opening > 0 THEN
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_id, 'opening_balance', v_opening, v_unit_cost, btrim(v_name), 'Opening balance', v_uid, 0, v_opening);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create_new_material', 'raw_materials', v_id::text, payload);

  RETURN jsonb_build_object('id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_new_material(jsonb) TO authenticated;

-- ============ confirm_goods_receipt(): value the receipt at its own cost ============
CREATE OR REPLACE FUNCTION public.confirm_goods_receipt(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req goods_receipts%ROWTYPE;
  v_before numeric;
  v_before_value numeric;
  v_before_unit_cost numeric;
  v_receipt_cost numeric;
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
  SELECT current_stock, current_value, unit_cost INTO v_before, v_before_value, v_before_unit_cost FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
  v_receipt_cost := COALESCE(v_req.unit_cost, v_before_unit_cost);
  UPDATE raw_materials SET
    current_stock = current_stock + v_req.accepted_quantity,
    current_value = v_before_value + v_req.accepted_quantity * v_receipt_cost,
    unit_cost = COALESCE(v_req.unit_cost, unit_cost),
    supplier_id = COALESCE(v_req.supplier_id, supplier_id),
    updated_at = now()
  WHERE id = v_req.material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_req.factory_id, v_req.material_id, 'received', v_req.accepted_quantity, v_receipt_cost, v_req.receipt_number,
          COALESCE(v_req.remarks, 'Goods receipt confirmed'), v_uid, v_before, v_before + v_req.accepted_quantity);

  IF v_req.damaged_quantity > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, material_id, quantity, unit, unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'INVENTORY', v_req.receipt_number, v_req.material_id, v_req.damaged_quantity, v_req.unit, v_receipt_cost,
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

-- ============ issue_raw_material(): consume at average cost ============
CREATE OR REPLACE FUNCTION public.issue_raw_material(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_reason text := payload->>'reason';
  v_reference text := payload->>'reference';
  v_purpose text := COALESCE(payload->>'purpose', 'production');
  v_movement_type movement_type;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  v_movement_type := CASE WHEN v_purpose = 'production' THEN 'used_for_production'::movement_type ELSE 'issued'::movement_type END;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF v_material.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_material.current_stock, v_qty;
  END IF;
  v_move_cost := public.avg_unit_cost(v_material.current_value, v_material.current_stock, v_material.unit_cost);

  UPDATE raw_materials SET
    current_stock = current_stock - v_qty,
    current_value = current_value - v_qty * v_move_cost,
    updated_at = now()
  WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_material.factory_id, v_material_id, v_movement_type, v_qty, v_move_cost, v_reference, v_reason, v_uid,
          v_material.current_stock, v_material.current_stock - v_qty);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.issue_raw_material(jsonb) TO authenticated;

-- ============ transfer_raw_material(): move value at source's average cost ============
CREATE OR REPLACE FUNCTION public.transfer_raw_material(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_to_factory uuid := (payload->>'to_factory_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_reason text := payload->>'reason';
  v_source raw_materials%ROWTYPE;
  v_dest_id uuid;
  v_dest_before numeric;
  v_dest_before_value numeric;
  v_move_cost numeric;
  v_move_value numeric;
  v_from_name text;
  v_to_name text;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_source FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF v_source.factory_id = v_to_factory THEN RAISE EXCEPTION 'Source and destination factory are the same'; END IF;
  IF v_source.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_source.current_stock, v_qty;
  END IF;
  v_move_cost := public.avg_unit_cost(v_source.current_value, v_source.current_stock, v_source.unit_cost);
  v_move_value := v_qty * v_move_cost;

  SELECT name INTO v_from_name FROM factories WHERE id = v_source.factory_id;
  SELECT name INTO v_to_name FROM factories WHERE id = v_to_factory;

  SELECT id INTO v_dest_id FROM raw_materials WHERE factory_id = v_to_factory AND lower(name) = lower(v_source.name) FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO raw_materials(factory_id, category, name, unit, opening_stock, current_stock, unit_cost, current_value, reorder_level, supplier_id, remarks)
    VALUES (v_to_factory, v_source.category, v_source.name, v_source.unit, 0, 0, v_source.unit_cost, 0, v_source.reorder_level, NULL, v_source.remarks)
    RETURNING id INTO v_dest_id;
  END IF;

  SELECT current_stock, current_value INTO v_dest_before, v_dest_before_value FROM raw_materials WHERE id = v_dest_id FOR UPDATE;

  UPDATE raw_materials SET current_stock = current_stock - v_qty, current_value = current_value - v_move_value, updated_at = now() WHERE id = v_material_id;
  UPDATE raw_materials SET current_stock = current_stock + v_qty, current_value = current_value + v_move_value, updated_at = now() WHERE id = v_dest_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_source.factory_id, v_material_id, 'transferred', -v_qty, v_move_cost, 'To ' || COALESCE(v_to_name,'other factory'), v_reason, v_uid,
          v_source.current_stock, v_source.current_stock - v_qty);
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_to_factory, v_dest_id, 'transferred', v_qty, v_move_cost, 'From ' || COALESCE(v_from_name,'other factory'), v_reason, v_uid,
          v_dest_before, v_dest_before + v_qty);

  RETURN jsonb_build_object('material_id', v_material_id, 'destination_id', v_dest_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.transfer_raw_material(jsonb) TO authenticated;

-- ============ post_stock_adjustment(): value adjustments/damage correctly ============
CREATE OR REPLACE FUNCTION public.post_stock_adjustment(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_before_value numeric; v_unit_cost numeric; v_unit text; v_move_cost numeric;
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
    SELECT current_stock, current_value, unit_cost, unit INTO v_before, v_before_value, v_unit_cost, v_unit FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    IF v_req.quantity_delta >= 0 THEN
      v_move_cost := v_unit_cost;
    ELSE
      v_move_cost := public.avg_unit_cost(v_before_value, v_before, v_unit_cost);
    END IF;
    UPDATE raw_materials SET
      current_stock = current_stock + v_req.quantity_delta,
      current_value = v_before_value + v_req.quantity_delta * v_move_cost,
      updated_at = now()
    WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_move_cost, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  ELSE
    SELECT current_stock, cost_price, unit INTO v_before, v_unit_cost, v_unit FROM products WHERE id = v_req.product_id FOR UPDATE;
    v_move_cost := v_unit_cost;
    UPDATE products SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, v_req.movement_type::movement_type, v_req.quantity_delta, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  END IF;

  IF v_req.movement_type = 'damaged' THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, material_id, quantity, unit, unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            CASE WHEN v_req.entity_type = 'finished_good' THEN 'STORE' ELSE 'INVENTORY' END,
            p_id::text, v_req.product_id, v_req.material_id, abs(v_req.quantity_delta), v_unit, v_move_cost,
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

-- ============ approve_production_request(): release materials at average cost ============
CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
  v_item production_request_items%ROWTYPE;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a request you submitted yourself';
  END IF;
  IF v_row.request_type = 'production_material' AND NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved'
  WHERE id = p_id;

  IF v_row.request_type = 'production_material' THEN
    FOR v_item IN SELECT * FROM production_request_items WHERE request_id = p_id LOOP
      SELECT * INTO v_material FROM raw_materials WHERE id = v_item.material_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found for this request'; END IF;
      IF v_material.current_stock < v_item.quantity_requested THEN
        RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_material.name, v_material.current_stock, v_item.quantity_requested;
      END IF;
      v_move_cost := public.avg_unit_cost(v_material.current_value, v_material.current_stock, v_material.unit_cost);

      UPDATE raw_materials SET
        current_stock = current_stock - v_item.quantity_requested,
        current_value = current_value - v_item.quantity_requested * v_move_cost,
        updated_at = now()
      WHERE id = v_item.material_id;

      INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_item.material_id, 'used_for_production', v_item.quantity_requested, v_move_cost,
              v_row.request_number, 'Production Request ' || v_row.request_number, v_uid,
              v_material.current_stock, v_material.current_stock - v_item.quantity_requested);

      UPDATE production_request_items SET quantity_issued = quantity_requested WHERE id = v_item.id;
    END LOOP;

    UPDATE production_requests SET
      materials_issued = true, issued_by_name = p_approver_name, issued_at = now(),
      production_status = 'materials_issued'
    WHERE id = p_id;
  END IF;

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_production_request(uuid, text) TO authenticated;
