-- ============================================================================
-- COSTING CALCULATOR + DUAL CONTROL — RPCs
-- ----------------------------------------------------------------------------
-- Modeled on submit_goods_receipt/confirm_goods_receipt/reject_goods_receipt/
-- cancel_goods_receipt (direct pending_approval -> posted hop -- costing is a
-- pure numeric review, not a physical-quantity reconciliation, so no
-- intermediate confirm step is needed) and update_production/cancel_production
-- for the pre-approval edit leg.
-- ============================================================================

-- ============ 1. submit_costing_sheet(): replaces create_costing_sheet ============
CREATE OR REPLACE FUNCTION public.submit_costing_sheet(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_yield numeric := (payload->>'yield_quantity')::numeric;
  v_labor numeric := COALESCE((payload->>'labor_cost')::numeric, 0);
  v_overhead_percent numeric := NULLIF(payload->>'overhead_percent','')::numeric;
  v_overhead numeric;
  v_pack_qty numeric := COALESCE((payload->>'pack_quantity')::numeric, 1);
  v_pack_cost numeric := COALESCE((payload->>'pack_cost')::numeric, 0);
  v_apply boolean := COALESCE((payload->>'apply_to_product')::boolean, false);
  v_notes text := payload->>'notes';
  v_items jsonb := payload->'items';
  v_price_options jsonb := payload->'price_options';
  v_item jsonb;
  v_price jsonb;
  v_material raw_materials%ROWTYPE;
  v_qty numeric;
  v_line numeric;
  v_material_cost numeric := 0;
  v_total numeric;
  v_unit_cost numeric;
  v_cost_per_pack numeric;
  v_proposed numeric;
  v_margin numeric;
  v_number text;
  v_sheet_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'costing', 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_yield IS NULL OR v_yield <= 0 THEN RAISE EXCEPTION 'Yield quantity must be > 0'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one material line is required'; END IF;

  PERFORM 1 FROM products WHERE id = v_product_id AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found for this factory'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material % not found', v_item->>'material_id'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Material quantity must be > 0'; END IF;
    v_line := v_qty * v_material.unit_cost;
    v_material_cost := v_material_cost + v_line;
  END LOOP;

  IF v_overhead_percent IS NOT NULL THEN
    v_overhead := round(v_material_cost * v_overhead_percent / 100, 2);
  ELSE
    v_overhead := COALESCE((payload->>'overhead_cost')::numeric, 0);
  END IF;

  v_total := v_material_cost + v_labor + v_overhead;
  v_unit_cost := v_total / v_yield;
  v_cost_per_pack := v_unit_cost * v_pack_qty + v_pack_cost;

  v_number := 'CST-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO costing_sheets(factory_id, product_id, sheet_number, yield_quantity, labor_cost, overhead_cost,
                              overhead_percent, pack_quantity, pack_cost, cost_per_pack,
                              material_cost, total_cost, unit_cost, apply_to_product, notes, created_by)
  VALUES (v_factory, v_product_id, v_number, v_yield, v_labor, v_overhead,
          v_overhead_percent, v_pack_qty, v_pack_cost, v_cost_per_pack,
          v_material_cost, v_total, v_unit_cost, v_apply, v_notes, v_uid)
  RETURNING id INTO v_sheet_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    INSERT INTO costing_sheet_items(sheet_id, material_id, quantity, unit_cost, line_total)
    VALUES (v_sheet_id, v_material.id, v_qty, v_material.unit_cost, v_qty * v_material.unit_cost);
  END LOOP;

  IF v_price_options IS NOT NULL THEN
    FOR v_price IN SELECT * FROM jsonb_array_elements(v_price_options) LOOP
      v_proposed := (v_price->>'proposed_price')::numeric;
      IF v_proposed IS NOT NULL AND v_proposed >= 0 THEN
        v_margin := v_proposed - v_cost_per_pack;
        INSERT INTO costing_price_options(sheet_id, proposed_price, margin, margin_percent)
        VALUES (v_sheet_id, v_proposed, v_margin,
                CASE WHEN v_proposed > 0 THEN round(v_margin / v_proposed * 100, 2) ELSE 0 END);
      END IF;
    END LOOP;
  END IF;

  PERFORM public.record_workflow_action('costing', v_sheet_id, 'submit', NULL, 'pending_approval', v_notes);
  RETURN jsonb_build_object('id', v_sheet_id, 'sheet_number', v_number, 'unit_cost', v_unit_cost,
                             'total_cost', v_total, 'cost_per_pack', v_cost_per_pack);
END;
$$;
GRANT EXECUTE ON FUNCTION public.submit_costing_sheet(jsonb) TO authenticated;

