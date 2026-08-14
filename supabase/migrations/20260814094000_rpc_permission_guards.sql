
-- ============================================================
-- Adds a has_permission() guard to the top of every write RPC. These are
-- SECURITY DEFINER functions, so table-level grants and RLS never applied
-- to them -- until now, any authenticated caller with EXECUTE could run
-- any of them regardless of role. Each function body below is otherwise
-- byte-identical to its current definition (the latest CREATE OR REPLACE
-- across the prior 14 migrations); only the guard and the GRANT (anon
-- dropped, matching the anon revocation in the previous migration) change.
-- ============================================================

-- ---------- sales ----------
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
  v_receipt_prefix text;
  v_receipt text;
  v_subtotal numeric := 0;
  v_grand numeric := 0;
  v_balance numeric := 0;
  v_sale_id uuid;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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

  IF v_amount_paid > 0 THEN
    SELECT COALESCE(receipt_prefix,'RCP-') INTO v_receipt_prefix FROM settings WHERE factory_id = v_factory;
    IF v_receipt_prefix IS NULL THEN v_receipt_prefix := 'RCP-'; END IF;
    v_receipt := v_receipt_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount_paid, v_payment_method, v_sale_date, v_uid, 'Payment at point of sale');
  END IF;

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
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;

-- ---------- payments / debts ----------
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
  IF NOT (public.has_permission(v_uid, 'payments', 'write') OR public.has_permission(v_uid, 'debts', 'write')) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
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
GRANT EXECUTE ON FUNCTION public.record_payment(jsonb) TO authenticated;

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
  IF NOT public.has_permission(v_uid, 'debts', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.close_debt(uuid, text) TO authenticated;

-- ---------- receipts-payments ----------
CREATE OR REPLACE FUNCTION public.create_cash_transaction(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_type text := payload->>'transaction_type';
  v_category text := payload->>'category';
  v_amount numeric := (payload->>'amount')::numeric;
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_date date := COALESCE((payload->>'transaction_date')::date, CURRENT_DATE);
  v_description text := payload->>'description';
  v_payer_payee text := payload->>'payer_payee';
  v_reference text := payload->>'related_reference';
  v_recorded_by text := payload->>'recorded_by_name';
  v_prefix text;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'receipts-payments', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_type NOT IN ('receipt','payment') THEN RAISE EXCEPTION 'transaction_type must be receipt or payment'; END IF;
  IF v_category NOT IN ('other_income','donation_endowment','other_inflow','other_outflow') THEN
    RAISE EXCEPTION 'Invalid category';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;
  IF v_recorded_by IS NULL OR btrim(v_recorded_by) = '' THEN RAISE EXCEPTION 'Recorded by name is required'; END IF;

  v_prefix := CASE WHEN v_type = 'receipt' THEN 'RCT-' ELSE 'PMT-' END;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO cash_transactions(factory_id, transaction_number, transaction_date, transaction_type, category,
                                 description, amount, payment_method, payer_payee, related_reference,
                                 recorded_by_name, recorded_by)
  VALUES (v_factory, v_number, v_date, v_type, v_category, v_description, v_amount, v_method,
          v_payer_payee, v_reference, v_recorded_by, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'transaction_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_cash_transaction(jsonb) TO authenticated;

-- ---------- production ----------
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
  IF NOT public.has_permission(v_uid, 'production', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  v_delta numeric;
  v_stock_before numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'production', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.update_production(jsonb) TO authenticated;

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
  IF NOT public.has_permission(v_uid, 'production', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.delete_production(uuid) TO authenticated;

-- ---------- production-requests ----------
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
  IF NOT public.has_permission(v_uid, 'production-requests', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.create_production_request(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.approve_production_request(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_production_request(p_id uuid, p_approver_name text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  IF NOT public.has_permission(v_uid, 'production-requests', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.issue_production_request_materials(jsonb) TO authenticated;

-- ---------- raw-materials ----------
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
  IF NOT public.has_permission(v_uid, 'raw-materials', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  v_purpose text := COALESCE(payload->>'purpose', 'production');
  v_movement_type movement_type;
  v_material raw_materials%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  IF NOT public.has_permission(v_uid, 'raw-materials', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.adjust_raw_material(jsonb) TO authenticated;

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
  IF NOT public.has_permission(v_uid, 'raw-materials', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.transfer_raw_material(jsonb) TO authenticated;

-- ---------- finished-goods ----------
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
  IF NOT public.has_permission(v_uid, 'finished-goods', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  v_dest_before numeric;
  v_from_name text;
  v_to_name text;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
GRANT EXECUTE ON FUNCTION public.transfer_finished_stock(jsonb) TO authenticated;

-- ---------- expenses ----------
CREATE OR REPLACE FUNCTION public.approve_expense(p_id uuid, p_approver_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Expense is already %', v_row.approval_status; END IF;

  UPDATE expenses SET approval_status = 'approved', approved_by = p_approver_name, approved_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_expense(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_expense(p_id uuid, p_approver_name text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Expense is already %', v_row.approval_status; END IF;

  UPDATE expenses SET
    approval_status = 'rejected', approved_by = p_approver_name, approved_at = now(),
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_expense(uuid, text, text) TO authenticated;

-- ---------- account-approvals ----------
-- approve_user was already redefined in the RBAC-foundation migration (fixing the
-- retired 'viewer' fallback); add the permission guard here on top of that version.
CREATE OR REPLACE FUNCTION public.approve_user(target_id uuid, granted_role public.app_role DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
  v_role app_role;
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  v_role := COALESCE(granted_role, v_profile.role_requested);
  IF v_role IS NULL THEN RAISE EXCEPTION 'A role must be selected to approve this account'; END IF;

  UPDATE profiles SET
    status = 'approved',
    approved_by = v_uid,
    approved_at = now(),
    rejected_by = NULL, rejected_reason = NULL, rejected_at = NULL
  WHERE id = target_id;

  INSERT INTO user_roles (user_id, role, factory_id)
  VALUES (target_id, v_role, v_profile.requested_factory_id)
  ON CONFLICT (user_id, role, factory_id) DO NOTHING;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id, 'Account approved', 'Your account has been approved. You can now log in.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'approve_user', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status),
          jsonb_build_object('status', 'approved', 'role', v_role));

  RETURN jsonb_build_object('status', 'approved', 'role', v_role);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_user(uuid, public.app_role) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_user(target_id uuid, reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF reason IS NULL OR trim(reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  UPDATE profiles SET
    status = 'rejected',
    rejected_by = v_uid,
    rejected_reason = reason,
    rejected_at = now()
  WHERE id = target_id;

  DELETE FROM user_roles WHERE user_id = target_id;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id, 'Account registration declined',
          'Your account registration has been declined. Please contact your administrator.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'reject_user', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status),
          jsonb_build_object('status', 'rejected', 'reason', reason));

  RETURN jsonb_build_object('status', 'rejected');
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_user(uuid, text) TO authenticated;

-- set_user_status now also revokes existing user_roles when suspending/disabling an
-- account -- the audit found the account-approval "suspend" action left roles intact,
-- so a suspended user's prior role kept passing every permission check.
CREATE OR REPLACE FUNCTION public.set_user_status(target_id uuid, new_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF new_status NOT IN ('suspended','disabled','approved') THEN
    RAISE EXCEPTION 'Invalid status transition';
  END IF;
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  UPDATE profiles SET status = new_status WHERE id = target_id;

  IF new_status IN ('suspended', 'disabled') THEN
    DELETE FROM user_roles WHERE user_id = target_id;
  END IF;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id,
          CASE new_status
            WHEN 'suspended' THEN 'Account suspended'
            WHEN 'disabled' THEN 'Account disabled'
            ELSE 'Account reinstated'
          END,
          CASE new_status
            WHEN 'suspended' THEN 'Your account has been suspended. Please contact your administrator.'
            WHEN 'disabled' THEN 'Your account has been disabled. Please contact your administrator.'
            ELSE 'Your account is active again. Please ask an administrator to re-assign your role.'
          END);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'set_user_status', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status), jsonb_build_object('status', new_status));

  RETURN jsonb_build_object('status', new_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_user_status(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_user_account(target_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  SELECT v_uid, requested_factory_id, 'delete_user', 'profiles', target_id::text, to_jsonb(p), NULL
  FROM profiles p WHERE p.id = target_id;

  DELETE FROM user_roles WHERE user_id = target_id;
  DELETE FROM profiles WHERE id = target_id;

  RETURN jsonb_build_object('deleted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_user_account(uuid) TO authenticated;
