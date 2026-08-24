-- ============================================================================
-- PRODUCTION — Nylon/Water factory isolation
-- ----------------------------------------------------------------------------
-- user_roles.factory_id has existed since day one (and request_role_grant/
-- approve_role_grant/post_role_grant already thread it through end to end)
-- but has_role()/has_permission() have always ignored it — every role grant
-- is effectively factory-agnostic today, so a Nylon Production Manager can
-- flip the Factory Switcher to Water and see Water's production data too.
--
-- Scope, per explicit decision: isolate the PRODUCTION department only
-- (production + the production_material half of production_requests).
-- Sales/Inventory/etc. are unaffected -- a role grant with factory_id NULL
-- still means "this role applies to every factory", preserving today's
-- behaviour for every existing grant and every other module.
-- ============================================================================

-- ============ 1. has_permission_for_factory(): has_permission(), factory-aware ============
CREATE OR REPLACE FUNCTION public.has_permission_for_factory(
  _user_id uuid, _module public.module_key, _action public.action_key, _factory_id uuid
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actions public.action_key[];
  v_result boolean;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;
  IF public.has_role(_user_id, 'super_admin') THEN RETURN true; END IF;
  IF _factory_id IS NULL THEN RETURN public.has_permission(_user_id, _module, _action); END IF;

  v_actions := CASE _action
    WHEN 'read' THEN ARRAY['view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete']::public.action_key[]
    WHEN 'write' THEN ARRAY['create','edit','delete']::public.action_key[]
    ELSE ARRAY[_action]
  END;

  SELECT EXISTS (
    SELECT 1 FROM unnest(v_actions) AS a(action)
    WHERE COALESCE(
      (SELECT po.granted FROM public.permission_overrides po
        WHERE po.user_id = _user_id AND po.module = _module AND po.action = a.action),
      EXISTS (
        SELECT 1 FROM public.role_permissions rp
        JOIN public.user_roles ur ON ur.role = rp.role
        WHERE ur.user_id = _user_id AND rp.module = _module AND rp.action = a.action
          AND (ur.factory_id IS NULL OR ur.factory_id = _factory_id)
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION public.has_permission_for_factory(uuid, public.module_key, public.action_key, uuid) TO authenticated;

-- ============ 2. get_my_production_factories(): which factories can I see Production for ============
-- Used by the Production page to show a clear "not assigned to this factory"
-- message instead of a silently-empty table when the caller flips the
-- Factory Switcher to a factory their production role doesn't cover.
CREATE OR REPLACE FUNCTION public.get_my_production_factories()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_unrestricted boolean;
  v_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('unrestricted', false, 'factory_ids', '[]'::jsonb); END IF;
  IF public.has_role(v_uid, 'super_admin') THEN RETURN jsonb_build_object('unrestricted', true, 'factory_ids', '[]'::jsonb); END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.role_permissions rp ON rp.role = ur.role
    WHERE ur.user_id = v_uid AND rp.module = 'production' AND ur.factory_id IS NULL
  ) INTO v_unrestricted;

  IF v_unrestricted THEN RETURN jsonb_build_object('unrestricted', true, 'factory_ids', '[]'::jsonb); END IF;

  SELECT COALESCE(array_agg(DISTINCT ur.factory_id), ARRAY[]::uuid[]) INTO v_ids
  FROM public.user_roles ur JOIN public.role_permissions rp ON rp.role = ur.role
  WHERE ur.user_id = v_uid AND rp.module = 'production' AND ur.factory_id IS NOT NULL;

  RETURN jsonb_build_object('unrestricted', false, 'factory_ids', to_jsonb(v_ids));
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_production_factories() TO authenticated;

-- ============ 3. RLS: production ============
DROP POLICY IF EXISTS "production read" ON public.production;
CREATE POLICY "production read" ON public.production FOR SELECT TO authenticated
  USING (public.has_permission_for_factory(auth.uid(), 'production'::module_key, 'read'::action_key, factory_id));

-- ============ 4. RLS: production_requests / production_request_items ============
-- Consolidates the several overlapping permissive SELECT policies these two
-- tables accumulated across earlier migrations (093000's legacy-action
-- policy was never dropped when 099000 added a new-action one) into one
-- each, adding the factory gate for production_material rows only --
-- purchase-type rows (procurement, not production) are unaffected.
DROP POLICY IF EXISTS "production-requests read" ON public.production_requests;
DROP POLICY IF EXISTS "production-requests write" ON public.production_requests;
DROP POLICY IF EXISTS "production requests read" ON public.production_requests;
CREATE POLICY "production requests read" ON public.production_requests FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'production-requests'::module_key, 'view'::action_key)
    AND (
      request_type = 'purchase'
      OR public.has_permission_for_factory(auth.uid(), 'production-requests'::module_key, 'view'::action_key, factory_id)
    )
  );

DROP POLICY IF EXISTS "production-requests read items" ON public.production_request_items;
DROP POLICY IF EXISTS "production-requests write items" ON public.production_request_items;
DROP POLICY IF EXISTS "production request items read" ON public.production_request_items;
CREATE POLICY "production request items read" ON public.production_request_items FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'production-requests'::module_key, 'view'::action_key)
    AND EXISTS (
      SELECT 1 FROM public.production_requests pr WHERE pr.id = request_id
        AND (pr.request_type = 'purchase' OR public.has_permission_for_factory(auth.uid(), 'production-requests'::module_key, 'view'::action_key, pr.factory_id))
    )
  );

