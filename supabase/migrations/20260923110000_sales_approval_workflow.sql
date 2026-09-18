-- ============================================================================
-- Sales maker-checker: every sale now goes through manager review before it
-- affects stock, debts, or customer balances
-- ----------------------------------------------------------------------------
-- Same shape as production's Store confirmation (see
-- 20260816101000/20260816102000_production_store_confirmation_*.sql):
-- create_sale() becomes the "submit" step only -- it validates and records
-- what was sold, but no longer touches products.current_stock,
-- inventory_movements, rep_stock, payments_received, debts, or
-- customers.total_purchases/outstanding_balance/total_transactions. A new
-- approve_sale() does all of that atomically once a manager (anyone other
-- than whoever recorded the sale, mirroring confirm_production_batch's
-- self-check) approves it -- combining "approve" and "post" into one action,
-- since workflow_transitions already allows pending_approval -> posted
-- directly (no separate intermediate "approved" status needed, unlike
-- expenses' two-step approve-then-post).
--
-- Because nothing is applied until approval, reject_sale()/cancel_sale()
-- have nothing to unwind -- a rejected/cancelled sale simply never affected
-- inventory or the customer's account. The one exception is the payment(s)
-- entered at the register: those are captured as `sales.pending_payments`
-- (the same `[{amount, method}]` shape the split-payments create_sale
-- payload already accepted) and only turned into real payments_received
-- rows inside approve_sale -- so a rejected sale never leaves an orphaned
-- payment record. (Cash physically collected at the register that later
-- gets rejected is a till/reconciliation matter for whoever handles that,
-- same as it would be for any other reversed transaction -- this migration
-- doesn't invent a customer "credit/advance" concept, since none exists
-- anywhere else in this schema either.)
--
-- record_payment() also gets a guard: a customer's outstanding_balance only
-- reflects a sale's balance once that sale is posted, so paying down a
-- still-pending sale's balance directly would corrupt that figure (there's
-- no debt row yet to attribute the payment to). The frontend already only
-- offers "Receive" on posted sales; this is the server-side backstop.
-- ============================================================================

-- ---------- schema ----------
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS status public.workflow_status;
UPDATE public.sales SET status = 'posted' WHERE status IS NULL;
ALTER TABLE public.sales ALTER COLUMN status SET DEFAULT 'pending_approval';
ALTER TABLE public.sales ALTER COLUMN status SET NOT NULL;

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS rejected_reason text;
-- The payment lines declared at the register, applied by approve_sale() --
-- see header comment. NULL/empty for a sale with nothing paid up front.
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS pending_payments jsonb;

-- ---------- register the module with the generic workflow engine ----------
INSERT INTO public.workflow_configs (module, transaction_type, maker_label, checker_label, final_status, required_approvals, description)
VALUES ('sales', 'sale_approval', 'Cashier / Sales', 'Chairman', 'posted', 1,
        'Sale recorded at the register, reviewed by a manager before stock is decremented and it counts toward the customer''s balance.')
ON CONFLICT (module) DO NOTHING;

-- ---------- permissions: chairman is the checker; cashier/sales already
-- hold 'sales':'cancel' from the old (pre-split) sales-returns seed, which
-- doubles as exactly what a maker needs to cancel their own pending sale ----------
INSERT INTO public.role_permissions (role, module, action)
VALUES
  ('chairman', 'sales', 'approve'),
  ('chairman', 'sales', 'reject')
ON CONFLICT (role, module, action) DO NOTHING;

-- ---------- create_sale(): now the submit step only ----------
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
    -- PR is complimentary -- never mix a real split payment into a "no
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
    v_balance := GREATEST(v_grand - v_amount_paid, 0);
  END IF;

  SELECT COALESCE(invoice_prefix,'INV-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'INV-'; END IF;
  v_invoice := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, sales_rep_id,
                    remarks, created_by, is_pr, status, pending_payments)
  VALUES (v_factory, v_invoice, v_sale_date, v_customer, v_customer_name, v_customer_phone, v_customer_address,
          v_subtotal, v_discount, v_vat, v_grand, v_amount_paid, v_balance, v_payment_method, v_sales_person, v_sales_rep,
          v_remarks, v_uid, v_is_pr, 'pending_approval', v_payments)
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

-- ---------- approve_sale(): the manager's review -- posts everything at once ----------
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
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Approval must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

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

  IF v_row.balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_row.factory_id, v_row.customer_id, p_id, v_row.sales_rep_id, v_row.grand_total, v_row.amount_paid, v_row.balance,
            CASE WHEN v_row.amount_paid > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END);
  END IF;

  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_row.grand_total,
           outstanding_balance = outstanding_balance + v_row.balance,
           total_transactions = total_transactions + 1,
           updated_at = now()
     WHERE id = v_row.customer_id;
  END IF;

  UPDATE sales SET status = 'posted', approved_by = v_uid, approved_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'approve', v_row.status, 'posted', p_comment);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_sale', 'sales', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted'));

  RETURN jsonb_build_object('sale_id', p_id, 'status', 'posted');
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_sale(uuid, text) TO authenticated;

-- ---------- reject_sale(): nothing to unwind -- nothing was ever applied ----------
CREATE OR REPLACE FUNCTION public.reject_sale(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Rejection must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE sales SET status = 'rejected', rejected_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'reject', v_row.status, 'rejected', p_reason);

  RETURN jsonb_build_object('sale_id', p_id, 'status', 'rejected');
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_sale(uuid, text) TO authenticated;

-- ---------- cancel_sale(): the maker pulling back their own still-pending sale ----------
CREATE OR REPLACE FUNCTION public.cancel_sale(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE sales SET status = 'cancelled' WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'cancel', v_row.status, 'cancelled', p_reason);

  RETURN jsonb_build_object('sale_id', p_id, 'status', 'cancelled');
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid, text) TO authenticated;

-- ---------- record_payment(): refuse to pay down a still-pending sale ----------
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

  IF v_sale_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM sales WHERE id = v_sale_id AND status = 'posted') THEN
      RAISE EXCEPTION 'Cannot record a payment against a sale that has not been approved yet';
    END IF;
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
