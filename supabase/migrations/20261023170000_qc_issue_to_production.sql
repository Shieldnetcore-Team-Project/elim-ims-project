-- ============================================================================
-- Quality Control issues stock to Production
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-23): Quality Control can pass stock from its own
-- store (20261023160000_qc_store.sql) on to Production. An issue to
-- Production is an "out" of QC's stock like any use, recorded with where it
-- went and who received it, and never more than QC has available.
--
--   qc_store_usage.issued_to_department  'production' for an issue to
--                                        Production; NULL for QC's own use.
--   qc_store_usage.issued_to_user        the Production person who received
--                                        it, if one was picked.
--   qc_record_store_usage                takes issued_to_department /
--                                        issued_to_user; the reason then
--                                        starts "Issued to Production — name".
-- ============================================================================

ALTER TABLE public.qc_store_usage
  ADD COLUMN IF NOT EXISTS issued_to_department text CHECK (issued_to_department IN ('production')),
  ADD COLUMN IF NOT EXISTS issued_to_user uuid REFERENCES auth.users(id);

-- As 20261023160000, plus issuing to Production.
CREATE OR REPLACE FUNCTION public.qc_record_store_usage(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material uuid := NULLIF(payload->>'material_id', '')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_reason text := btrim(COALESCE(payload->>'reason', ''));
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_dept text := NULLIF(payload->>'issued_to_department', '');
  v_to_user uuid := NULLIF(payload->>'issued_to_user', '')::uuid;
  v_m raw_materials%ROWTYPE;
  v_available numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_client IS NOT NULL THEN
    SELECT id INTO v_id FROM qc_store_usage WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_id, 'duplicate', true); END IF;
  END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = v_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles ur
                  WHERE ur.user_id = v_uid AND (ur.factory_id IS NULL OR ur.factory_id = v_m.factory_id)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  IF v_dept IS NOT NULL AND v_dept <> 'production' THEN RAISE EXCEPTION 'Quality Control issues to Production only'; END IF;
  IF v_to_user IS NOT NULL THEN
    IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the department the person belongs to'; END IF;
    IF NOT public._issue_department_member(v_to_user, v_dept) THEN RAISE EXCEPTION 'That person is not in Production'; END IF;
  END IF;
  IF v_dept IS NOT NULL THEN
    v_reason := 'Issued to Production'
                || COALESCE(' — ' || (SELECT COALESCE(NULLIF(full_name, ''), email) FROM profiles WHERE id = v_to_user), '')
                || CASE WHEN v_reason = '' THEN '' ELSE ': ' || v_reason END;
  END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'Say what it was used for'; END IF;

  v_available := COALESCE((SELECT SUM(quantity) FROM qc_store_receipts
                            WHERE material_id = v_material AND status = 'confirmed'), 0)
               - COALESCE((SELECT SUM(quantity) FROM qc_store_usage WHERE material_id = v_material), 0);
  IF v_qty > v_available THEN
    RAISE EXCEPTION 'Only % % of % available in Quality Control', v_available, v_m.unit, v_m.name;
  END IF;

  INSERT INTO qc_store_usage(factory_id, material_id, quantity, reason, used_by, client_ref, issued_to_department, issued_to_user)
  VALUES (v_m.factory_id, v_material, v_qty, v_reason, v_uid, v_client, v_dept, v_to_user)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_m.factory_id, CASE WHEN v_dept IS NULL THEN 'qc_record_store_usage' ELSE 'qc_issue_to_production' END,
          'qc_store_usage', v_id::text,
          jsonb_build_object('material_id', v_material, 'quantity', v_qty, 'reason', v_reason,
                             'issued_to_department', v_dept, 'issued_to_user', v_to_user,
                             'available_after', v_available - v_qty));
  RETURN jsonb_build_object('id', v_id, 'available', v_available - v_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_record_store_usage(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_record_store_usage(jsonb) TO authenticated;
