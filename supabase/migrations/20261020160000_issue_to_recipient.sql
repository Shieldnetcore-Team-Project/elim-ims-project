-- ============================================================================
-- Store issues: who the stock is issued to
-- ----------------------------------------------------------------------------
-- The Store issues raw materials to Production (the production manager) and
-- to Quality Control. Until now an issue recorded only a purpose and a free
-- reference, not who received it. Each issue now records:
--
--   raw_material_movements.issued_to_department   'production' | 'quality_control'
--   raw_material_movements.issued_to_user         the person who received it
--
-- issue_recipients(factory) lists the people the Store can pick:
--   production       users with the Production role or a production-manager
--                    role (matched by slug or label, as 20261015090000)
--   quality_control  users with the QC role (qc_officer)
--
-- issue_raw_material() is unchanged from 20260922180000 except that it takes
-- issued_to_department / issued_to_user, checks the person belongs to that
-- department, and writes "Issued to <department> — <name>" as the reason
-- when none is given. Older callers that send neither still work.
-- ============================================================================

ALTER TABLE public.raw_material_movements
  ADD COLUMN IF NOT EXISTS issued_to_department text
    CHECK (issued_to_department IS NULL OR issued_to_department IN ('production', 'quality_control')),
  ADD COLUMN IF NOT EXISTS issued_to_user uuid REFERENCES auth.users(id);

-- Does this user belong to the department (by role)?
CREATE OR REPLACE FUNCTION public._issue_department_member(p_user uuid, p_department text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur LEFT JOIN roles r ON r.slug = ur.role
     WHERE ur.user_id = p_user
       AND CASE p_department
             WHEN 'production' THEN ur.role = 'production' OR ur.role ILIKE '%production%manager%'
                                    OR COALESCE(r.label, '') ILIKE '%production%manager%'
             WHEN 'quality_control' THEN ur.role = 'qc_officer'
             ELSE false
           END);
$$;
REVOKE ALL ON FUNCTION public._issue_department_member(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.issue_recipients(p_factory uuid)
RETURNS TABLE(id uuid, full_name text, department text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT p.id, COALESCE(NULLIF(p.full_name, ''), p.email)::text, d.dept
    FROM profiles p
    CROSS JOIN (VALUES ('production'), ('quality_control')) AS d(dept)
   WHERE COALESCE(p.status, 'active') = 'active'
     AND public._issue_department_member(p.id, d.dept)
     AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = p.id AND (ur.factory_id IS NULL OR ur.factory_id = p_factory))
   ORDER BY d.dept, 2;
END;
$$;
REVOKE ALL ON FUNCTION public.issue_recipients(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_recipients(uuid) TO authenticated;

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
  v_to_label text;
  v_movement_type movement_type;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_dept IS NOT NULL AND v_dept NOT IN ('production', 'quality_control') THEN
    RAISE EXCEPTION 'Issue to Production or Quality Control';
  END IF;
  IF v_to_user IS NOT NULL THEN
    IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the department the person belongs to'; END IF;
    IF NOT public._issue_department_member(v_to_user, v_dept) THEN
      RAISE EXCEPTION 'That person is not in %', CASE v_dept WHEN 'production' THEN 'Production' ELSE 'Quality Control' END;
    END IF;
  END IF;
  v_movement_type := CASE WHEN v_purpose = 'production' THEN 'used_for_production'::movement_type ELSE 'issued'::movement_type END;

  IF v_dept IS NOT NULL THEN
    v_to_label := 'Issued to ' || CASE v_dept WHEN 'production' THEN 'Production Manager' ELSE 'Quality Control' END
                  || COALESCE(' — ' || (SELECT COALESCE(NULLIF(full_name, ''), email) FROM profiles WHERE id = v_to_user), '');
    v_reason := CASE WHEN v_reason IS NULL THEN v_to_label ELSE v_to_label || ': ' || v_reason END;
  END IF;

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

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                     quantity_before, quantity_after, issued_to_department, issued_to_user)
  VALUES (v_material.factory_id, v_material_id, v_movement_type, v_qty, v_move_cost, v_reference, v_reason, v_uid,
          v_material.current_stock, v_material.current_stock - v_qty, v_dept, v_to_user);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.issue_raw_material(jsonb) TO authenticated;
