
-- General Inventory spec requires: (1) semi-finished products tracked alongside raw
-- materials and finished products, (2) before-and-after stock quantities recorded on every
-- transaction, (3) "stock used for production" tracked distinctly from a general "stock
-- issued". This migration adds the schema for that and rewrites every stock-mutating RPC to
-- populate quantity_before/quantity_after. Existing historical rows are left NULL -- there's
-- no reliable way to reconstruct before/after for movements that already happened.

-- ============ SCHEMA ============
ALTER TABLE public.raw_material_movements ADD COLUMN IF NOT EXISTS quantity_before numeric;
ALTER TABLE public.raw_material_movements ADD COLUMN IF NOT EXISTS quantity_after numeric;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS quantity_before numeric;
ALTER TABLE public.inventory_movements ADD COLUMN IF NOT EXISTS quantity_after numeric;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'finished';
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_product_type_check;
ALTER TABLE public.products ADD CONSTRAINT products_product_type_check
  CHECK (product_type IN ('finished', 'semi_finished'));

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
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;

  UPDATE raw_materials SET
    current_stock = current_stock + v_qty,
    unit_cost = COALESCE(v_unit_cost, unit_cost),
    supplier_id = COALESCE(v_supplier_id, supplier_id),
    updated_at = now()
  WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_material.factory_id, v_material_id, 'received', v_qty, COALESCE(v_unit_cost, v_material.unit_cost),
          to_char(v_purchase_date, 'YYYY-MM-DD'), v_remarks, v_uid, v_material.current_stock, v_material.current_stock + v_qty);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.receive_raw_material(jsonb) TO anon, authenticated;

-- Now distinguishes "used for production" (the default -- matches the existing "Issue to
-- Production" UI) from a general "issued" for any other purpose, via payload.purpose.
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
  v_purpose text := COALESCE(payload->>'purpose', 'production');
  v_movement_type movement_type;
  v_material raw_materials%ROWTYPE;
BEGIN
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  v_movement_type := CASE WHEN v_purpose = 'production' THEN 'used_for_production'::movement_type ELSE 'issued'::movement_type END;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF v_material.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_material.current_stock, v_qty;
  END IF;

  UPDATE raw_materials SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_material.factory_id, v_material_id, v_movement_type, v_qty, v_material.unit_cost, v_reference, v_reason, v_uid,
          v_material.current_stock, v_material.current_stock - v_qty);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.issue_raw_material(jsonb) TO anon, authenticated;

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
  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'Adjustment must be non-zero'; END IF;

  UPDATE raw_materials SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_material.factory_id, v_material_id, 'adjusted', v_delta, v_material.unit_cost, NULL, COALESCE(v_reason, 'Manual adjustment'), v_uid,
          v_material.current_stock, v_material.current_stock + v_delta);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_raw_material(jsonb) TO anon, authenticated;

