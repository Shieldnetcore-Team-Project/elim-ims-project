-- ============================================================================
-- 1) Customer advance/credit balance -- a customer who pays ahead of (or over)
--    what they've bought can have that amount applied to a later sale
-- ----------------------------------------------------------------------------
-- New customers.credit_balance: money the customer has with us that hasn't
-- been spent on goods yet. Two ways it grows:
--   - record_customer_advance(): a standalone deposit, no sale involved yet
--     ("customer paid ahead, hoping to come buy goods subsequently").
--   - approve_sale(): if a sale's payments end up exceeding its grand_total
--     (change the register didn't have, or the customer just chose to pay
--     more), the excess becomes credit instead of silently vanishing under
--     the existing GREATEST(...,0) balance clamp.
-- It shrinks via sales.credit_applied: create_sale() lets the maker draw
-- down some of the customer's existing credit toward a new sale (deferred
-- and re-validated at approve_sale() time, same "nothing is real until
-- approved" rule as pending_payments from the sales-approval migration).
--
-- 2) Sales soft-delete with 30-day retention, via the existing generic
--    delete_requests maker-checker flow (20260920090000/20260922220000)
-- ----------------------------------------------------------------------------
-- 'sales' joins the 9 tables already wired into delete_requests, but with
-- one difference: approve_delete() soft-deletes it (sales.deleted_at = now())
-- instead of a hard DELETE, because a sale can carry real side effects
-- (decremented stock, a debt, customer balance) once posted. Both
-- request_delete() and approve_delete() refuse to touch a 'posted' sale at
-- all -- undoing a posted sale's stock/debt/balance effects is a proper
-- reversal feature this migration does not attempt; only a still-pending,
-- rejected, or cancelled sale (which never had those effects applied) can
-- be deleted this way. That keeps "delete" a cleanup tool for mis-entered
-- records, not a silent way to erase a manager-reviewed transaction.
--
-- RLS does the hiding, not the frontend: "sales read"/"sales write" now
-- exclude deleted_at IS NOT NULL for everyone, and a new admin-only "sales
-- read deleted" policy is the only way to see them (the Deleted Sales admin
-- tab). This means none of the ~13 places across the app that already query
-- `sales` need to be touched -- they all inherit the filter for free.
--
-- Retention: there's no pg_cron (or any scheduled-job mechanism) anywhere in
-- this project, so purge_expired_deleted_sales() is a plain admin-gated RPC
-- the Deleted Sales tab calls opportunistically on load, hard-deleting rows
-- past their 30-day grace window. It skips (not fails on) any row a foreign
-- key still points to (e.g. a debt/payment/delivery/sales-return tied to a
-- sale that was posted, then deleted) rather than aborting the whole batch --
-- those stay soft-deleted (hidden, safe) indefinitely as a fallback.
-- ============================================================================

-- ---------- schema ----------
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS credit_balance numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS credit_applied numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_applied >= 0);
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- ---------- create_sale(): accepts apply_credit (drawn down at approval) ----------
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
  v_apply_credit numeric := COALESCE((payload->>'apply_credit')::numeric, 0);
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
  IF v_apply_credit < 0 THEN RAISE EXCEPTION 'Credit applied cannot be negative'; END IF;

  IF v_is_pr THEN
    -- PR is complimentary -- never mix a real split payment or credit draw
    -- into a "no charge" sale.
    v_payments := NULL;
    v_apply_credit := 0;
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

  IF v_apply_credit > 0 THEN
    IF v_customer IS NULL THEN RAISE EXCEPTION 'Applying credit requires a registered customer'; END IF;
    SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_customer;
    IF COALESCE(v_customer_credit, 0) < v_apply_credit THEN
      RAISE EXCEPTION 'Customer only has % in credit', COALESCE(v_customer_credit, 0);
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

-- ---------- approve_sale(): draws down credit_applied, banks any overpayment as new credit ----------
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
  v_excess numeric := 0;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Approval must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  IF v_row.credit_applied > 0 THEN
    SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_row.customer_id FOR UPDATE;
    IF v_customer_credit IS NULL OR v_customer_credit < v_row.credit_applied THEN
      RAISE EXCEPTION 'Customer no longer has enough credit balance (has %, needs %)', COALESCE(v_customer_credit,0), v_row.credit_applied;
    END IF;
  END IF;

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

  -- Anything paid (cash/transfer/etc + credit already applied) beyond the
  -- grand total becomes new credit instead of silently disappearing.
  v_excess := GREATEST((v_row.amount_paid + v_row.credit_applied) - v_row.grand_total, 0);

  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_row.grand_total,
           outstanding_balance = outstanding_balance + v_row.balance,
           total_transactions = total_transactions + 1,
           credit_balance = credit_balance - v_row.credit_applied + v_excess,
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

