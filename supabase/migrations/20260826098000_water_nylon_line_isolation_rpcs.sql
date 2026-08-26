-- ============================================================================
-- WATER / NYLON LINE ISOLATION — RPCs
-- ----------------------------------------------------------------------------
-- submit_costing_sheet/update_costing_sheet now take `sheet_type` ('water' |
-- 'nylon') and an optional `role` per item line, and enforce that the
-- product and every material line actually belong to that line's tagged
-- categories (product_categories.product_line / material_categories.product_line
-- from 20260826097000) — so a Nylon material can never be saved onto a Water
-- sheet or vice versa, regardless of what the client sends. Untagged/legacy
-- products or materials (no category) are allowed through unchecked rather
-- than blocked, since semi-finished items can have a NULL category.
-- ============================================================================

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
  v_sheet_type text := payload->>'sheet_type';
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
  v_material_line text;
  v_product_line text;
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
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_sheet_type NOT IN ('water','nylon') THEN RAISE EXCEPTION 'sheet_type must be water or nylon'; END IF;
  IF v_yield IS NULL OR v_yield <= 0 THEN RAISE EXCEPTION 'Yield quantity must be > 0'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one material line is required'; END IF;

  PERFORM 1 FROM products WHERE id = v_product_id AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found for this factory'; END IF;

  SELECT pc.product_line INTO v_product_line FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id WHERE p.id = v_product_id;
  IF v_product_line IS NOT NULL AND v_product_line <> v_sheet_type THEN
    RAISE EXCEPTION 'Product belongs to the % line, not %', v_product_line, v_sheet_type;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material % not found', v_item->>'material_id'; END IF;
    SELECT mc.product_line INTO v_material_line FROM material_categories mc WHERE mc.id = v_material.category_id;
    IF v_material_line IS NOT NULL AND v_material_line <> v_sheet_type THEN
      RAISE EXCEPTION 'Material "%" belongs to the % line, not %', v_material.name, v_material_line, v_sheet_type;
    END IF;
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

  INSERT INTO costing_sheets(factory_id, product_id, sheet_number, sheet_type, yield_quantity, labor_cost, overhead_cost,
                              overhead_percent, pack_quantity, pack_cost, cost_per_pack,
                              material_cost, total_cost, unit_cost, apply_to_product, notes, created_by)
  VALUES (v_factory, v_product_id, v_number, v_sheet_type, v_yield, v_labor, v_overhead,
          v_overhead_percent, v_pack_qty, v_pack_cost, v_cost_per_pack,
          v_material_cost, v_total, v_unit_cost, v_apply, v_notes, v_uid)
  RETURNING id INTO v_sheet_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    INSERT INTO costing_sheet_items(sheet_id, material_id, quantity, unit_cost, line_total, role)
    VALUES (v_sheet_id, v_material.id, v_qty, v_material.unit_cost, v_qty * v_material.unit_cost, v_item->>'role');
  END LOOP;

  IF v_price_options IS NOT NULL THEN
    FOR v_price IN SELECT * FROM jsonb_array_elements(v_price_options) LOOP
      v_proposed := (v_price->>'proposed_price')::numeric;
      IF v_proposed IS NOT NULL AND v_proposed >= 0 THEN
        v_margin := v_proposed - v_cost_per_pack;
        INSERT INTO costing_price_options(sheet_id, proposed_price, margin, margin_percent)
        VALUES (v_sheet_id, v_proposed, v_margin,
                CASE WHEN v_cost_per_pack > 0 THEN round(v_margin / v_cost_per_pack * 100, 2) ELSE 0 END);
      END IF;
    END LOOP;
  END IF;

  PERFORM public.record_workflow_action('costing', v_sheet_id, 'submit', NULL, 'pending_approval', v_notes);
  RETURN jsonb_build_object('id', v_sheet_id, 'sheet_number', v_number, 'unit_cost', v_unit_cost,
                             'total_cost', v_total, 'cost_per_pack', v_cost_per_pack);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_costing_sheet(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := (payload->>'id')::uuid;
  v_sheet_type text;
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
  v_material_line text;
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
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'edit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM costing_sheets WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF v_row.status <> 'pending_approval' THEN RAISE EXCEPTION 'Cannot edit a costing sheet after it has been reviewed'; END IF;
  v_sheet_type := v_row.sheet_type;
  IF v_yield IS NULL OR v_yield <= 0 THEN RAISE EXCEPTION 'Yield quantity must be > 0'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one material line is required'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material % not found', v_item->>'material_id'; END IF;
    IF v_sheet_type IS NOT NULL THEN
      SELECT mc.product_line INTO v_material_line FROM material_categories mc WHERE mc.id = v_material.category_id;
      IF v_material_line IS NOT NULL AND v_material_line <> v_sheet_type THEN
        RAISE EXCEPTION 'Material "%" belongs to the % line, not %', v_material.name, v_material_line, v_sheet_type;
      END IF;
    END IF;
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
    INSERT INTO costing_sheet_items(sheet_id, material_id, quantity, unit_cost, line_total, role)
    VALUES (v_id, v_material.id, v_qty, v_material.unit_cost, v_qty * v_material.unit_cost, v_item->>'role');
  END LOOP;

  DELETE FROM costing_price_options WHERE sheet_id = v_id;
  IF v_price_options IS NOT NULL THEN
    FOR v_price IN SELECT * FROM jsonb_array_elements(v_price_options) LOOP
      v_proposed := (v_price->>'proposed_price')::numeric;
      IF v_proposed IS NOT NULL AND v_proposed >= 0 THEN
        v_margin := v_proposed - v_cost_per_pack;
        INSERT INTO costing_price_options(sheet_id, proposed_price, margin, margin_percent)
        VALUES (v_id, v_proposed, v_margin,
                CASE WHEN v_cost_per_pack > 0 THEN round(v_margin / v_cost_per_pack * 100, 2) ELSE 0 END);
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'unit_cost', v_unit_cost, 'cost_per_pack', v_cost_per_pack);
END;
$$;
