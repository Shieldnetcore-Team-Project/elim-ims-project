-- ============================================================================
-- PRODUCTION SCOPE, CONFIGURABLE PRODUCTION TYPES & PACKAGING CONVERSION
-- ----------------------------------------------------------------------------
-- Supersedes last turn's has_permission_for_factory()/get_my_production_factories()
-- (built on user_roles.factory_id, one scope per role GRANT) with a single
-- production_scope column directly on profiles (NYLON/WATER/BOTH) -- one fact
-- about the person, not about each role they hold. Two mechanisms for the same
-- thing is a drift hazard, so the old one is dropped outright, not left dormant.
-- ============================================================================

-- ============ 1. profiles.production_scope ============
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS production_scope text NOT NULL DEFAULT 'BOTH'
  CHECK (production_scope IN ('NYLON','WATER','BOTH'));

-- ============ 2. has_production_scope_access(): replaces has_permission_for_factory() ============
-- Drop the policies that reference it first (they're recreated in step 6).
DROP POLICY IF EXISTS "production read" ON public.production;
DROP POLICY IF EXISTS "production requests read" ON public.production_requests;
DROP POLICY IF EXISTS "production request items read" ON public.production_request_items;
DROP FUNCTION IF EXISTS public.has_permission_for_factory(uuid, public.module_key, public.action_key, uuid);
DROP FUNCTION IF EXISTS public.get_my_production_factories();

CREATE OR REPLACE FUNCTION public.has_production_scope_access(_user_id uuid, _factory_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_scope text; v_factory_code text;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;
  IF public.has_role(_user_id, 'super_admin') THEN RETURN true; END IF;
  IF _factory_id IS NULL THEN RETURN true; END IF;

  SELECT production_scope INTO v_scope FROM profiles WHERE id = _user_id;
  IF v_scope IS NULL OR v_scope = 'BOTH' THEN RETURN true; END IF;

  SELECT upper(code) INTO v_factory_code FROM factories WHERE id = _factory_id;
  RETURN v_factory_code = v_scope;
END;
$$;
GRANT EXECUTE ON FUNCTION public.has_production_scope_access(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_production_scope(p_user_id uuid, p_scope text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_permission(v_uid, 'users'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_scope NOT IN ('NYLON','WATER','BOTH') THEN RAISE EXCEPTION 'Invalid production scope'; END IF;

  UPDATE profiles SET production_scope = p_scope WHERE id = p_user_id;
  INSERT INTO audit_logs(user_id, action, entity, entity_id, new_value)
  VALUES (v_uid, 'update', 'profiles', p_user_id::text, jsonb_build_object('production_scope', p_scope));
  RETURN jsonb_build_object('updated', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.set_production_scope(uuid, text) TO authenticated;

-- Finance needs to see production costs for cash-flow/costing calculations
-- (spec: "Finance can see production information required for financial
-- operations") -- this grant was missing even before last turn's factory
-- gate, silently starving _app.cash-ledger.index.tsx's "production costs"
-- bucket for accountants. View-only, no edit/approve -- production stays
-- Production's exclusive write surface.
INSERT INTO public.role_permissions (role, module, action)
SELECT r, 'production', a FROM unnest(ARRAY['accountant','chairman']) r, unnest(ARRAY['view','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;

-- ============ 3. production_types: admin-configurable, not hard-coded ============
CREATE TABLE public.production_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  department text,
  production_scope text NOT NULL DEFAULT 'BOTH' CHECK (production_scope IN ('NYLON','WATER','BOTH')),
  unit_of_measure text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.production_types TO authenticated;
GRANT ALL ON public.production_types TO service_role;
ALTER TABLE public.production_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "production types read" ON public.production_types FOR SELECT TO authenticated USING (true);
CREATE POLICY "production types write" ON public.production_types FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'settings'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'settings'::module_key, 'write'::action_key));
CREATE TRIGGER production_types_touch BEFORE UPDATE ON public.production_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.production_types (name, code, department, production_scope, unit_of_measure) VALUES
  ('Nylon Bag', 'NYLON_BAG', 'Production', 'NYLON', 'pieces'),
  ('Nylon Film', 'NYLON_FILM', 'Production', 'NYLON', 'kg'),
  ('Pure Water', 'PURE_WATER', 'Production', 'WATER', 'pieces'),
  ('Other', 'OTHER', 'Production', 'BOTH', NULL)
ON CONFLICT (code) DO NOTHING;

-- ============ 4. product_units: configurable packaging/conversion rules ============
-- One product can have several packaging tiers (e.g. carton AND pallet), each
-- with its own conversion back to the product's stocking (base) unit.
CREATE TABLE public.product_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  base_unit text NOT NULL,
  packaging_unit text NOT NULL,
  conversion_factor numeric(14,4) NOT NULL CHECK (conversion_factor > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, packaging_unit)
);
GRANT SELECT ON public.product_units TO authenticated;
GRANT ALL ON public.product_units TO service_role;
ALTER TABLE public.product_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product units read" ON public.product_units FOR SELECT TO authenticated USING (true);
CREATE POLICY "product units write" ON public.product_units FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'write'::action_key));
CREATE TRIGGER product_units_touch BEFORE UPDATE ON public.product_units FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ 5. production: new columns for type/department/scope/packaging ============
ALTER TABLE public.production ADD COLUMN IF NOT EXISTS production_type_id uuid REFERENCES public.production_types(id);
ALTER TABLE public.production ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE public.production ADD COLUMN IF NOT EXISTS production_scope text CHECK (production_scope IN ('NYLON','WATER','BOTH'));
ALTER TABLE public.production ADD COLUMN IF NOT EXISTS packaging_unit text;
ALTER TABLE public.production ADD COLUMN IF NOT EXISTS packaging_quantity numeric(14,3);

-- ============ 6. RLS: production / production_requests / production_request_items,
-- re-pointed from has_permission_for_factory() to has_production_scope_access() ============
DROP POLICY IF EXISTS "production read" ON public.production;
CREATE POLICY "production read" ON public.production FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'production'::module_key, 'read'::action_key)
    AND public.has_production_scope_access(auth.uid(), factory_id)
  );

DROP POLICY IF EXISTS "production requests read" ON public.production_requests;
CREATE POLICY "production requests read" ON public.production_requests FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'production-requests'::module_key, 'view'::action_key)
    AND (request_type = 'purchase' OR public.has_production_scope_access(auth.uid(), factory_id))
  );

