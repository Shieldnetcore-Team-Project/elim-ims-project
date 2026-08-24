-- ============================================================================
-- PRODUCTION REQUESTS -> PURCHASE-CAPABLE + SECURED (spec 15)
-- ----------------------------------------------------------------------------
-- Extends the existing "request materials for a production run" flow to
-- also handle real supplier purchase requests (request_type='purchase'),
-- per the decision to extend rather than build a parallel table.
--
-- SECURITY FIX, in scope because spec 15 explicitly requires "the maker
-- cannot approve the request": production_requests currently has
-- RLS `USING (true)` for anon+authenticated (open to literally anyone) and
-- approve_production_request()/reject_production_request() have ZERO
-- permission check and ZERO self-approval block -- a requester can approve
-- their own request today, and even an unauthenticated caller can write to
-- this table directly. Both are fixed here.
-- ============================================================================

-- ============ 1. Table: purchase-type support ============
ALTER TABLE public.production_requests ADD COLUMN IF NOT EXISTS request_type text NOT NULL DEFAULT 'production_material'
  CHECK (request_type IN ('production_material','purchase'));
ALTER TABLE public.production_requests ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE public.production_requests ADD COLUMN IF NOT EXISTS material_id uuid REFERENCES public.raw_materials(id);
ALTER TABLE public.production_requests ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES public.suppliers(id);
ALTER TABLE public.production_requests ADD COLUMN IF NOT EXISTS po_number text;

ALTER TABLE public.production_requests DROP CONSTRAINT IF EXISTS production_requests_type_shape_check;
ALTER TABLE public.production_requests ADD CONSTRAINT production_requests_type_shape_check CHECK (
  (request_type = 'production_material' AND product_id IS NOT NULL AND material_id IS NULL) OR
  (request_type = 'purchase' AND material_id IS NOT NULL AND product_id IS NULL)
);

-- ============ 2. Lock down RLS: RPC-only writes from here on ============
DROP POLICY IF EXISTS "manage production requests" ON public.production_requests;
REVOKE ALL ON public.production_requests FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.production_requests FROM authenticated;
CREATE POLICY "production requests read" ON public.production_requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production-requests'::module_key, 'view'::action_key));

DROP POLICY IF EXISTS "manage production request items" ON public.production_request_items;
REVOKE ALL ON public.production_request_items FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.production_request_items FROM authenticated;
CREATE POLICY "production request items read" ON public.production_request_items FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production-requests'::module_key, 'view'::action_key));

-- ============ 3. create_production_request(): permission guard + purchase branch ============
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

-- ============ 4. approve_production_request(): permission guard + self-block ============
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

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved',
    po_number = CASE WHEN v_row.request_type = 'purchase' THEN
      'PO-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0')
      ELSE po_number END
  WHERE id = p_id;

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_production_request(uuid, text) TO authenticated;

-- ============ 5. reject_production_request(): permission guard + self-block ============
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

-- ============ 6. issue_production_request_materials(): permission guard ============
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
