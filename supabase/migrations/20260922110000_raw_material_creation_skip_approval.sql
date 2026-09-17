-- ============================================================================
-- RAW MATERIALS: creating a new material no longer needs a second-person
-- approval -- it goes live (approval_status='approved', active=true) the
-- moment it's entered, same as editing an existing material already did.
-- ----------------------------------------------------------------------------
-- request_new_material() previously inserted as pending_approval/inactive and
-- waited for approve_new_material() (a different, non-creator user) before
-- the row went live -- see 20260823090000_material_approval_supplier_fields_po_fields.sql.
-- That maker-checker step is removed: request_new_material() now performs
-- the same effects approve_new_material() used to (mark it live, log the
-- opening-balance movement) inline, in one call.
--
-- approve_new_material()/reject_new_material() are left in place, untouched,
-- so any material already sitting in pending_approval from before this
-- migration can still be resolved via the existing UI -- this only changes
-- what happens for materials entered from now on.
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
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_name IS NULL OR btrim(v_name) = '' THEN RAISE EXCEPTION 'Material name is required'; END IF;
  IF v_unit IS NULL OR btrim(v_unit) = '' THEN RAISE EXCEPTION 'Unit is required'; END IF;

  INSERT INTO raw_materials(factory_id, name, category_id, unit, opening_stock, current_stock, unit_cost,
                             supplier_id, reorder_level, minimum_stock, remarks, approval_status, active, created_by)
  VALUES (v_factory, btrim(v_name), v_category_id, btrim(v_unit), v_opening, v_opening, v_unit_cost,
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