-- ---------- record_customer_advance(): a standalone deposit ahead of any sale ----------
CREATE OR REPLACE FUNCTION public.record_customer_advance(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_amount numeric := COALESCE((payload->>'amount')::numeric, 0);
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_remarks text := payload->>'remarks';
  v_prefix text;
  v_receipt text;
  v_payment_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'A registered customer is required for an advance payment'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;

  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = v_customer AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Customer not found for this factory';
  END IF;

  SELECT COALESCE(receipt_prefix,'RCP-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'RCP-'; END IF;
  v_receipt := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
  VALUES (v_factory, v_receipt, v_customer, NULL, v_amount, v_method, CURRENT_DATE, v_uid, COALESCE(NULLIF(btrim(v_remarks), ''), 'Advance payment'))
  RETURNING id INTO v_payment_id;

  UPDATE customers SET credit_balance = credit_balance + v_amount, updated_at = now() WHERE id = v_customer;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'record_customer_advance', 'customers', v_customer::text,
          NULL, jsonb_build_object('amount', v_amount, 'payment_method', v_method));

  RETURN jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt, 'amount', v_amount);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_customer_advance(jsonb) TO authenticated;

-- ---------- RLS: hide soft-deleted sales from everyone except super_admin ----------
-- Explicit ::module_key/::action_key casts: bare literals are ambiguous
-- between the legacy and current has_permission() overloads (see
-- 20260816108000/109000_fix_has_permission_*.sql).
DROP POLICY IF EXISTS "sales read" ON public.sales;
CREATE POLICY "sales read" ON public.sales FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales'::module_key, 'read'::action_key) AND deleted_at IS NULL);

DROP POLICY IF EXISTS "sales read deleted" ON public.sales;
CREATE POLICY "sales read deleted" ON public.sales FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') AND deleted_at IS NOT NULL);

-- "sales write" is FOR ALL, so (being permissive/OR'd with the policy above)
-- it also grants SELECT visibility -- it needs the same deleted_at filter or
-- any cashier/sales-role holder (who has 'sales':'write') would still see
-- deleted rows through this policy alone. Actual INSERT/UPDATE/DELETE are
-- already blocked at the GRANT level (20260816107000_close_direct_write_
-- gaps.sql), so this only ever mattered for its SELECT side-effect anyway.
DROP POLICY IF EXISTS "sales write" ON public.sales;
CREATE POLICY "sales write" ON public.sales FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'sales'::module_key, 'write'::action_key) AND deleted_at IS NULL)
  WITH CHECK (public.has_permission(auth.uid(), 'sales'::module_key, 'write'::action_key));

-- ---------- delete_requests: add 'sales' ----------
ALTER TABLE public.delete_requests DROP CONSTRAINT IF EXISTS delete_requests_table_name_check;
ALTER TABLE public.delete_requests ADD CONSTRAINT delete_requests_table_name_check CHECK (table_name IN (
  'employees','employee_documents','sales_reps','vehicles','drivers',
  'expenses','cash_transactions','product_units','suppliers','sales'
));