DROP POLICY IF EXISTS "production request items read" ON public.production_request_items;
CREATE POLICY "production request items read" ON public.production_request_items FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'production-requests'::module_key, 'view'::action_key)
    AND EXISTS (
      SELECT 1 FROM public.production_requests pr WHERE pr.id = request_id
        AND (pr.request_type = 'purchase' OR public.has_production_scope_access(auth.uid(), pr.factory_id))
    )
  );

-- ============ 7. create_production(): production type required, packaging-aware,
-- auto-associates department/scope, factory check via has_production_scope_access() ============
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
  v_production_type_id uuid := NULLIF(payload->>'production_type_id','')::uuid;
  v_packaging_unit text := NULLIF(payload->>'packaging_unit','');
  v_packaging_qty numeric := NULLIF(payload->>'packaging_quantity','')::numeric;
  v_qty numeric := NULLIF(payload->>'quantity_produced','')::numeric;
  v_unit text := payload->>'unit';
  v_cost numeric := COALESCE((payload->>'production_cost')::numeric, 0);
  v_supervisor text := payload->>'supervisor';
  v_batch text := payload->>'batch_number';
  v_remarks text := payload->>'remarks';
  v_date date := COALESCE((payload->>'production_date')::date, CURRENT_DATE);
  v_request_id uuid := NULLIF(payload->>'production_request_id','')::uuid;
  v_prefix text; v_number text; v_id uuid; v_product products%ROWTYPE;
  v_department text; v_scope text; v_conversion numeric; v_type_scope text;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'create'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT public.has_production_scope_access(v_uid, v_factory) THEN RAISE EXCEPTION 'Your production scope does not cover this factory'; END IF;

  IF v_production_type_id IS NULL THEN RAISE EXCEPTION 'Production type is required'; END IF;
  SELECT production_scope INTO v_type_scope FROM production_types WHERE id = v_production_type_id AND active;
  IF v_type_scope IS NULL THEN RAISE EXCEPTION 'Production type not found or inactive'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  SELECT department INTO v_department FROM profiles WHERE id = v_uid;
  SELECT upper(code) INTO v_scope FROM factories WHERE id = v_factory;

  IF v_type_scope <> 'BOTH' AND v_type_scope <> v_scope THEN
    RAISE EXCEPTION 'This production type is not configured for the % factory', v_scope;
  END IF;

  -- Packaging entry: "500 cartons" instead of a raw base-unit count.
  -- quantity_produced always ends up in the product's base/stocking unit so
  -- Store confirmation and stock posting never have to think about
  -- packaging -- only this record remembers the human-facing "500 cartons".
  IF v_packaging_unit IS NOT NULL THEN
    SELECT conversion_factor INTO v_conversion FROM product_units
    WHERE product_id = v_product_id AND packaging_unit = v_packaging_unit AND active;
    IF v_conversion IS NULL THEN RAISE EXCEPTION 'No active packaging conversion configured for % on this product', v_packaging_unit; END IF;
    IF v_packaging_qty IS NULL OR v_packaging_qty <= 0 THEN RAISE EXCEPTION 'Packaging quantity must be > 0'; END IF;
    v_qty := v_packaging_qty * v_conversion;
  END IF;

  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  IF v_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM production_requests WHERE id = v_request_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Production request not found for this factory';
    END IF;
  END IF;

  SELECT COALESCE(production_prefix,'PRD-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'PRD-'; END IF;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO production(factory_id, production_number, production_date, product_id, quantity_produced, unit,
                          production_cost, supervisor, batch_number, remarks, created_by, production_request_id,
                          production_type_id, department, production_scope, packaging_unit, packaging_quantity)
  VALUES (v_factory, v_number, v_date, v_product_id, v_qty, COALESCE(v_unit, v_product.unit),
          v_cost, v_supervisor, v_batch, v_remarks, v_uid, v_request_id,
          v_production_type_id, v_department, v_scope, v_packaging_unit, v_packaging_qty)
  RETURNING id INTO v_id;

  IF v_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed', production_id = v_id WHERE id = v_request_id;
  END IF;

  PERFORM public.record_workflow_action('production', v_id, 'submit', NULL, 'pending_confirmation', v_remarks);
  RETURN jsonb_build_object('id', v_id, 'production_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_production(jsonb) TO authenticated;

-- ============ 8. update_production() / cancel_production(): scope-aware ============
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
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key)
     OR NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
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
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'cancel'::action_key)
     OR NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
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

-- ============ 9. production_requests RPCs: production_material rows are
-- scope-aware; purchase-type rows keep the plain, scope-agnostic check ============
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

  IF NOT public.has_production_scope_access(v_uid, v_factory) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
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
  IF v_row.request_type = 'production_material' AND NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
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
  IF v_row.request_type = 'production_material' AND NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
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
  IF NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
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