-- ============ 2. update_costing_sheet(): pre-approval edits only ============
CREATE OR REPLACE FUNCTION public.update_costing_sheet(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := (payload->>'id')::uuid;
  v_yield numeric := (payload->>'yield_quantity')::numeric;
  v_labor numeric := COALESCE((payload->>'labor_cost')::numeric, 0);
  v_overhead_percent numeric := NULLIF(payload->>'overhead_percent','')::numeric;
  v_overhead numeric;
  v_pack_qty numeric := COALESCE((payload->>'pack_quantity')::numeric, 1);
  v_pack_cost numeric := COALESCE((payload->>'pack_cost')::numeric, 0);
  v_apply boolean := COALESCE((payload->>'apply_to_product')::boolean, false);
  v_notes text := payload->>'notes';
  v_items jsonb := payload->'items';
  v_price_options jsonb := payload->'price_options';
  v_item jsonb;
  v_price jsonb;
  v_material raw_materials%ROWTYPE;
  v_qty numeric;
  v_line numeric;
  v_material_cost numeric := 0;
  v_total numeric;
  v_unit_cost numeric;
  v_cost_per_pack numeric;
  v_proposed numeric;
  v_margin numeric;
  v_row costing_sheets%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'costing', 'edit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM costing_sheets WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF v_row.status <> 'pending_approval' THEN RAISE EXCEPTION 'Cannot edit a costing sheet after it has been reviewed'; END IF;
  IF v_yield IS NULL OR v_yield <= 0 THEN RAISE EXCEPTION 'Yield quantity must be > 0'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one material line is required'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material % not found', v_item->>'material_id'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Material quantity must be > 0'; END IF;
    v_line := v_qty * v_material.unit_cost;
    v_material_cost := v_material_cost + v_line;
  END LOOP;

  IF v_overhead_percent IS NOT NULL THEN
    v_overhead := round(v_material_cost * v_overhead_percent / 100, 2);
  ELSE
    v_overhead := COALESCE((payload->>'overhead_cost')::numeric, 0);
  END IF;

  v_total := v_material_cost + v_labor + v_overhead;
  v_unit_cost := v_total / v_yield;
  v_cost_per_pack := v_unit_cost * v_pack_qty + v_pack_cost;

  UPDATE costing_sheets SET
    yield_quantity = v_yield, labor_cost = v_labor, overhead_cost = v_overhead, overhead_percent = v_overhead_percent,
    pack_quantity = v_pack_qty, pack_cost = v_pack_cost, cost_per_pack = v_cost_per_pack,
    material_cost = v_material_cost, total_cost = v_total, unit_cost = v_unit_cost,
    apply_to_product = v_apply, notes = v_notes
  WHERE id = v_id;

  DELETE FROM costing_sheet_items WHERE sheet_id = v_id;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    INSERT INTO costing_sheet_items(sheet_id, material_id, quantity, unit_cost, line_total)
    VALUES (v_id, v_material.id, v_qty, v_material.unit_cost, v_qty * v_material.unit_cost);
  END LOOP;

  DELETE FROM costing_price_options WHERE sheet_id = v_id;
  IF v_price_options IS NOT NULL THEN
    FOR v_price IN SELECT * FROM jsonb_array_elements(v_price_options) LOOP
      v_proposed := (v_price->>'proposed_price')::numeric;
      IF v_proposed IS NOT NULL AND v_proposed >= 0 THEN
        v_margin := v_proposed - v_cost_per_pack;
        INSERT INTO costing_price_options(sheet_id, proposed_price, margin, margin_percent)
        VALUES (v_id, v_proposed, v_margin,
                CASE WHEN v_proposed > 0 THEN round(v_margin / v_proposed * 100, 2) ELSE 0 END);
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'unit_cost', v_unit_cost, 'cost_per_pack', v_cost_per_pack);
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_costing_sheet(jsonb) TO authenticated;

-- ============ 3. cancel_costing_sheet() ============
CREATE OR REPLACE FUNCTION public.cancel_costing_sheet(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row costing_sheets%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'costing', 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE costing_sheets SET status = 'cancelled' WHERE id = p_id;
  PERFORM public.record_workflow_action('costing', p_id, 'cancel', v_row.status, 'cancelled', p_reason);
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_costing_sheet(uuid, text) TO authenticated;

-- ============ 4. approve_costing_sheet(): the actual application point ============
CREATE OR REPLACE FUNCTION public.approve_costing_sheet(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row costing_sheets%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF NOT public.has_permission(v_uid, 'costing', 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Costing approval must be done by someone other than who submitted the sheet';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  UPDATE costing_sheets SET status = 'posted', approved_by = v_uid, approved_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('costing', p_id, 'approve', v_row.status, 'posted', p_comment);

  IF v_row.apply_to_product THEN
    UPDATE products SET cost_price = v_row.cost_per_pack, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_row.factory_id, 'approve_costing_sheet', 'products', v_row.product_id::text,
            jsonb_build_object('sheet_id', p_id), jsonb_build_object('cost_price', v_row.cost_per_pack));
  END IF;

  RETURN jsonb_build_object('approved', true, 'posted', true, 'applied', v_row.apply_to_product, 'cost_per_pack', v_row.cost_per_pack);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_costing_sheet(uuid, text) TO authenticated;

-- ============ 5. reject_costing_sheet() ============
CREATE OR REPLACE FUNCTION public.reject_costing_sheet(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row costing_sheets%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a costing sheet'; END IF;
  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF NOT public.has_permission(v_uid, 'costing', 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a costing sheet you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE costing_sheets SET status = 'rejected', approved_by = v_uid, approved_at = now(), reject_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('costing', p_id, 'reject', v_row.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_costing_sheet(uuid, text) TO authenticated;

-- ============ 6. Retire create_costing_sheet() ============
REVOKE EXECUTE ON FUNCTION public.create_costing_sheet(jsonb) FROM authenticated;