CREATE OR REPLACE FUNCTION public.request_delete(p_table_name text, p_entity_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_factory uuid;
  v_label text;
  v_payload jsonb;
  v_id uuid;
  v_admin_id uuid;
  v_sale_status public.workflow_status;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to request a deletion';
  END IF;

  IF EXISTS (
    SELECT 1 FROM delete_requests
    WHERE table_name = p_table_name AND entity_id = p_entity_id AND review_status = 'pending'
  ) THEN
    RAISE EXCEPTION 'A deletion request for this record is already pending';
  END IF;

  IF p_table_name = 'employees' THEN
    v_module := 'employees'::module_key;
    SELECT factory_id, full_name, jsonb_build_object('photo_url', photo_url)
      INTO v_factory, v_label, v_payload
      FROM employees WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;

  ELSIF p_table_name = 'employee_documents' THEN
    v_module := 'employees'::module_key;
    SELECT factory_id, file_name, jsonb_build_object('file_path', file_path)
      INTO v_factory, v_label, v_payload
      FROM employee_documents WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;

  ELSIF p_table_name = 'sales_reps' THEN
    v_module := 'distribution'::module_key;
    SELECT factory_id, full_name INTO v_factory, v_label
      FROM sales_reps WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;

  ELSIF p_table_name = 'vehicles' THEN
    v_module := 'logistics'::module_key;
    SELECT factory_id, plate_number INTO v_factory, v_label
      FROM vehicles WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;

  ELSIF p_table_name = 'drivers' THEN
    v_module := 'logistics'::module_key;
    SELECT factory_id, full_name INTO v_factory, v_label
      FROM drivers WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Driver not found'; END IF;

  ELSIF p_table_name = 'expenses' THEN
    v_module := 'expenses'::module_key;
    SELECT factory_id, COALESCE(description, 'Expense'), jsonb_build_object('attachment_url', attachment_url)
      INTO v_factory, v_label, v_payload
      FROM expenses WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  ELSIF p_table_name = 'cash_transactions' THEN
    v_module := 'receipts-payments'::module_key;
    SELECT factory_id, COALESCE(description, transaction_number) INTO v_factory, v_label
      FROM cash_transactions WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cash transaction not found'; END IF;

  ELSIF p_table_name = 'product_units' THEN
    v_module := 'finished-goods'::module_key;
    SELECT p.factory_id, pu.packaging_unit || ' (' || pu.base_unit || ')'
      INTO v_factory, v_label
      FROM product_units pu JOIN products p ON p.id = pu.product_id
      WHERE pu.id = p_entity_id FOR UPDATE OF pu;
    IF NOT FOUND THEN RAISE EXCEPTION 'Packaging rule not found'; END IF;

  ELSIF p_table_name = 'suppliers' THEN
    v_module := 'suppliers'::module_key;
    SELECT factory_id, name INTO v_factory, v_label
      FROM suppliers WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found'; END IF;

  ELSIF p_table_name = 'sales' THEN
    v_module := 'sales'::module_key;
    SELECT factory_id, invoice_number, status INTO v_factory, v_label, v_sale_status
      FROM sales WHERE id = p_entity_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
    IF v_sale_status = 'posted' THEN
      RAISE EXCEPTION 'A posted sale already affects stock and the customer balance and can''t be deleted this way';
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported table for delete requests: %', p_table_name;
  END IF;

  IF NOT public.has_permission(v_uid, v_module, 'delete'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  INSERT INTO delete_requests(factory_id, table_name, entity_id, entity_label, module, payload, reason, requested_by)
  VALUES (v_factory, p_table_name, p_entity_id, v_label, v_module, v_payload, p_reason, v_uid)
  RETURNING id INTO v_id;

  FOR v_admin_id IN SELECT user_id FROM user_roles WHERE role = 'super_admin' LOOP
    INSERT INTO notifications(user_id, factory_id, title, body)
    VALUES (v_admin_id, v_factory, 'Deletion requested',
            initcap(replace(p_table_name, '_', ' ')) || ' "' || v_label || '" — reason: ' || p_reason);
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'request_delete', p_table_name, p_entity_id::text,
          NULL, jsonb_build_object('reason', p_reason, 'label', v_label));

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_delete(text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_delete(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req delete_requests%ROWTYPE;
BEGIN
  IF NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Only an admin can approve a deletion request';
  END IF;

  SELECT * INTO v_req FROM delete_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;

  IF v_req.table_name = 'employees' THEN
    DELETE FROM employees WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'employee_documents' THEN
    DELETE FROM employee_documents WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'sales_reps' THEN
    DELETE FROM sales_reps WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'vehicles' THEN
    DELETE FROM vehicles WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'drivers' THEN
    DELETE FROM drivers WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'expenses' THEN
    DELETE FROM expenses WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'cash_transactions' THEN
    DELETE FROM cash_transactions WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'product_units' THEN
    DELETE FROM product_units WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'suppliers' THEN
    DELETE FROM suppliers WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'sales' THEN
    IF EXISTS (SELECT 1 FROM sales WHERE id = v_req.entity_id AND status = 'posted') THEN
      RAISE EXCEPTION 'This sale was posted after the deletion was requested — reject this request instead';
    END IF;
    -- Soft delete, not a hard DELETE: kept for 30 days (see
    -- purge_expired_deleted_sales()) and visible to admins on the Deleted
    -- Sales tab, in case it needs to be restored.
    UPDATE sales SET deleted_at = now() WHERE id = v_req.entity_id;
  ELSE
    RAISE EXCEPTION 'Unsupported table for delete requests: %', v_req.table_name;
  END IF;

  UPDATE delete_requests SET review_status = 'approved', reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;

  INSERT INTO notifications(user_id, factory_id, title, body)
  VALUES (v_req.requested_by, v_req.factory_id, 'Deletion approved',
          initcap(replace(v_req.table_name, '_', ' ')) || ' "' || v_req.entity_label || '" was deleted.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'approve_delete', v_req.table_name, v_req.entity_id::text,
          jsonb_build_object('label', v_req.entity_label, 'reason', v_req.reason, 'requested_by', v_req.requested_by),
          jsonb_build_object('deleted', true));

  RETURN jsonb_build_object('approved', true, 'payload', v_req.payload);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_delete(uuid) TO authenticated;

-- ---------- restore_sale() / purge_expired_deleted_sales(): the Deleted Sales admin tab ----------
CREATE OR REPLACE FUNCTION public.restore_sale(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Only an admin can restore a deleted sale';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sales WHERE id = p_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'This sale is not deleted';
  END IF;

  UPDATE sales SET deleted_at = NULL WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  SELECT v_uid, factory_id, 'restore_sale', 'sales', p_id::text,
         jsonb_build_object('deleted', true), jsonb_build_object('deleted', false)
  FROM sales WHERE id = p_id;

  RETURN jsonb_build_object('restored', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.restore_sale(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.purge_expired_deleted_sales()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row RECORD;
  v_purged int := 0;
  v_skipped int := 0;
BEGIN
  IF NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Only an admin can purge deleted sales';
  END IF;

  FOR v_row IN
    SELECT id FROM sales
    WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'
  LOOP
    BEGIN
      DELETE FROM sales WHERE id = v_row.id;
      v_purged := v_purged + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      -- Something else (a debt/payment/delivery/return) still references
      -- this sale -- leave it soft-deleted rather than aborting the batch.
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('purged', v_purged, 'skipped', v_skipped);
END;
$$;
GRANT EXECUTE ON FUNCTION public.purge_expired_deleted_sales() TO authenticated;
