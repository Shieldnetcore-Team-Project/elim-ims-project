
-- The app currently has no login flow, so every browser session hits Postgres as the
-- `anon` role, not `authenticated`. Every policy and grant so far was `TO authenticated`
-- only, and every write RPC hard-rejects a null auth.uid(). Net effect: the whole app is
-- read/write-blocked for anyone without a leftover session. This migration opens the
-- same permissive access already granted to `authenticated` up to `anon` as well, and
-- relaxes the RPCs so they no longer require a signed-in caller. `user_id`/`created_by`/
-- `received_by` columns are all nullable, so an anonymous actor just records as NULL.

-- ============ TABLE GRANTS: mirror authenticated -> anon ============
GRANT SELECT ON public.factories TO anon;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.settings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raw_materials TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.production TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_items TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments_received TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.debts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.debt_payments TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raw_material_movements TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_movements TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO anon;
GRANT SELECT, INSERT ON public.audit_logs TO anon;
GRANT SELECT, INSERT, DELETE ON public.employee_documents TO anon;

-- ============ RLS POLICIES: add anon alongside authenticated ============
ALTER POLICY "auth read factories" ON public.factories TO anon, authenticated;
ALTER POLICY "read own profile" ON public.profiles TO anon, authenticated;
ALTER POLICY "update own profile" ON public.profiles TO anon, authenticated;
ALTER POLICY "insert own profile" ON public.profiles TO anon, authenticated;
ALTER POLICY "read team profiles" ON public.profiles TO anon, authenticated;
ALTER POLICY "read own roles" ON public.user_roles TO anon, authenticated;
ALTER POLICY "read settings" ON public.settings TO anon, authenticated;
ALTER POLICY "auth manage categories" ON public.product_categories TO anon, authenticated;
ALTER POLICY "auth manage products" ON public.products TO anon, authenticated;
ALTER POLICY "auth manage raw materials" ON public.raw_materials TO anon, authenticated;
ALTER POLICY "auth manage suppliers" ON public.suppliers TO anon, authenticated;
ALTER POLICY "auth manage customers" ON public.customers TO anon, authenticated;
ALTER POLICY "auth manage employees" ON public.employees TO anon, authenticated;
ALTER POLICY "auth manage production" ON public.production TO anon, authenticated;
ALTER POLICY "auth manage sales" ON public.sales TO anon, authenticated;
ALTER POLICY "auth manage sale items" ON public.sale_items TO anon, authenticated;
ALTER POLICY "auth manage expense categories" ON public.expense_categories TO anon, authenticated;
ALTER POLICY "auth manage expenses" ON public.expenses TO anon, authenticated;
ALTER POLICY "auth manage payroll" ON public.payroll TO anon, authenticated;
ALTER POLICY "auth manage payments received" ON public.payments_received TO anon, authenticated;
ALTER POLICY "auth manage debts" ON public.debts TO anon, authenticated;
ALTER POLICY "auth manage debt payments" ON public.debt_payments TO anon, authenticated;
ALTER POLICY "auth manage rmm" ON public.raw_material_movements TO anon, authenticated;
ALTER POLICY "auth manage inv movements" ON public.inventory_movements TO anon, authenticated;
ALTER POLICY "read own notifications" ON public.notifications TO anon, authenticated;
ALTER POLICY "update own notifications" ON public.notifications TO anon, authenticated;
ALTER POLICY "insert audit logs" ON public.audit_logs TO anon, authenticated;
ALTER POLICY "auth manage employee documents" ON public.employee_documents TO anon, authenticated;

-- "admin manage settings" and "read audit logs" gate on is_admin()/has_role(), which
-- always resolves false for an anonymous caller (auth.uid() is null) -- add parallel
-- fully-open policies for anon so those two screens keep working without a session.
CREATE POLICY "anon manage settings" ON public.settings FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon read audit logs" ON public.audit_logs FOR SELECT TO anon USING (true);

-- user_roles never had an INSERT/UPDATE/DELETE policy at all (only the first-user
-- trigger could write it) -- needed now for the Users & Roles admin screen.
CREATE POLICY "manage user roles" ON public.user_roles FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ============ STORAGE ============
ALTER POLICY "auth read expense attachments" ON storage.objects TO anon, authenticated;
ALTER POLICY "auth upload expense attachments" ON storage.objects TO anon, authenticated;
-- The delete-own policy checks owner = auth.uid(), which anon-uploaded objects can never
-- satisfy (owner is null too) -- add a fully-open anon delete policy for this bucket.
CREATE POLICY "anon delete expense attachments" ON storage.objects FOR DELETE TO anon
  USING (bucket_id = 'expense-attachments');
ALTER POLICY "auth read employee files" ON storage.objects TO anon, authenticated;
ALTER POLICY "auth upload employee files" ON storage.objects TO anon, authenticated;
ALTER POLICY "auth delete employee files" ON storage.objects TO anon, authenticated;

-- ============ RPCs: drop the "not authenticated" guard ============
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

    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
    VALUES (v_factory, v_product.id, 'sold', v_qty, v_invoice, 'Sale', v_uid);
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

