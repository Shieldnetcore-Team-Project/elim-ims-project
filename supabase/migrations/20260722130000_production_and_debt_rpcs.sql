
-- Staff need to see colleague display names for "received by" / "supervisor" / assigned-to
-- displays across Payments, Debts, Production, etc. Profiles only hold name/email/phone.
CREATE POLICY "read team profiles" ON public.profiles FOR SELECT TO authenticated USING (true);

-- ============ PRODUCTION ============
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
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
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
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
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
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;

  UPDATE products SET current_stock = current_stock - v_row.quantity_produced, updated_at = now() WHERE id = v_row.product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
  VALUES (v_row.factory_id, v_row.product_id, 'adjusted', -v_row.quantity_produced, v_row.production_number, 'Production deleted', v_uid);

  DELETE FROM production WHERE id = p_id;

  RETURN jsonb_build_object('deleted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_production(uuid) TO authenticated;

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
  v_product products%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT * INTO v_product FROM products WHERE id = v_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'Adjustment must be non-zero'; END IF;

  UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id)
  VALUES (v_product.factory_id, v_product_id, 'adjusted', v_delta, NULL, COALESCE(v_reason, 'Manual adjustment'), v_uid);

  RETURN jsonb_build_object('adjusted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_finished_stock(jsonb) TO authenticated;

-- ============ DEBTS: CLOSE / WRITE OFF ============
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
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
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

-- Fix record_payment: it never resolved a debt from a bare sale_id (so payments made
-- against an invoice from the Payments Received screen silently didn't touch the debt),
-- and it never kept sales.balance/amount_paid in sync with payments at all.
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
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;

  -- Resolve a debt from the sale when the caller only gave us an invoice.
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
