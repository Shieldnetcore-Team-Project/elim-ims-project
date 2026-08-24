-- ============================================================================
-- ADD MATERIAL approval workflow + SUPPLIER field extensions + PO fields
-- ----------------------------------------------------------------------------
-- raw_materials creation becomes RPC-only maker-checker (mirrors goods
-- receiving/production's pattern): request_new_material() inserts as
-- pending_approval/inactive, approve_new_material()/reject_new_material()
-- (creator != approver enforced) flips it active or permanently rejected.
-- Every existing row defaults to approval_status='approved' — nothing
-- already live is affected. Editing an existing material (UPDATE) is
-- unchanged/still direct — only adding a brand-new one is gated, per spec.
-- ============================================================================

-- ============ 1. raw_materials: approval_status, RPC-only creation ============
ALTER TABLE public.raw_materials ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved'
  CHECK (approval_status IN ('pending_approval','approved','rejected'));

REVOKE INSERT ON public.raw_materials FROM authenticated;

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
                             supplier_id, reorder_level, minimum_stock, remarks, approval_status, active)
  VALUES (v_factory, btrim(v_name), v_category_id, btrim(v_unit), v_opening, v_opening, v_unit_cost,
          v_supplier_id, v_reorder, v_minimum, v_remarks, 'pending_approval', false)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_new_material(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_new_material(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row raw_materials%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM raw_materials WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a material you added yourself';
  END IF;
  IF v_row.approval_status <> 'pending_approval' THEN RAISE EXCEPTION 'Material is already %', v_row.approval_status; END IF;

  UPDATE raw_materials SET approval_status = 'approved', active = true WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_new_material', 'raw_materials', p_id::text, jsonb_build_object('comment', p_comment));
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_new_material(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_new_material(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row raw_materials%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM raw_materials WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a material you added yourself';
  END IF;
  IF v_row.approval_status <> 'pending_approval' THEN RAISE EXCEPTION 'Material is already %', v_row.approval_status; END IF;

  UPDATE raw_materials SET
    approval_status = 'rejected', active = false,
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_new_material(uuid, text) TO authenticated;

-- inventory_officer submits new materials; chairman is the second-person
-- approver (same escalation role used for goods-receiving/purchase-orders).
INSERT INTO public.role_permissions (role, module, action)
SELECT 'inventory_officer','raw-materials', a FROM unnest(ARRAY['submit']::action_key[]) a
UNION ALL
SELECT 'chairman','raw-materials', a FROM unnest(ARRAY['approve','reject']::action_key[]) a
ON CONFLICT DO NOTHING;

-- ============ 2. suppliers: extend the record ============
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS contact_person text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS bank_account_number text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS bank_account_name text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'));
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

DROP TRIGGER IF EXISTS suppliers_set_created_by ON public.suppliers;
CREATE TRIGGER suppliers_set_created_by BEFORE INSERT ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

-- ============ 3. purchase_orders: approved_by (denormalized from the
-- originating request's approver) + total_amount ============
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS approved_by_name text;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS total_amount numeric(14,2);

CREATE OR REPLACE FUNCTION public.create_purchase_order(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_request_id uuid := (payload->>'purchase_request_id')::uuid;
  v_issued_by_name text := payload->>'issued_by_name';
  v_quantity numeric := (payload->>'quantity_ordered')::numeric;
  v_unit_cost numeric := NULLIF(payload->>'unit_cost','')::numeric;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_expected date := NULLIF(payload->>'expected_delivery_date','')::date;
  v_notes text := payload->>'notes';
  v_req production_requests%ROWTYPE;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'purchase-orders', 'create'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_issued_by_name IS NULL OR btrim(v_issued_by_name) = '' THEN RAISE EXCEPTION 'Issuer name is required'; END IF;

  SELECT * INTO v_req FROM production_requests WHERE id = v_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase request not found'; END IF;
  IF v_req.request_type <> 'purchase' THEN RAISE EXCEPTION 'Only purchase-type requests can have a purchase order'; END IF;
  IF v_req.approval_status <> 'approved' THEN RAISE EXCEPTION 'Request must be approved before a purchase order can be issued'; END IF;
  IF EXISTS (SELECT 1 FROM purchase_orders WHERE purchase_request_id = v_request_id) THEN
    RAISE EXCEPTION 'A purchase order already exists for this request';
  END IF;

  IF v_quantity IS NULL OR v_quantity <= 0 THEN v_quantity := v_req.quantity_requested; END IF;
  IF v_supplier_id IS NULL THEN v_supplier_id := v_req.supplier_id; END IF;

  v_number := 'PO-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO purchase_orders(factory_id, po_number, purchase_request_id, supplier_id, material_id,
                               quantity_ordered, unit, unit_cost, expected_delivery_date, notes,
                               issued_by, issued_by_name, approved_by_name, total_amount)
  VALUES (v_req.factory_id, v_number, v_request_id, v_supplier_id, v_req.material_id,
          v_quantity, v_req.unit, v_unit_cost, v_expected, v_notes,
          v_uid, v_issued_by_name, v_req.approved_by_name,
          CASE WHEN v_unit_cost IS NOT NULL THEN v_unit_cost * v_quantity ELSE NULL END)
  RETURNING id INTO v_id;

  UPDATE production_requests SET po_number = v_number, production_status = 'po_issued' WHERE id = v_request_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_req.factory_id, 'create', 'purchase_orders', v_id::text, jsonb_build_object('po_number', v_number, 'quantity_ordered', v_quantity));

  RETURN jsonb_build_object('id', v_id, 'po_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_purchase_order(jsonb) TO authenticated;