CREATE OR REPLACE FUNCTION public.record_payment(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_debt_id uuid := NULLIF(payload->>'debt_id','')::uuid;
  v_sale_id uuid := NULLIF(payload->>'sale_id','')::uuid;
  v_amount numeric := COALESCE((payload->>'amount')::numeric, 0);
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_date date := COALESCE((payload->>'payment_date')::date, CURRENT_DATE);
  v_remarks text := payload->>'remarks';
  v_prefix text;
  v_receipt text;
  v_payment_id uuid;
  v_debt debts%ROWTYPE;
  v_new_paid numeric;
  v_new_out numeric;
  v_status debt_status;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;

  IF v_debt_id IS NULL AND v_sale_id IS NOT NULL THEN
    SELECT id INTO v_debt_id FROM debts WHERE sale_id = v_sale_id AND status <> 'paid' LIMIT 1;
  END IF;

  SELECT COALESCE(receipt_prefix,'RCP-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'RCP-'; END IF;
  v_receipt := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
  VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount, v_method, v_date, v_uid, v_remarks)
  RETURNING id INTO v_payment_id;

  IF v_debt_id IS NOT NULL THEN
    SELECT * INTO v_debt FROM debts WHERE id = v_debt_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'debt not found'; END IF;
    IF v_sale_id IS NULL THEN v_sale_id := v_debt.sale_id; END IF;

    v_new_paid := v_debt.amount_paid + v_amount;
    v_new_out := GREATEST(v_debt.total_amount - v_new_paid, 0);
    v_status := CASE WHEN v_new_out = 0 THEN 'paid'::debt_status
                     WHEN v_new_paid > 0 THEN 'partial'::debt_status
                     ELSE 'unpaid'::debt_status END;
    UPDATE debts SET amount_paid = v_new_paid, outstanding = v_new_out, status = v_status, updated_at = now()
     WHERE id = v_debt_id;

    INSERT INTO debt_payments(debt_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_debt_id, v_amount, v_method, v_date, v_uid, v_remarks);

    IF v_debt.customer_id IS NOT NULL THEN
      UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_amount, 0), updated_at = now()
       WHERE id = v_debt.customer_id;
    END IF;
  ELSIF v_customer IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_amount, 0), updated_at = now()
     WHERE id = v_customer;
  END IF;

  IF v_sale_id IS NOT NULL THEN
    UPDATE sales SET amount_paid = amount_paid + v_amount, balance = GREATEST(balance - v_amount, 0)
     WHERE id = v_sale_id;
  END IF;

  RETURN jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_payment(jsonb) TO anon, authenticated;

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

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
  VALUES (v_factory, v_product_id, 'produced', v_qty, v_number, 'Production', v_uid);

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
    UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
    VALUES (v_row.factory_id, v_row.product_id, 'adjusted', v_delta, v_row.production_number, 'Production edited', v_uid);
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
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;

  UPDATE products SET current_stock = current_stock - v_row.quantity_produced, updated_at = now() WHERE id = v_row.product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
  VALUES (v_row.factory_id, v_row.product_id, 'adjusted', -v_row.quantity_produced, v_row.production_number, 'Production deleted', v_uid);

  DELETE FROM production WHERE id = p_id;

  RETURN jsonb_build_object('deleted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_production(uuid) TO anon, authenticated;

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

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
  VALUES (v_product.factory_id, v_product_id, v_movement_type, v_delta, NULL,
          COALESCE(v_reason, initcap(v_movement_type::text)), v_uid);

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
GRANT EXECUTE ON FUNCTION public.transfer_finished_stock(jsonb) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.close_debt(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_debt debts%ROWTYPE;
  v_written_off numeric;
BEGIN
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.status = 'paid' THEN RAISE EXCEPTION 'Debt is already closed'; END IF;

  v_written_off := v_debt.outstanding;

  UPDATE debts SET amount_paid = total_amount, outstanding = 0, status = 'paid', updated_at = now()
   WHERE id = p_debt_id;

  IF v_debt.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_written_off, 0), updated_at = now()
     WHERE id = v_debt.customer_id;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'close_debt', 'debts', p_debt_id::text,
          jsonb_build_object('outstanding', v_debt.outstanding, 'status', v_debt.status),
          jsonb_build_object('outstanding', 0, 'status', 'paid', 'written_off', v_written_off, 'reason', p_reason));

  RETURN jsonb_build_object('closed', true, 'written_off', v_written_off);
END;
$$;
GRANT EXECUTE ON FUNCTION public.close_debt(uuid, text) TO anon, authenticated;

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

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id)
  VALUES (v_material.factory_id, v_material_id, 'received', v_qty, COALESCE(v_unit_cost, v_material.unit_cost),
          to_char(v_purchase_date, 'YYYY-MM-DD'), v_remarks, v_uid);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.receive_raw_material(jsonb) TO anon, authenticated;

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

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id)
  VALUES (v_material.factory_id, v_material_id, 'adjusted', v_delta, v_material.unit_cost, NULL, COALESCE(v_reason, 'Manual adjustment'), v_uid);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_raw_material(jsonb) TO anon, authenticated;
