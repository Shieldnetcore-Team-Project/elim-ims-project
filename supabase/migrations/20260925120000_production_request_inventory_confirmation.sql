-- ============================================================================
-- Production requests: approval no longer releases stock. The inventory
-- officer confirms the approved request, and that confirmation releases the
-- raw materials.
-- ----------------------------------------------------------------------------
-- Flow: pending -> (approve) approved, materials_issued=false
--       -> (inventory officer confirms) production_status='materials_issued'.
-- No new status value is needed: "approved and not materials_issued" is the
-- awaiting-confirmation state (same state the legacy manual issue step used).
-- Approvers keep approve/reject; inventory_officer gets the new
-- production-requests:confirm permission (chairman/super_admin bypass).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a request you submitted yourself';
  END IF;
  IF v_row.request_type = 'production_material' AND NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved'
  WHERE id = p_id;

  RETURN jsonb_build_object('approved', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_production_request(p_id uuid, p_confirmer_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
  v_item production_request_items%ROWTYPE;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_confirmer_name IS NULL OR btrim(p_confirmer_name) = '' THEN RAISE EXCEPTION 'Confirmer name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.request_type <> 'production_material' THEN RAISE EXCEPTION 'Only production-material requests need confirmation'; END IF;
  IF v_row.approval_status <> 'approved' THEN RAISE EXCEPTION 'Request must be approved before it can be confirmed'; END IF;
  IF v_row.materials_issued THEN RAISE EXCEPTION 'Request already confirmed'; END IF;
  IF NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;

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
    materials_issued = true, issued_by_name = p_confirmer_name, issued_at = now(),
    production_status = 'materials_issued'
  WHERE id = p_id;

  RETURN jsonb_build_object('confirmed', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_production_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_production_request(uuid, text) TO authenticated;

INSERT INTO public.role_permissions (role, module, action)
VALUES ('inventory_officer', 'production-requests', 'confirm')
ON CONFLICT (role, module, action) DO NOTHING;
