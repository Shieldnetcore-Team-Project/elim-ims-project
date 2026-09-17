-- ============================================================================
-- PRODUCTION REQUESTS: approving a material request now releases the stock
-- ----------------------------------------------------------------------------
-- Previously approve_production_request() was purely a status flip -- a
-- separate "Issue Materials" click (issue_production_request_materials(),
-- 20260819090000_production_scope_types_packaging.sql:446-489) was the only
-- thing that actually decremented raw_materials.current_stock. Per the
-- factory's real process ("inventory approves and releases the material" is
-- one step, not two), approving a request now does the release itself:
-- deducts each requested material's stock, logs a raw_material_movements
-- row per item, and marks materials_issued/production_status accordingly --
-- in the SAME transaction as the approval, so it can't partially apply.
--
-- Deliberately does NOT call issue_raw_material()/issue_production_request_
-- materials() -- both re-check the CALLING user's own 'raw-materials':'write'
-- permission, which chairman/accountant (who can also approve these
-- requests, per 20260816100000_role_permission_seed_goods_receiving_
-- purchase.sql:29 and 20260914110000_finance_receive_requests_and_create_po.sql:20-22)
-- do not hold -- their approval would fail with "Insufficient permissions"
-- purely because of this unrelated module. Approving already required
-- 'production-requests':'approve'; that's the authorization for this whole
-- merged action, so the stock mutation is inlined here instead.
--
-- issue_production_request_materials() is left in place, untouched: any
-- request already sitting approved-but-not-issued from before this
-- migration can still be issued the old way (its UI button's gate,
-- `approval_status==='approved' && !materials_issued`, naturally stops
-- firing for requests approved through this new path, since materials_issued
-- is now set to true immediately).
-- ============================================================================

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

      UPDATE raw_materials SET current_stock = current_stock - v_item.quantity_requested, updated_at = now()
      WHERE id = v_item.material_id;

      INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_item.material_id, 'used_for_production', v_item.quantity_requested, v_material.unit_cost,
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
