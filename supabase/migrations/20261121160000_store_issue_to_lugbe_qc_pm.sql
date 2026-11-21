-- ============================================================================
-- Kubwa Store issues to Lugbe Factory's QC and Production Manager
-- ----------------------------------------------------------------------------
-- User (2026-11-21): the two factories operate in isolation. The one
-- exception is Store issues: Kubwa's Store issues stock to Lugbe Factory, to
-- its Quality Control or its Production Manager.
--
-- issue_raw_material() takes a new payload field `lugbe_to`
-- ('quality_control' | 'production') with issued_to_department = 'lugbe':
--   * Kubwa: the material leaves Kubwa's Store as before, filed under Lugbe
--     (Issued Out › Lugbe and every Kubwa report keep counting it), labelled
--     "Issued to Lugbe — Quality Control" or "Issued to Lugbe — Production
--     Manager".
--   * Lugbe: the same material in Lugbe's Store (matched by name and unit,
--     created at zero if Lugbe doesn't have it yet) records it arriving
--     ("transferred", from Kubwa Store) and at once issues it on to QC or
--     Production. Lugbe's Store stock ends where it started, and the issue
--     follows Lugbe's normal flow:
--       - QC: a Received from Store line waiting for Lugbe QC to confirm or
--         reject (qc_store_receipts, made by the existing trigger). A
--         rejected line goes back into Lugbe's Store, where the goods are.
--       - Production: Process Material › Qty In for Lugbe.
-- Without `lugbe_to` an issue to Lugbe is a plain site issue, as before.
-- Safe to run again.
-- ============================================================================

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
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_note text;
  v_reference text := payload->>'reference';
  v_purpose text := COALESCE(payload->>'purpose', 'production');
  v_dept text := NULLIF(payload->>'issued_to_department', '');
  v_to_user uuid := NULLIF(payload->>'issued_to_user', '')::uuid;
  v_collected_by text := NULLIF(btrim(COALESCE(payload->>'collected_by', '')), '');
  v_lugbe_to text := NULLIF(payload->>'lugbe_to', '');
  v_site boolean;
  v_to_label text;
  v_movement_type movement_type;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
  v_lugbe uuid;
  v_dst raw_materials%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_dept IS NOT NULL AND v_dept NOT IN ('production', 'quality_control', 'lugbe', 'jos') THEN
    RAISE EXCEPTION 'Issue to Production, Quality Control, Lugbe or Jos';
  END IF;
  IF v_lugbe_to IS NOT NULL THEN
    IF v_dept IS DISTINCT FROM 'lugbe' THEN RAISE EXCEPTION 'Only an issue to Lugbe goes to Lugbe QC or Production'; END IF;
    IF v_lugbe_to NOT IN ('quality_control', 'production') THEN
      RAISE EXCEPTION 'Lugbe issues go to Quality Control or Production';
    END IF;
  END IF;
  v_site := v_dept IN ('lugbe', 'jos');
  IF v_to_user IS NOT NULL THEN
    IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the department the person belongs to'; END IF;
    IF v_site THEN RAISE EXCEPTION 'An issue to Lugbe or Jos names who collected it, not a user'; END IF;
    IF NOT public._issue_department_member(v_to_user, v_dept) THEN
      RAISE EXCEPTION 'That person is not in %', CASE v_dept WHEN 'production' THEN 'Production' ELSE 'Quality Control' END;
    END IF;
  END IF;
  -- Stock sent to another site is a general issue, not production use here.
  IF v_site THEN v_purpose := 'general'; END IF;
  v_movement_type := CASE WHEN v_purpose = 'production' THEN 'used_for_production'::movement_type ELSE 'issued'::movement_type END;

  v_note := v_reason;
  IF v_dept IS NOT NULL THEN
    v_to_label := 'Issued to ' || CASE v_dept WHEN 'production' THEN 'Production Manager'
                                              WHEN 'quality_control' THEN 'Quality Control'
                                              WHEN 'lugbe' THEN 'Lugbe'
                                              ELSE 'Jos' END
                  || CASE v_lugbe_to WHEN 'quality_control' THEN ' — Quality Control'
                                     WHEN 'production' THEN ' — Production Manager'
                                     ELSE '' END
                  || COALESCE(' — ' || (SELECT COALESCE(NULLIF(full_name, ''), email) FROM profiles WHERE id = v_to_user), '')
                  || CASE WHEN v_site AND v_collected_by IS NOT NULL THEN ' — collected by ' || v_collected_by ELSE '' END;
    v_reason := CASE WHEN v_reason IS NULL THEN v_to_label ELSE v_to_label || ': ' || v_reason END;
  END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_material.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_material.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_material.current_stock, v_qty;
  END IF;
  v_move_cost := public.avg_unit_cost(v_material.current_value, v_material.current_stock, v_material.unit_cost);

  IF v_lugbe_to IS NOT NULL THEN
    SELECT id INTO v_lugbe FROM factories WHERE code = 'lugbe';
    IF v_lugbe IS NULL THEN RAISE EXCEPTION 'Lugbe Factory is not set up'; END IF;
    IF v_material.factory_id = v_lugbe THEN RAISE EXCEPTION 'This material is already in Lugbe'; END IF;
  END IF;

  UPDATE raw_materials SET
    current_stock = current_stock - v_qty,
    current_value = current_value - v_qty * v_move_cost,
    updated_at = now()
  WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                     quantity_before, quantity_after, issued_to_department, issued_to_user)
  VALUES (v_material.factory_id, v_material_id, v_movement_type, v_qty, v_move_cost, v_reference, v_reason, v_uid,
          v_material.current_stock, v_material.current_stock - v_qty, v_dept, v_to_user);

  -- Lugbe: arrives in Lugbe's Store and goes straight on to its QC / PM.
  IF v_lugbe_to IS NOT NULL THEN
    SELECT * INTO v_dst FROM raw_materials
     WHERE factory_id = v_lugbe
       AND lower(btrim(name)) = lower(btrim(v_material.name))
     ORDER BY (unit = v_material.unit) DESC, active DESC, created_at
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO raw_materials
      SELECT (jsonb_populate_record(NULL::raw_materials, to_jsonb(v_material) || jsonb_build_object(
        'id', gen_random_uuid(), 'factory_id', v_lugbe,
        'category_id', (SELECT c2.id FROM material_categories c1
                          JOIN material_categories c2
                            ON c2.factory_id = v_lugbe AND lower(c2.name) = lower(c1.name)
                         WHERE c1.id = v_material.category_id LIMIT 1),
        'brand_id', NULL, 'supplier_id', NULL, 'output_product_id', NULL,
        'current_stock', 0, 'current_value', 0, 'opening_stock', 0,
        'created_by', v_uid, 'created_at', now(), 'updated_at', now()))).*
      RETURNING * INTO v_dst;
    END IF;

    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                       quantity_before, quantity_after)
    VALUES (v_lugbe, v_dst.id, 'transferred', v_qty, v_move_cost, v_reference,
            'Received from Kubwa Store'
              || CASE WHEN v_collected_by IS NOT NULL THEN ' — collected by ' || v_collected_by ELSE '' END,
            v_uid, v_dst.current_stock, v_dst.current_stock + v_qty);

    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                       quantity_before, quantity_after, issued_to_department)
    VALUES (v_lugbe, v_dst.id,
            CASE v_lugbe_to WHEN 'production' THEN 'used_for_production'::movement_type ELSE 'issued'::movement_type END,
            v_qty, v_move_cost, v_reference,
            CASE v_lugbe_to WHEN 'production' THEN 'Issued to Production Manager' ELSE 'Issued to Quality Control' END
              || ' — from Kubwa Store' || COALESCE(': ' || v_note, ''),
            v_uid, v_dst.current_stock + v_qty, v_dst.current_stock, v_lugbe_to);

    UPDATE raw_materials SET updated_at = now() WHERE id = v_dst.id;
  END IF;

  RETURN jsonb_build_object('material_id', v_material_id, 'lugbe_material_id', v_dst.id);
END;
$$;
REVOKE ALL ON FUNCTION public.issue_raw_material(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_raw_material(jsonb) TO authenticated;