-- ============ 5. RPCs: production (maker-side; Store confirm/reject are NOT
-- factory-gated -- only the Production department roles being isolated here) ============
CREATE OR REPLACE FUNCTION public.create_production(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity_produced')::numeric;
  v_unit text := payload->>'unit';
  v_cost numeric := COALESCE((payload->>'production_cost')::numeric, 0);
  v_supervisor text := payload->>'supervisor';
  v_batch text := payload->>'batch_number';
  v_remarks text := payload->>'remarks';
  v_date date := COALESCE((payload->>'production_date')::date, CURRENT_DATE);
  v_request_id uuid := NULLIF(payload->>'production_request_id','')::uuid;
  v_prefix text; v_number text; v_id uuid; v_product products%ROWTYPE;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF NOT public.has_permission_for_factory(v_uid, 'production'::module_key, 'create'::action_key, v_factory) THEN
    RAISE EXCEPTION 'Insufficient permissions for this factory';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  IF v_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM production_requests WHERE id = v_request_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Production request not found for this factory';
    END IF;
  END IF;

  SELECT COALESCE(production_prefix,'PRD-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'PRD-'; END IF;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO production(factory_id, production_number, production_date, product_id, quantity_produced, unit,
                          production_cost, supervisor, batch_number, remarks, created_by, production_request_id)
  VALUES (v_factory, v_number, v_date, v_product_id, v_qty, COALESCE(v_unit, v_product.unit),
          v_cost, v_supervisor, v_batch, v_remarks, v_uid, v_request_id)
  RETURNING id INTO v_id;

  IF v_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed', production_id = v_id WHERE id = v_request_id;
  END IF;

  PERFORM public.record_workflow_action('production', v_id, 'submit', NULL, 'pending_confirmation', v_remarks);
  RETURN jsonb_build_object('id', v_id, 'production_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_production(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_production(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := (payload->>'id')::uuid;
  v_qty numeric := (payload->>'quantity_produced')::numeric;
  v_unit text := payload->>'unit';
  v_cost numeric := COALESCE((payload->>'production_cost')::numeric, 0);
  v_supervisor text := payload->>'supervisor';
  v_batch text := payload->>'batch_number';
  v_remarks text := payload->>'remarks';
  v_date date := (payload->>'production_date')::date;
  v_row production%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;
  IF NOT public.has_permission_for_factory(v_uid, 'production'::module_key, 'edit'::action_key, v_row.factory_id) THEN
    RAISE EXCEPTION 'Insufficient permissions for this factory';
  END IF;
  IF v_row.status <> 'pending_confirmation' THEN RAISE EXCEPTION 'Cannot edit a batch after Store has acted on it'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  UPDATE production SET
    quantity_produced = v_qty,
    unit = COALESCE(v_unit, unit),
    production_cost = v_cost,
    supervisor = v_supervisor,
    batch_number = v_batch,
    remarks = v_remarks,
    production_date = COALESCE(v_date, production_date)
  WHERE id = v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_production(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_production(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row production%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;
  IF NOT public.has_permission_for_factory(v_uid, 'production'::module_key, 'cancel'::action_key, v_row.factory_id) THEN
    RAISE EXCEPTION 'Insufficient permissions for this factory';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE production SET status = 'cancelled' WHERE id = p_id;
  IF v_row.production_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'materials_issued'
    WHERE id = v_row.production_request_id AND production_status = 'completed';
  END IF;
  PERFORM public.record_workflow_action('production', p_id, 'cancel', v_row.status, 'cancelled', p_reason);
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_production(uuid, text) TO authenticated;

-- ============ 6. RPCs: production_requests (production_material rows only;
-- purchase-type rows keep the plain, factory-agnostic permission check) ============
CREATE OR REPLACE FUNCTION public.create_production_request(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_requested_by_name text := payload->>'requested_by_name';
  v_department text := payload->>'department';
  v_request_type text := COALESCE(payload->>'request_type', 'production_material');
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_qty numeric := (payload->>'quantity_requested')::numeric;
  v_unit text := payload->>'unit';
  v_remarks text := payload->>'remarks';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_number text;
  v_id uuid;
  v_product products%ROWTYPE;
  v_material raw_materials%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_requested_by_name IS NULL OR btrim(v_requested_by_name) = '' THEN RAISE EXCEPTION 'Requesting staff name is required'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity requested must be > 0'; END IF;

  IF v_request_type = 'purchase' THEN
    SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
    IF v_material.factory_id <> v_factory THEN RAISE EXCEPTION 'Material does not belong to factory'; END IF;

    v_number := 'PR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

    INSERT INTO production_requests(factory_id, request_number, requested_by_name, requested_by, department,
                                     request_type, material_id, supplier_id, quantity_requested, unit, remarks)
    VALUES (v_factory, v_number, v_requested_by_name, v_uid, v_department,
            'purchase', v_material_id, v_supplier_id, v_qty, COALESCE(v_unit, v_material.unit), v_remarks)
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'request_number', v_number);
  END IF;

  IF NOT public.has_permission_for_factory(v_uid, 'production-requests'::module_key, 'submit'::action_key, v_factory) THEN
    RAISE EXCEPTION 'You do not have production access for this factory';
  END IF;

  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one raw material is required'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  v_number := 'PR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO production_requests(factory_id, request_number, requested_by_name, requested_by, department,
                                   request_type, product_id, quantity_requested, unit, remarks)
  VALUES (v_factory, v_number, v_requested_by_name, v_uid, v_department,
          'production_material', v_product_id, v_qty, COALESCE(v_unit, v_product.unit), v_remarks)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    IF (v_item->>'material_id') IS NULL OR (v_item->>'quantity')::numeric <= 0 THEN
      RAISE EXCEPTION 'Each material line needs a material and a quantity > 0';
    END IF;
    INSERT INTO production_request_items(request_id, material_id, quantity_requested, unit)
    VALUES (v_id, (v_item->>'material_id')::uuid, (v_item->>'quantity')::numeric, v_item->>'unit');
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'request_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_production_request(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a request you submitted yourself';
  END IF;
  IF v_row.request_type = 'production_material'
     AND NOT public.has_permission_for_factory(v_uid, 'production-requests'::module_key, 'approve'::action_key, v_row.factory_id) THEN
    RAISE EXCEPTION 'You do not have production approval access for this factory';
  END IF;

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved'
  WHERE id = p_id;

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_production_request(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_production_request(p_id uuid, p_approver_name text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a request you submitted yourself';
  END IF;
  IF v_row.request_type = 'production_material'
     AND NOT public.has_permission_for_factory(v_uid, 'production-requests'::module_key, 'reject'::action_key, v_row.factory_id) THEN
    RAISE EXCEPTION 'You do not have production approval access for this factory';
  END IF;

  UPDATE production_requests SET
    approval_status = 'rejected', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'rejected',
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_production_request(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.issue_production_request_materials(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_request_id uuid := (payload->>'request_id')::uuid;
  v_issued_by text := payload->>'issued_by_name';
  v_row production_requests%ROWTYPE;
  v_item production_request_items%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_issued_by IS NULL OR btrim(v_issued_by) = '' THEN RAISE EXCEPTION 'Issuer name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = v_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.request_type <> 'production_material' THEN RAISE EXCEPTION 'Only production-material requests can have materials issued'; END IF;
  IF NOT public.has_permission_for_factory(v_uid, 'production-requests'::module_key, 'submit'::action_key, v_row.factory_id) THEN
    RAISE EXCEPTION 'You do not have production access for this factory';
  END IF;
  IF v_row.approval_status <> 'approved' THEN RAISE EXCEPTION 'Request must be approved before materials can be issued'; END IF;
  IF v_row.materials_issued THEN RAISE EXCEPTION 'Materials already issued for this request'; END IF;

  FOR v_item IN SELECT * FROM production_request_items WHERE request_id = v_request_id LOOP
    PERFORM issue_raw_material(jsonb_build_object(
      'material_id', v_item.material_id,
      'quantity', v_item.quantity_requested,
      'purpose', 'production',
      'reference', v_row.request_number,
      'reason', 'Production Request ' || v_row.request_number
    ));
    UPDATE production_request_items SET quantity_issued = quantity_requested WHERE id = v_item.id;
  END LOOP;

  UPDATE production_requests SET
    materials_issued = true, issued_by_name = v_issued_by, issued_at = now(),
    production_status = 'materials_issued'
  WHERE id = v_request_id;

  RETURN jsonb_build_object('issued', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.issue_production_request_materials(jsonb) TO authenticated;
