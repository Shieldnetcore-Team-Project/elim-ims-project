
-- ============ RAW MATERIALS ============
CREATE OR REPLACE FUNCTION public.receive_raw_material(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_unit_cost numeric := NULLIF(payload->>'unit_cost','')::numeric;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_purchase_date date := COALESCE((payload->>'purchase_date')::date, CURRENT_DATE);
  v_remarks text := payload->>'remarks';
  v_material raw_materials%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;

  UPDATE raw_materials SET
    current_stock = current_stock + v_qty,
    unit_cost = COALESCE(v_unit_cost, unit_cost),
    supplier_id = COALESCE(v_supplier_id, supplier_id),
    updated_at = now()
  WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id)
  VALUES (v_material.factory_id, v_material_id, 'received', v_qty, COALESCE(v_unit_cost, v_material.unit_cost),
          to_char(v_purchase_date, 'YYYY-MM-DD'), v_remarks, v_uid);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.receive_raw_material(jsonb) TO authenticated;

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
  v_reason text := payload->>'reason';
  v_reference text := payload->>'reference';
  v_material raw_materials%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF v_material.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_material.current_stock, v_qty;
  END IF;

  UPDATE raw_materials SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id)
  VALUES (v_material.factory_id, v_material_id, 'issued', v_qty, v_material.unit_cost, v_reference, v_reason, v_uid);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.issue_raw_material(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.adjust_raw_material(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_reason text := payload->>'reason';
  v_material raw_materials%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'Adjustment must be non-zero'; END IF;

  UPDATE raw_materials SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id)
  VALUES (v_material.factory_id, v_material_id, 'adjusted', v_delta, v_material.unit_cost, NULL, COALESCE(v_reason, 'Manual adjustment'), v_uid);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_raw_material(jsonb) TO authenticated;

-- ============ FINISHED GOODS ============
-- Widen adjust_finished_stock to also cover damages/returns (same mechanics, different
-- movement_type for reporting), instead of three near-identical functions.
CREATE OR REPLACE FUNCTION public.adjust_finished_stock(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_reason text := payload->>'reason';
  v_movement_type movement_type := COALESCE((payload->>'movement_type')::movement_type, 'adjusted');
  v_product products%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_movement_type NOT IN ('adjusted','damaged','returned') THEN
    RAISE EXCEPTION 'Invalid movement_type for a manual adjustment';
  END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'Adjustment must be non-zero'; END IF;

  UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
  VALUES (v_product.factory_id, v_product_id, v_movement_type, v_delta, NULL,
          COALESCE(v_reason, initcap(v_movement_type::text)), v_uid);

  RETURN jsonb_build_object('adjusted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_finished_stock(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.transfer_finished_stock(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_to_factory uuid := (payload->>'to_factory_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_reason text := payload->>'reason';
  v_source products%ROWTYPE;
  v_dest_id uuid;
  v_from_name text;
  v_to_name text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_source FROM products WHERE id = v_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_source.factory_id = v_to_factory THEN RAISE EXCEPTION 'Source and destination factory are the same'; END IF;
  IF v_source.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_source.current_stock, v_qty;
  END IF;

  SELECT name INTO v_from_name FROM factories WHERE id = v_source.factory_id;
  SELECT name INTO v_to_name FROM factories WHERE id = v_to_factory;

  SELECT id INTO v_dest_id FROM products WHERE factory_id = v_to_factory AND lower(name) = lower(v_source.name) FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO products(factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active)
    VALUES (v_to_factory, NULL, v_source.sku, v_source.name, v_source.unit, v_source.unit_price, v_source.cost_price, 0, v_source.reorder_level, true)
    RETURNING id INTO v_dest_id;
  END IF;

  UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product_id;
  UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_dest_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
  VALUES (v_source.factory_id, v_product_id, 'transferred', -v_qty, 'To ' || COALESCE(v_to_name,'other factory'), v_reason, v_uid);
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
  VALUES (v_to_factory, v_dest_id, 'transferred', v_qty, 'From ' || COALESCE(v_from_name,'other factory'), v_reason, v_uid);

  RETURN jsonb_build_object('destination_product_id', v_dest_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.transfer_finished_stock(jsonb) TO authenticated;

-- ============ EXPENSE ATTACHMENTS STORAGE ============
INSERT INTO storage.buckets (id, name, public)
VALUES ('expense-attachments', 'expense-attachments', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "auth read expense attachments" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'expense-attachments');
CREATE POLICY "auth upload expense attachments" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'expense-attachments');
CREATE POLICY "auth delete own expense attachments" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'expense-attachments' AND owner = auth.uid());
