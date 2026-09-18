-- ============================================================================
-- Advance/credit is now applied automatically to every new sale — not just
-- when a cashier remembers to set it manually
-- ----------------------------------------------------------------------------
-- create_sale()/approve_sale() previously only drew down a customer's
-- credit_balance when the payload explicitly carried an `apply_credit`
-- amount (the "Apply credit balance" field in PosDialog). If nobody set
-- that field, a customer sitting on a real advance balance would still get
-- a fresh debt for their next purchase instead of it being covered by
-- money they'd already paid in — exactly the gap that produced the
-- ₦252,390 debt in the customer-ledger screenshot despite the same
-- customer holding ₦397,300 of unused credit from an earlier overpaid sale.
--
-- Both functions now compute how much credit to apply themselves:
--   credit_to_apply = MIN(available credit balance, grand_total - cash paid)
-- with no payload input needed at all. create_sale() does this once for an
-- accurate preview/balance at submission time; approve_sale() recomputes it
-- fresh (available credit may have moved since submission — spent by
-- another sale, or grown from a fresh advance) and is the authoritative
-- figure that actually gets deducted, same "nothing is final until a
-- manager approves it" rule as everything else here. Only whatever's left
-- after cash + all available credit becomes a debt.
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
  v_apply_credit numeric := 0;
  v_customer_credit numeric;
  v_sales_person text := payload->>'sales_person';
  v_remarks text := payload->>'remarks';
  v_sales_rep uuid := NULLIF(payload->>'sales_rep_id','')::uuid;
  v_is_pr boolean := COALESCE((payload->>'is_pr')::boolean, false);
  v_rep_row public.sales_reps%ROWTYPE;
  v_rep_stock numeric;
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
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'no items'; END IF;

  IF v_is_pr THEN
    -- PR is complimentary -- never mix a real split payment or credit draw
    -- into a "no charge" sale.
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

  -- Validate only -- nothing here mutates stock. The actual decrement
  -- happens in approve_sale(), once a manager has reviewed the sale, so
  -- availability is re-checked (and row-locked) again at that point too.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_sales_rep IS NOT NULL THEN
      SELECT quantity INTO v_rep_stock FROM rep_stock WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id;
      IF COALESCE(v_rep_stock, 0) < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %: rep has %, need %', v_product.name, COALESCE(v_rep_stock,0), v_qty;
      END IF;
    ELSE
      IF v_product.current_stock < v_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
      END IF;
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
  END LOOP;

  -- PR: nothing is billed, paid, or owed -- the free-giveaway stock effect
  -- itself still waits for approve_sale() like any other line item.
  IF v_is_pr THEN
    v_discount := 0; v_vat := 0; v_amount_paid := 0;
    v_grand := 0; v_balance := 0;
  ELSE
    v_grand := GREATEST(v_subtotal - v_discount + v_vat, 0);
    -- Auto-preview how much of the customer's own advance/credit would
    -- cover the rest, same formula approve_sale() finalizes with -- so the
    -- balance shown here (and on the printed invoice) is already accurate,
    -- not something that changes surprisingly once a manager approves it.
    IF v_customer IS NOT NULL THEN
      SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_customer;
      v_apply_credit := LEAST(GREATEST(v_grand - v_amount_paid, 0), COALESCE(v_customer_credit, 0));
    END IF;
    v_balance := GREATEST(v_grand - v_amount_paid - v_apply_credit, 0);
  END IF;

  SELECT COALESCE(invoice_prefix,'INV-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'INV-'; END IF;
  v_invoice := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, sales_rep_id,
                    remarks, created_by, is_pr, status, pending_payments, credit_applied)
  VALUES (v_factory, v_invoice, v_sale_date, v_customer, v_customer_name, v_customer_phone, v_customer_address,
          v_subtotal, v_discount, v_vat, v_grand, v_amount_paid, v_balance, v_payment_method, v_sales_person, v_sales_rep,
          v_remarks, v_uid, v_is_pr, 'pending_approval', v_payments, v_apply_credit)
  RETURNING id INTO v_sale_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);

    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_qty * v_price);
  END LOOP;

  PERFORM public.record_workflow_action('sales', v_sale_id, 'submit', NULL, 'pending_approval', v_remarks);

  RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                            'subtotal', v_subtotal, 'grand_total', v_grand, 'balance', v_balance,
                            'status', 'pending_approval');
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_sale(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
  v_item RECORD;
  v_receipt_prefix text;
  v_receipt text;
  v_pay_line jsonb;
  v_line_amount numeric;
  v_line_method payment_method;
  v_move_reason text;
  v_before numeric;
  v_customer_credit numeric;
  v_credit_to_apply numeric := 0;
  v_final_balance numeric;
  v_excess numeric := 0;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Approval must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  -- The authoritative credit draw-down: however much the customer has
  -- available right now, automatically applied to whatever cash didn't
  -- cover -- not limited to (or by) whatever was estimated at submission.
  -- Locks the customer row so a concurrent sale for the same customer
  -- can't double-spend the same credit.
  IF v_row.customer_id IS NOT NULL AND NOT v_row.is_pr THEN
    SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_row.customer_id FOR UPDATE;
    v_customer_credit := COALESCE(v_customer_credit, 0);
    v_credit_to_apply := LEAST(GREATEST(v_row.grand_total - v_row.amount_paid, 0), v_customer_credit);
  END IF;
  v_final_balance := GREATEST(v_row.grand_total - v_row.amount_paid - v_credit_to_apply, 0);

  v_move_reason := CASE WHEN v_row.is_pr THEN 'PR - complimentary, no charge' ELSE 'Sale' END;

  -- Re-validate and apply stock now, at approval time -- availability may
  -- have moved since the sale was submitted.
  FOR v_item IN SELECT si.product_id, si.quantity FROM sale_items si WHERE si.sale_id = p_id LOOP
    IF v_row.sales_rep_id IS NOT NULL THEN
      SELECT quantity INTO v_before FROM rep_stock WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      IF COALESCE(v_before,0) < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient van stock for a line on this sale (product %)', v_item.product_id;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
       WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_row.sales_rep_id, v_item.product_id, 'sold', -v_item.quantity, v_row.invoice_number, v_move_reason, v_uid, v_before, v_before - v_item.quantity);
    ELSE
      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      IF v_before IS NULL OR v_before < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for a line on this sale (product %): have %, need %', v_item.product_id, COALESCE(v_before,0), v_item.quantity;
      END IF;
      UPDATE products SET current_stock = current_stock - v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_item.product_id, 'sold', v_item.quantity, v_row.invoice_number, v_move_reason, v_uid, v_before, v_before - v_item.quantity);
    END IF;
  END LOOP;

  IF v_row.pending_payments IS NOT NULL AND jsonb_array_length(v_row.pending_payments) > 0 THEN
    FOR v_pay_line IN SELECT * FROM jsonb_array_elements(v_row.pending_payments) LOOP
      v_line_amount := (v_pay_line->>'amount')::numeric;
      v_line_method := COALESCE((v_pay_line->>'method')::payment_method, 'cash');
      IF v_line_amount IS NULL OR v_line_amount <= 0 THEN CONTINUE; END IF;

      SELECT COALESCE(receipt_prefix,'RCP-') INTO v_receipt_prefix FROM settings WHERE factory_id = v_row.factory_id;
      IF v_receipt_prefix IS NULL THEN v_receipt_prefix := 'RCP-'; END IF;
      v_receipt := v_receipt_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_row.factory_id, v_receipt, v_row.customer_id, p_id, v_line_amount, v_line_method, v_row.sale_date, v_uid, 'Payment at point of sale');
    END LOOP;
  END IF;

  IF v_final_balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_row.factory_id, v_row.customer_id, p_id, v_row.sales_rep_id, v_row.grand_total, v_row.amount_paid, v_final_balance,
            CASE WHEN v_row.amount_paid > 0 OR v_credit_to_apply > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END);
  END IF;

  -- Cash alone paying more than the grand total (credit draw-down is
  -- already capped so it can never itself cause this) becomes new credit
  -- instead of silently disappearing.
  v_excess := GREATEST(v_row.amount_paid - v_row.grand_total, 0);

  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_row.grand_total,
           outstanding_balance = outstanding_balance + v_final_balance,
           total_transactions = total_transactions + 1,
           credit_balance = credit_balance - v_credit_to_apply + v_excess,
           updated_at = now()
     WHERE id = v_row.customer_id;
  END IF;

  UPDATE sales SET
    status = 'posted', approved_by = v_uid, approved_at = now(),
    credit_applied = v_credit_to_apply, balance = v_final_balance
  WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'approve', v_row.status, 'posted', p_comment);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_sale', 'sales', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'credit_applied', v_credit_to_apply, 'balance', v_final_balance));

  RETURN jsonb_build_object('sale_id', p_id, 'status', 'posted', 'credit_applied', v_credit_to_apply, 'balance', v_final_balance);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_sale(uuid, text) TO authenticated;
