-- ============================================================================
-- Store issues to Lugbe and Jos
-- ----------------------------------------------------------------------------
-- User request (2026-10-29): the Store issues materials to Lugbe and Jos as
-- well as to Quality Control and the other departments.
--
-- Lugbe and Jos are other sites, not departments with people on the system,
-- so an issue to them names no user: raw_material_movements
-- .issued_to_department = 'lugbe' | 'jos', issued_to_user stays empty, and
-- whoever collected it (driver, staff) is written as free text into the
-- reason: "Issued to Lugbe — collected by <name>: <reason>". It is a
-- general issue ('issued'), not production use. The stock leaves the Store at
-- its average cost, exactly as any other issue.
--
-- issue_raw_material() is as 20261023180000 (own factory only) plus the two
-- sites and the optional collected_by text.
-- ============================================================================

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.raw_material_movements'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%issued_to_department%'
  LOOP
    EXECUTE format('ALTER TABLE public.raw_material_movements DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.raw_material_movements
  ADD CONSTRAINT raw_material_movements_issued_to_department_check
  CHECK (issued_to_department IS NULL OR issued_to_department IN ('production', 'quality_control', 'lugbe', 'jos'));

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
  v_reference text := payload->>'reference';
  v_purpose text := COALESCE(payload->>'purpose', 'production');
  v_dept text := NULLIF(payload->>'issued_to_department', '');
  v_to_user uuid := NULLIF(payload->>'issued_to_user', '')::uuid;
  v_collected_by text := NULLIF(btrim(COALESCE(payload->>'collected_by', '')), '');
  v_site boolean;
  v_to_label text;
  v_movement_type movement_type;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_dept IS NOT NULL AND v_dept NOT IN ('production', 'quality_control', 'lugbe', 'jos') THEN
    RAISE EXCEPTION 'Issue to Production, Quality Control, Lugbe or Jos';
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

  IF v_dept IS NOT NULL THEN
    v_to_label := 'Issued to ' || CASE v_dept WHEN 'production' THEN 'Production Manager'
                                              WHEN 'quality_control' THEN 'Quality Control'
                                              WHEN 'lugbe' THEN 'Lugbe'
                                              ELSE 'Jos' END
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

  UPDATE raw_materials SET
    current_stock = current_stock - v_qty,
    current_value = current_value - v_qty * v_move_cost,
    updated_at = now()
  WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                     quantity_before, quantity_after, issued_to_department, issued_to_user)
  VALUES (v_material.factory_id, v_material_id, v_movement_type, v_qty, v_move_cost, v_reference, v_reason, v_uid,
          v_material.current_stock, v_material.current_stock - v_qty, v_dept, v_to_user);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.issue_raw_material(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
