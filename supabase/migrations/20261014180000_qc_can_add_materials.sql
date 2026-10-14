-- ============================================================================
-- QC can add a raw material from the inspection form
-- ----------------------------------------------------------------------------
-- The QC "Record Inspection" form now uses the same material picker as the
-- Store request form: a delivery of a material that isn't listed yet can be
-- added by name, and it's saved to the raw materials list (reused, never
-- duplicated) so it's in the dropdown for every later inspection and request.
--
-- request_new_material() therefore also accepts goods-receiving:submit (the
-- QC role's grant). Like requesters, QC only names the material: its stock
-- arrives through the inspection itself once the Store confirms it, so
-- opening stock and unit cost stay with raw-materials:submit.
-- Body otherwise identical to 20261014150000.
-- ============================================================================

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
  v_can_stock boolean;
  v_id uuid;
BEGIN
  v_can_stock := public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key);
  IF NOT v_can_stock
     AND NOT public.has_permission(v_uid, 'production-requests'::module_key, 'submit'::action_key)
     AND NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_name IS NULL OR btrim(v_name) = '' THEN RAISE EXCEPTION 'Material name is required'; END IF;
  IF v_unit IS NULL OR btrim(v_unit) = '' THEN RAISE EXCEPTION 'Unit is required'; END IF;

  -- Already in the list? Reuse it rather than adding a duplicate.
  SELECT id INTO v_id FROM raw_materials
   WHERE factory_id = v_factory
     AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g'))
     AND COALESCE(approval_status, 'approved') <> 'rejected'
   ORDER BY active DESC, created_at
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_id, 'existing', true);
  END IF;

  -- Requesters name the material; only the Store records stock and cost.
  IF NOT v_can_stock THEN
    v_opening := 0;
    v_unit_cost := 0;
  END IF;

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

  RETURN jsonb_build_object('id', v_id, 'existing', false);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_new_material(jsonb) TO authenticated;
