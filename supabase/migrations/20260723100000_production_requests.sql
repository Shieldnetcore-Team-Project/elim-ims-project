
-- Production Request module: a formal request/approval/issue workflow that sits between
-- Inventory and Production, closing the "Purchase -> Stock -> Production Request -> Material
-- Transfer to Production -> Production -> Stock Update" flow. A request captures who asked
-- for materials, what they're for, who approved the request, and who actually handed the
-- materials out -- issuing then reuses issue_raw_material() so it lands in the same
-- raw_material_movements audit trail as every other stock movement, tagged
-- 'used_for_production' with the request number as its reference.

-- ============ TABLES ============
CREATE TABLE public.production_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  request_number text UNIQUE NOT NULL,
  requested_by_name text NOT NULL,
  requested_by uuid REFERENCES auth.users(id),
  department text,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity_requested numeric(14,3) NOT NULL CHECK (quantity_requested > 0),
  unit text,
  request_date timestamptz NOT NULL DEFAULT now(),
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
  approved_by_name text,
  approval_date timestamptz,
  materials_issued boolean NOT NULL DEFAULT false,
  issued_by_name text,
  issued_at timestamptz,
  production_status text NOT NULL DEFAULT 'pending'
    CHECK (production_status IN ('pending','approved','materials_issued','completed','rejected','cancelled')),
  production_id uuid,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_requests TO anon, authenticated;
GRANT ALL ON public.production_requests TO service_role;
ALTER TABLE public.production_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manage production requests" ON public.production_requests FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.production_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.production_requests(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.raw_materials(id),
  quantity_requested numeric(14,3) NOT NULL CHECK (quantity_requested > 0),
  unit text,
  quantity_issued numeric(14,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_request_items TO anon, authenticated;
GRANT ALL ON public.production_request_items TO service_role;
ALTER TABLE public.production_request_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manage production request items" ON public.production_request_items FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Link a production run back to the request that authorized it, for full traceability.
ALTER TABLE public.production ADD COLUMN IF NOT EXISTS production_request_id uuid REFERENCES public.production_requests(id);
ALTER TABLE public.production_requests ADD CONSTRAINT production_requests_production_id_fkey
  FOREIGN KEY (production_id) REFERENCES public.production(id);

-- ============ RPCs ============
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
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity_requested')::numeric;
  v_unit text := payload->>'unit';
  v_remarks text := payload->>'remarks';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_number text;
  v_id uuid;
  v_product products%ROWTYPE;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_requested_by_name IS NULL OR btrim(v_requested_by_name) = '' THEN RAISE EXCEPTION 'Requesting staff name is required'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity requested must be > 0'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one raw material is required'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  v_number := 'PR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO production_requests(factory_id, request_number, requested_by_name, requested_by, department,
                                   product_id, quantity_requested, unit, remarks)
  VALUES (v_factory, v_number, v_requested_by_name, v_uid, v_department,
          v_product_id, v_qty, COALESCE(v_unit, v_product.unit), v_remarks)
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
GRANT EXECUTE ON FUNCTION public.create_production_request(jsonb) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE;
BEGIN
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved'
  WHERE id = p_id;

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_production_request(uuid, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.reject_production_request(p_id uuid, p_approver_name text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE;
BEGIN
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;

  UPDATE production_requests SET
    approval_status = 'rejected', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'rejected',
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_production_request(uuid, text, text) TO anon, authenticated;

-- Issues every line item via issue_raw_material() so each material draw lands in the normal
-- raw_material_movements audit trail (with quantity_before/after) tagged 'used_for_production'.
CREATE OR REPLACE FUNCTION public.issue_production_request_materials(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id uuid := (payload->>'request_id')::uuid;
  v_issued_by text := payload->>'issued_by_name';
  v_row production_requests%ROWTYPE;
  v_item production_request_items%ROWTYPE;
BEGIN
  IF v_issued_by IS NULL OR btrim(v_issued_by) = '' THEN RAISE EXCEPTION 'Issuer name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = v_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
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
GRANT EXECUTE ON FUNCTION public.issue_production_request_materials(jsonb) TO anon, authenticated;

-- create_production now optionally closes the loop back to the request that triggered it.
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
  v_prefix text;
  v_number text;
  v_id uuid;
  v_product products%ROWTYPE;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id FOR UPDATE;
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

  UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_factory, v_product_id, 'produced', v_qty, v_number, 'Production', v_uid, v_product.current_stock, v_product.current_stock + v_qty);

  IF v_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed', production_id = v_id WHERE id = v_request_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'production_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_production(jsonb) TO anon, authenticated;
