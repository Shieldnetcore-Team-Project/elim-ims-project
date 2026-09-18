-- ============================================================================
-- Split payments: let a single sale (or a single balance payment) be paid
-- across more than one method in one submission — e.g. part cash, part
-- transfer — instead of forcing the whole amount onto one payment_method.
-- ----------------------------------------------------------------------------
-- payments_received already supports many rows per sale (record_payment has
-- always been callable repeatedly for installments); this just lets ONE
-- submission write several of those rows at once, one per method, instead of
-- exactly one. Both RPCs gain an optional `payments: [{amount, method}]`
-- array in the payload. When present, it replaces the single amount/
-- payment_method pair for that call. When absent, both functions fall back
-- to the exact legacy single-payment behaviour byte-for-byte — this matters
-- because record_payment is also called from cash-ledger.debts.tsx and
-- cash-ledger.ledger.tsx, neither of which is being changed to send
-- `payments`, and both still expect the old `{payment_id, receipt_number}`
-- return shape.
--
-- sales.payment_method (a single enum column) still gets one value when
-- split across methods — the method with the largest line amount — purely
-- as a display/filter convenience on the Sales list. It is not the source
-- of truth for a split payment; the itemized payments_received rows (each
-- with its own method and amount, same as any other payment on that sale)
-- are. Adding a 'split' enum value was deliberately avoided: ALTER TYPE ...
-- ADD VALUE can't be used in the same transaction as a function that
-- references it (see 20260816095000_raw_material_movement_types.sql), which
-- would need a second migration just to use it — not worth it for a
-- display-only column.
-- ============================================================================

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
  v_payments jsonb := payload->'payments';
  v_pay_line jsonb;
  v_line_amount numeric;
  v_line_method payment_method;
  v_sales_person text := payload->>'sales_person';
  v_remarks text := payload->>'remarks';
  v_sales_rep uuid := NULLIF(payload->>'sales_rep_id','')::uuid;
  v_is_pr boolean := COALESCE((payload->>'is_pr')::boolean, false);
  v_rep_row public.sales_reps%ROWTYPE;
  v_rep_before numeric;
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
  v_move_reason text;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'no items'; END IF;

  IF v_is_pr THEN
    -- PR is complimentary — never mix a real split payment into a "no
    -- charge" sale.
    v_payments := NULL;
  END IF;

  IF v_payments IS NOT NULL AND jsonb_array_length(v_payments) > 0 THEN
    SELECT COALESCE(SUM((p->>'amount')::numeric), 0) INTO v_amount_paid
      FROM jsonb_array_elements(v_payments) AS p
      WHERE (p->>'amount')::numeric > 0;
    SELECT (p->>'method')::payment_method INTO v_payment_method
      FROM jsonb_array_elements(v_payments) AS p
      WHERE (p->>'amount')::numeric > 0
      ORDER BY (p->>'amount')::numeric DESC
      LIMIT 1;
    v_payment_method := COALESCE(v_payment_method, 'cash');
  END IF;

  IF v_sales_rep IS NOT NULL THEN
    SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_sales_rep;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
    IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;
    IF v_rep_row.status <> 'active' THEN RAISE EXCEPTION 'Sales rep is not active'; END IF;
  END IF;

  -- Resolve a real customer record for a named walk-in (customer_id not
  -- picked from the dropdown) instead of leaving the sale unlinked.
  IF v_customer IS NULL AND v_customer_name IS NOT NULL AND btrim(v_customer_name) <> '' THEN
    IF v_customer_phone IS NOT NULL AND btrim(v_customer_phone) <> '' THEN
      SELECT id INTO v_customer FROM customers
      WHERE factory_id = v_factory AND phone = v_customer_phone
      LIMIT 1;
    END IF;
    IF v_customer IS NULL THEN
      SELECT id INTO v_customer FROM customers
      WHERE factory_id = v_factory AND lower(name) = lower(btrim(v_customer_name))
      LIMIT 1;
    END IF;
    IF v_customer IS NULL THEN
      INSERT INTO customers(factory_id, name, phone, address, registered)
      VALUES (v_factory, btrim(v_customer_name), v_customer_phone, v_customer_address, false)
      RETURNING id INTO v_customer;
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_sales_rep IS NOT NULL THEN
      SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id;
      IF COALESCE(v_rep_before, 0) < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %: rep has %, need %', v_product.name, COALESCE(v_rep_before,0), v_qty;
      END IF;
    ELSE
      IF v_product.current_stock < v_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
      END IF;
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
  END LOOP;

  -- PR: stock still goes out for the real quantities/prices above (so the
  -- invoice keeps a record of what it would have been worth), but nothing
  -- is billed, paid, or owed.
  IF v_is_pr THEN
    v_discount := 0; v_vat := 0; v_amount_paid := 0;
    v_grand := 0; v_balance := 0;
  ELSE
    v_grand := GREATEST(v_subtotal - v_discount + v_vat, 0);
    v_balance := GREATEST(v_grand - v_amount_paid, 0);
  END IF;

  SELECT COALESCE(invoice_prefix,'INV-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'INV-'; END IF;
  v_invoice := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, sales_rep_id, remarks, created_by, is_pr)
  VALUES (v_factory, v_invoice, v_sale_date, v_customer, v_customer_name, v_customer_phone, v_customer_address,
          v_subtotal, v_discount, v_vat, v_grand, v_amount_paid, v_balance, v_payment_method, v_sales_person, v_sales_rep, v_remarks, v_uid, v_is_pr)
  RETURNING id INTO v_sale_id;

  v_move_reason := CASE WHEN v_is_pr THEN 'PR - complimentary, no charge' ELSE 'Sale' END;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);

    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_qty * v_price);

    IF v_sales_rep IS NOT NULL THEN
      SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id FOR UPDATE;
      IF COALESCE(v_rep_before,0) < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %', v_product.name;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_qty, updated_at = now()
       WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_factory, v_sales_rep, v_product.id, 'sold', -v_qty, v_invoice, v_move_reason, v_uid, v_rep_before, v_rep_before - v_qty);
    ELSE
      UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product.id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_factory, v_product.id, 'sold', v_qty, v_invoice, v_move_reason, v_uid, v_product.current_stock, v_product.current_stock - v_qty);
    END IF;
  END LOOP;

  IF v_payments IS NOT NULL AND jsonb_array_length(v_payments) > 0 THEN
    FOR v_pay_line IN SELECT * FROM jsonb_array_elements(v_payments) LOOP
      v_line_amount := (v_pay_line->>'amount')::numeric;
      v_line_method := COALESCE((v_pay_line->>'method')::payment_method, 'cash');
      IF v_line_amount IS NULL OR v_line_amount <= 0 THEN CONTINUE; END IF;

      SELECT COALESCE(receipt_prefix,'RCP-') INTO v_receipt_prefix FROM settings WHERE factory_id = v_factory;
      IF v_receipt_prefix IS NULL THEN v_receipt_prefix := 'RCP-'; END IF;
      v_receipt := v_receipt_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_line_amount, v_line_method, v_sale_date, v_uid, 'Payment at point of sale');
    END LOOP;
  ELSIF v_amount_paid > 0 THEN
    SELECT COALESCE(receipt_prefix,'RCP-') INTO v_receipt_prefix FROM settings WHERE factory_id = v_factory;
    IF v_receipt_prefix IS NULL THEN v_receipt_prefix := 'RCP-'; END IF;
    v_receipt := v_receipt_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount_paid, v_payment_method, v_sale_date, v_uid, 'Payment at point of sale');
  END IF;

  IF v_balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_factory, v_customer, v_sale_id, v_sales_rep, v_grand, v_amount_paid, v_balance,
            CASE WHEN v_amount_paid > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END);
  END IF;

  IF v_customer IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_grand,
           outstanding_balance = outstanding_balance + v_balance,
           total_transactions = total_transactions + 1,
           updated_at = now()
     WHERE id = v_customer;
  END IF;

  RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                            'subtotal', v_subtotal, 'grand_total', v_grand, 'balance', v_balance);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;

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
  v_date date := COALESCE((payload->>'payment_date')::date, CURRENT_DATE);
  v_remarks text := payload->>'remarks';
  v_payments jsonb := payload->'payments';
  v_line jsonb;
  v_line_amount numeric;
  v_line_method payment_method;
  v_amount numeric;
  v_method payment_method;
  v_prefix text;
  v_receipt text;
  v_payment_id uuid;
  v_debt debts%ROWTYPE;
  v_total numeric := 0;
  v_new_paid numeric;
  v_new_out numeric;
  v_status debt_status;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key) OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;

  IF v_debt_id IS NULL AND v_sale_id IS NOT NULL THEN
    SELECT id INTO v_debt_id FROM debts WHERE sale_id = v_sale_id AND status <> 'paid' LIMIT 1;
  END IF;

  SELECT COALESCE(receipt_prefix,'RCP-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'RCP-'; END IF;

  IF v_debt_id IS NOT NULL THEN
    SELECT * INTO v_debt FROM debts WHERE id = v_debt_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'debt not found'; END IF;
    IF v_sale_id IS NULL THEN v_sale_id := v_debt.sale_id; END IF;
  END IF;

  IF v_payments IS NOT NULL AND jsonb_array_length(v_payments) > 0 THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(v_payments) LOOP
      v_line_amount := (v_line->>'amount')::numeric;
      v_line_method := COALESCE((v_line->>'method')::payment_method, 'cash');
      IF v_line_amount IS NULL OR v_line_amount <= 0 THEN CONTINUE; END IF;
      v_total := v_total + v_line_amount;

      v_receipt := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_line_amount, v_line_method, v_date, v_uid, v_remarks)
      RETURNING id INTO v_payment_id;

      IF v_debt_id IS NOT NULL THEN
        INSERT INTO debt_payments(debt_id, amount, payment_method, payment_date, received_by, remarks)
        VALUES (v_debt_id, v_line_amount, v_line_method, v_date, v_uid, v_remarks);
      END IF;

      v_results := v_results || jsonb_build_object(
        'payment_id', v_payment_id, 'receipt_number', v_receipt,
        'amount', v_line_amount, 'payment_method', v_line_method
      );
    END LOOP;

    IF v_total <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;
  ELSE
    v_amount := COALESCE((payload->>'amount')::numeric, 0);
    v_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
    IF v_amount <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;
    v_total := v_amount;

    v_receipt := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount, v_method, v_date, v_uid, v_remarks)
    RETURNING id INTO v_payment_id;

    IF v_debt_id IS NOT NULL THEN
      INSERT INTO debt_payments(debt_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_debt_id, v_amount, v_method, v_date, v_uid, v_remarks);
    END IF;
  END IF;

  IF v_debt_id IS NOT NULL THEN
    v_new_paid := v_debt.amount_paid + v_total;
    v_new_out := GREATEST(v_debt.total_amount - v_new_paid, 0);
    v_status := CASE WHEN v_new_out = 0 THEN 'paid'::debt_status
                     WHEN v_new_paid > 0 THEN 'partial'::debt_status
                     ELSE 'unpaid'::debt_status END;
    UPDATE debts SET amount_paid = v_new_paid, outstanding = v_new_out, status = v_status, updated_at = now()
     WHERE id = v_debt_id;

    IF v_debt.customer_id IS NOT NULL THEN
      UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_total, 0), updated_at = now()
       WHERE id = v_debt.customer_id;
    END IF;
  ELSIF v_customer IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_total, 0), updated_at = now()
     WHERE id = v_customer;
  END IF;

  IF v_sale_id IS NOT NULL THEN
    UPDATE sales SET amount_paid = amount_paid + v_total, balance = GREATEST(balance - v_total, 0)
     WHERE id = v_sale_id;
  END IF;

  IF v_payments IS NOT NULL AND jsonb_array_length(v_payments) > 0 THEN
    RETURN jsonb_build_object('payments', v_results, 'total_amount', v_total);
  ELSE
    RETURN jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt);
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_payment(jsonb) TO authenticated;
