-- New Request form now asks only for the raw materials to request; the
-- "product to be produced" is no longer required. production_material rows
-- may therefore have a NULL product_id.

ALTER TABLE public.production_requests DROP CONSTRAINT IF EXISTS production_requests_type_shape_check;
ALTER TABLE public.production_requests ADD CONSTRAINT production_requests_type_shape_check CHECK (
  (request_type = 'production_material' AND material_id IS NULL) OR
  (request_type = 'purchase' AND material_id IS NOT NULL AND product_id IS NULL)
);

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

  IF v_product_id IS NOT NULL THEN
    SELECT * INTO v_product FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
  END IF;

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