-- NEW: raw materials had no inter-factory transfer, unlike finished goods. Mirrors
-- transfer_finished_stock so "Stock Transferred" is tracked for every item category.
CREATE OR REPLACE FUNCTION public.transfer_raw_material(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_to_factory uuid := (payload->>'to_factory_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_reason text := payload->>'reason';
  v_source raw_materials%ROWTYPE;
  v_dest_id uuid;
  v_dest_before numeric;
  v_from_name text;
  v_to_name text;
BEGIN
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_source FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF v_source.factory_id = v_to_factory THEN RAISE EXCEPTION 'Source and destination factory are the same'; END IF;
  IF v_source.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_source.current_stock, v_qty;
  END IF;

  SELECT name INTO v_from_name FROM factories WHERE id = v_source.factory_id;
  SELECT name INTO v_to_name FROM factories WHERE id = v_to_factory;

  SELECT id INTO v_dest_id FROM raw_materials WHERE factory_id = v_to_factory AND lower(name) = lower(v_source.name) FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO raw_materials(factory_id, category, name, unit, opening_stock, current_stock, unit_cost, reorder_level, supplier_id, remarks)
    VALUES (v_to_factory, v_source.category, v_source.name, v_source.unit, 0, 0, v_source.unit_cost, v_source.reorder_level, NULL, v_source.remarks)
    RETURNING id INTO v_dest_id;
  END IF;

  SELECT current_stock INTO v_dest_before FROM raw_materials WHERE id = v_dest_id FOR UPDATE;

  UPDATE raw_materials SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_material_id;
  UPDATE raw_materials SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_dest_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_source.factory_id, v_material_id, 'transferred', -v_qty, v_source.unit_cost, 'To ' || COALESCE(v_to_name,'other factory'), v_reason, v_uid,
          v_source.current_stock, v_source.current_stock - v_qty);
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_to_factory, v_dest_id, 'transferred', v_qty, v_source.unit_cost, 'From ' || COALESCE(v_from_name,'other factory'), v_reason, v_uid,
          v_dest_before, v_dest_before + v_qty);

  RETURN jsonb_build_object('destination_material_id', v_dest_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.transfer_raw_material(jsonb) TO anon, authenticated;

-- ============ PRODUCTION (finished / semi-finished output) ============
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

  SELECT COALESCE(production_prefix,'PRD-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'PRD-'; END IF;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO production(factory_id, production_number, production_date, product_id, quantity_produced, unit,
                          production_cost, supervisor, batch_number, remarks, created_by)
  VALUES (v_factory, v_number, v_date, v_product_id, v_qty, COALESCE(v_unit, v_product.unit),
          v_cost, v_supervisor, v_batch, v_remarks, v_uid)
  RETURNING id INTO v_id;

  UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_factory, v_product_id, 'produced', v_qty, v_number, 'Production', v_uid, v_product.current_stock, v_product.current_stock + v_qty);

  RETURN jsonb_build_object('id', v_id, 'production_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_production(jsonb) TO anon, authenticated;

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
  v_delta numeric;
  v_stock_before numeric;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  v_delta := v_qty - v_row.quantity_produced;

  UPDATE production SET
    quantity_produced = v_qty,
    unit = COALESCE(v_unit, unit),
    production_cost = v_cost,
    supervisor = v_supervisor,
    batch_number = v_batch,
    remarks = v_remarks,
    production_date = COALESCE(v_date, production_date)
  WHERE id = v_id;

  IF v_delta <> 0 THEN
    SELECT current_stock INTO v_stock_before FROM products WHERE id = v_row.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'adjusted', v_delta, v_row.production_number, 'Production edited', v_uid,
            v_stock_before, v_stock_before + v_delta);
  END IF;

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_production(jsonb) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.delete_production(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row production%ROWTYPE;
  v_stock_before numeric;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;

  SELECT current_stock INTO v_stock_before FROM products WHERE id = v_row.product_id FOR UPDATE;
  UPDATE products SET current_stock = current_stock - v_row.quantity_produced, updated_at = now() WHERE id = v_row.product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_row.factory_id, v_row.product_id, 'adjusted', -v_row.quantity_produced, v_row.production_number, 'Production deleted', v_uid,
          v_stock_before, v_stock_before - v_row.quantity_produced);

  DELETE FROM production WHERE id = p_id;

  RETURN jsonb_build_object('deleted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_production(uuid) TO anon, authenticated;

-- ============ FINISHED / SEMI-FINISHED GOODS ============
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
  IF v_movement_type NOT IN ('adjusted','damaged','returned') THEN
    RAISE EXCEPTION 'Invalid movement_type for a manual adjustment';
  END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'Adjustment must be non-zero'; END IF;

  UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_product.factory_id, v_product_id, v_movement_type, v_delta, NULL,
          COALESCE(v_reason, initcap(v_movement_type::text)), v_uid, v_product.current_stock, v_product.current_stock + v_delta);

  RETURN jsonb_build_object('adjusted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_finished_stock(jsonb) TO anon, authenticated;

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
  v_dest_before numeric;
  v_from_name text;
  v_to_name text;
BEGIN
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
    INSERT INTO products(factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
    VALUES (v_to_factory, NULL, v_source.sku, v_source.name, v_source.unit, v_source.unit_price, v_source.cost_price, 0, v_source.reorder_level, true, v_source.product_type)
    RETURNING id INTO v_dest_id;
  END IF;

  SELECT current_stock INTO v_dest_before FROM products WHERE id = v_dest_id FOR UPDATE;

  UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product_id;
  UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_dest_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_source.factory_id, v_product_id, 'transferred', -v_qty, 'To ' || COALESCE(v_to_name,'other factory'), v_reason, v_uid,
          v_source.current_stock, v_source.current_stock - v_qty);
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_to_factory, v_dest_id, 'transferred', v_qty, 'From ' || COALESCE(v_from_name,'other factory'), v_reason, v_uid,
          v_dest_before, v_dest_before + v_qty);

  RETURN jsonb_build_object('destination_product_id', v_dest_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.transfer_finished_stock(jsonb) TO anon, authenticated;

-- ============ SALES ============
CREATE OR REPLACE FUNCTION public.create_sale(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_sale_date date := COALESCE((payload->>'sale_date')::date, CURRENT_DATE);
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_customer_name text := payload->>'customer_name';
  v_customer_phone text := payload->>'customer_phone';
  v_customer_address text := payload->>'customer_address';
  v_discount numeric := COALESCE((payload->>'discount')::numeric, 0);
  v_vat numeric := COALESCE((payload->>'vat')::numeric, 0);
  v_amount_paid numeric := COALESCE((payload->>'amount_paid')::numeric, 0);
  v_payment_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_sales_person text := payload->>'sales_person';
  v_remarks text := payload->>'remarks';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_prefix text;
  v_invoice text;
  v_subtotal numeric := 0;
  v_grand numeric := 0;
  v_balance numeric := 0;
  v_sale_id uuid;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'no items'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_product.current_stock < v_qty THEN
      RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
  END LOOP;

  v_grand := GREATEST(v_subtotal - v_discount + v_vat, 0);
  v_balance := GREATEST(v_grand - v_amount_paid, 0);

  SELECT COALESCE(invoice_prefix,'INV-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'INV-'; END IF;
  v_invoice := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, remarks, created_by)
  VALUES (v_factory, v_invoice, v_sale_date, v_customer, v_customer_name, v_customer_phone, v_customer_address,
          v_subtotal, v_discount, v_vat, v_grand, v_amount_paid, v_balance, v_payment_method, v_sales_person, v_remarks, v_uid)
  RETURNING id INTO v_sale_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);

    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_qty * v_price);

    UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product.id;

    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_product.id, 'sold', v_qty, v_invoice, 'Sale', v_uid, v_product.current_stock, v_product.current_stock - v_qty);
  END LOOP;

  IF v_balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_factory, v_customer, v_sale_id, v_grand, v_amount_paid, v_balance,
            CASE WHEN v_amount_paid > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END);
  END IF;

  IF v_customer IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_grand,
           outstanding_balance = outstanding_balance + v_balance,
           updated_at = now()
     WHERE id = v_customer;
  END IF;

  RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                            'subtotal', v_subtotal, 'grand_total', v_grand, 'balance', v_balance);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO anon, authenticated;
