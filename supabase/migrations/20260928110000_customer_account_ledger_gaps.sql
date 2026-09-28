-- ============================================================================
-- Customer account ledger: closing the gaps against the advance-payment spec
-- ----------------------------------------------------------------------------
-- 20260924110000_customer_account_ledger.sql already implements the spec
-- (ledger, receive-money allocation, auto-applied advance on approval,
-- compensating reversals, maker-checker adjustments, summary view,
-- reconciliation). An audit against it found four gaps, fixed here:
--
--   1. approve_delete (sale void) locked stock rows before the customer row,
--      the reverse of the lock order every other path uses
--      (sale -> customer -> debts -> stock). Two transactions touching the
--      same customer and product in opposite orders can deadlock. The
--      customer is now locked straight after the sale.
--   2. restore_sale could bring back a sale that was approved before it was
--      deleted. The delete had already returned its stock, removed its debt
--      and refunded it to the customer's advance, so the restored sale would
--      show as posted with none of that behind it. Such sales can no longer
--      be restored; they have to be recorded again.
--   3. A repeated idempotency key on record_customer_advance / record_payment
--      returned only the payment id and receipt. It now replays the original
--      result (amount, settled_debt, credit_added, allocations), rebuilt from
--      the ledger rows that call wrote, and refuses a key already used for a
--      different customer.
--   4. (Client side, same change) the Record Payment screens now send an
--      idempotency key, so a double-click can't record a payment twice.
-- ============================================================================

-- ============ 1. Replay of an idempotent call ============
-- Keys written by one call: the key itself plus key:N / key:LN suffixes (one
-- per debt settled and per payment line; see _customer_receive_money and
-- record_payment). Matched by prefix with left() rather than LIKE so a key
-- containing % or _ can't match anything else.
CREATE OR REPLACE FUNCTION public._customer_payment_replay(p_customer uuid, p_idem text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_first uuid;
  v_res jsonb;
BEGIN
  SELECT payment_id INTO v_first
    FROM customer_account_transactions
   WHERE customer_id = p_customer
     AND (idempotency_key = p_idem OR left(idempotency_key, length(p_idem) + 1) = p_idem || ':')
   ORDER BY seq LIMIT 1;
  IF v_first IS NULL THEN RETURN NULL; END IF;

  WITH m AS (
    SELECT * FROM customer_account_transactions
     WHERE customer_id = p_customer
       AND (idempotency_key = p_idem OR left(idempotency_key, length(p_idem) + 1) = p_idem || ':')
  ), p AS (
    SELECT * FROM payments_received WHERE id IN (SELECT payment_id FROM m)
  )
  SELECT jsonb_build_object(
    'duplicate', true,
    'payment_id', v_first,
    'receipt_number', (SELECT receipt_number FROM payments_received WHERE id = v_first),
    'amount', (SELECT COALESCE(SUM(amount), 0) FROM p),
    'total_amount', (SELECT COALESCE(SUM(amount), 0) FROM p),
    'settled_debt', (SELECT COALESCE(SUM(cash_paid), 0) FROM m WHERE txn_type = 'DEBT_SETTLEMENT'),
    'credit_added', (SELECT COALESCE(SUM(credit_delta), 0) FROM m WHERE txn_type IN ('ADVANCE_PAYMENT','CUSTOMER_PAYMENT')),
    'allocations', COALESCE((SELECT jsonb_agg(jsonb_build_object('debt_id', debt_id, 'sale_id', sale_id, 'amount', cash_paid) ORDER BY seq)
                               FROM m WHERE txn_type = 'DEBT_SETTLEMENT'), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('payment_id', id, 'receipt_number', receipt_number,
                                                              'amount', amount, 'payment_method', payment_method) ORDER BY receipt_number)
                            FROM p), '[]'::jsonb)
  ) INTO v_res;
  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public._customer_payment_replay(uuid, text) FROM PUBLIC, anon, authenticated;

-- ============ 2. record_customer_advance: full replay on a repeated key ============
CREATE OR REPLACE FUNCTION public.record_customer_advance(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_amount numeric := COALESCE((payload->>'amount')::numeric, 0);
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_remarks text := NULLIF(btrim(COALESCE(payload->>'remarks','')), '');
  v_reference text := NULLIF(btrim(COALESCE(payload->>'reference','')), '');
  v_idem text := NULLIF(btrim(COALESCE(payload->>'idempotency_key','')), '');
  v_receipt text;
  v_payment_id uuid;
  v_existing uuid;
  v_res jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'A registered customer is required for an advance payment'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;

  -- Serialises everything for this customer, including a double-submit.
  PERFORM 1 FROM customers WHERE id = v_customer AND factory_id = v_factory FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this factory'; END IF;

  IF v_idem IS NOT NULL THEN
    SELECT payment_id INTO v_existing FROM customer_account_transactions WHERE idempotency_key = v_idem;
    IF FOUND THEN
      v_res := public._customer_payment_replay(v_customer, v_idem);
      IF v_res IS NULL THEN RAISE EXCEPTION 'This idempotency key was already used for a different customer'; END IF;
      RETURN v_res;
    END IF;
  END IF;

  v_receipt := public._next_receipt_number(v_factory);
  INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
  VALUES (v_factory, v_receipt, v_customer, NULL, v_amount, v_method, CURRENT_DATE, v_uid,
          COALESCE(v_remarks, 'Advance payment') || CASE WHEN v_reference IS NOT NULL THEN ' (Ref: ' || v_reference || ')' ELSE '' END)
  RETURNING id INTO v_payment_id;

  v_res := public._customer_receive_money(v_factory, v_customer, v_amount, v_method, CURRENT_DATE, v_uid,
                                          v_remarks, v_payment_id, v_receipt, NULL, 'advance', v_idem);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'record_customer_advance', 'customers', v_customer::text, NULL,
          jsonb_build_object('amount', v_amount, 'payment_method', v_method, 'receipt_number', v_receipt,
                             'settled_debt', v_res->'settled_debt', 'credit_added', v_res->'credit_added'));

  RETURN jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt, 'amount', v_amount,
                            'settled_debt', v_res->'settled_debt', 'credit_added', v_res->'credit_added',
                            'allocations', v_res->'allocations');
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_customer_advance(jsonb) TO authenticated;

-- ============ 3. record_payment: full replay on a repeated key ============
CREATE OR REPLACE FUNCTION public.record_payment(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_debt_id uuid := NULLIF(payload->>'debt_id','')::uuid;
  v_sale_id uuid := NULLIF(payload->>'sale_id','')::uuid;
  v_date date := COALESCE((payload->>'payment_date')::date, CURRENT_DATE);
  v_remarks text := payload->>'remarks';
  v_idem text := NULLIF(btrim(COALESCE(payload->>'idempotency_key','')), '');
  v_multi boolean := COALESCE(CASE WHEN jsonb_typeof(payload->'payments') = 'array' THEN jsonb_array_length(payload->'payments') > 0 END, false);
  v_lines jsonb;
  v_line jsonb;
  v_i int := 0;
  v_amount numeric;
  v_method payment_method;
  v_total numeric := 0;
  v_settled numeric := 0;
  v_credit numeric := 0;
  v_receipt text;
  v_payment_id uuid;
  v_first_payment uuid;
  v_first_receipt text;
  v_debt debts%ROWTYPE;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_existing uuid;
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
  IF v_debt_id IS NOT NULL THEN
    SELECT * INTO v_debt FROM debts WHERE id = v_debt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'debt not found'; END IF;
    IF v_sale_id IS NULL THEN v_sale_id := v_debt.sale_id; END IF;
    IF v_customer IS NULL THEN v_customer := v_debt.customer_id; END IF;
  END IF;

  IF v_multi THEN
    v_lines := payload->'payments';
  ELSE
    v_lines := jsonb_build_array(jsonb_build_object(
      'amount', COALESCE((payload->>'amount')::numeric, 0),
      'method', COALESCE(payload->>'payment_method', 'cash')));
  END IF;

  -- A debt with no customer on it (named walk-in): nothing to ledger and no
  -- account to hold credit, so only that one debt can be paid down.
  IF v_customer IS NULL THEN
    IF v_debt_id IS NULL THEN RAISE EXCEPTION 'A customer or debt is required'; END IF;
    SELECT * INTO v_debt FROM debts WHERE id = v_debt_id FOR UPDATE;
    FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
      v_amount := COALESCE((v_line->>'amount')::numeric, 0);
      v_method := COALESCE((v_line->>'method')::payment_method, 'cash');
      IF v_amount <= 0 THEN CONTINUE; END IF;
      IF v_amount > v_debt.outstanding THEN RAISE EXCEPTION 'Payment exceeds the amount owed on this debt'; END IF;
      v_receipt := public._next_receipt_number(v_factory);
      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_factory, v_receipt, NULL, v_sale_id, v_amount, v_method, v_date, v_uid, v_remarks)
      RETURNING id INTO v_payment_id;
      INSERT INTO debt_payments(debt_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_debt_id, v_amount, v_method, v_date, v_uid, v_remarks);
      UPDATE debts SET amount_paid = amount_paid + v_amount, outstanding = outstanding - v_amount,
             status = CASE WHEN outstanding - v_amount = 0 THEN 'paid'::debt_status ELSE 'partial'::debt_status END,
             updated_at = now()
       WHERE id = v_debt_id
       RETURNING * INTO v_debt;
      IF v_sale_id IS NOT NULL THEN
        UPDATE sales SET amount_paid = amount_paid + v_amount, balance = GREATEST(balance - v_amount, 0) WHERE id = v_sale_id;
      END IF;
      v_total := v_total + v_amount;
      v_first_payment := COALESCE(v_first_payment, v_payment_id);
      v_first_receipt := COALESCE(v_first_receipt, v_receipt);
      v_results := v_results || jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt, 'amount', v_amount, 'payment_method', v_method);
    END LOOP;
    IF v_total <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;
    IF v_multi THEN RETURN jsonb_build_object('payments', v_results, 'total_amount', v_total); END IF;
    RETURN jsonb_build_object('payment_id', v_first_payment, 'receipt_number', v_first_receipt);
  END IF;

  PERFORM 1 FROM customers WHERE id = v_customer AND factory_id = v_factory FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this factory'; END IF;

  IF v_idem IS NOT NULL THEN
    SELECT payment_id INTO v_existing FROM customer_account_transactions WHERE idempotency_key = v_idem;
    IF FOUND THEN
      v_res := public._customer_payment_replay(v_customer, v_idem);
      IF v_res IS NULL THEN RAISE EXCEPTION 'This idempotency key was already used for a different customer'; END IF;
      RETURN v_res;
    END IF;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_amount := COALESCE((v_line->>'amount')::numeric, 0);
    v_method := COALESCE((v_line->>'method')::payment_method, 'cash');
    IF v_amount <= 0 THEN CONTINUE; END IF;
    v_i := v_i + 1;

    v_receipt := public._next_receipt_number(v_factory);
    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount, v_method, v_date, v_uid, v_remarks)
    RETURNING id INTO v_payment_id;

    v_res := public._customer_receive_money(v_factory, v_customer, v_amount, v_method, v_date, v_uid,
                                            v_remarks, v_payment_id, v_receipt, v_debt_id, 'payment',
                                            CASE WHEN v_idem IS NULL THEN NULL WHEN v_i = 1 THEN v_idem ELSE v_idem || ':L' || v_i END);

    v_total := v_total + v_amount;
    v_settled := v_settled + (v_res->>'settled_debt')::numeric;
    v_credit := v_credit + (v_res->>'credit_added')::numeric;
    v_first_payment := COALESCE(v_first_payment, v_payment_id);
    v_first_receipt := COALESCE(v_first_receipt, v_receipt);
    v_results := v_results || jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt,
                                                 'amount', v_amount, 'payment_method', v_method);
  END LOOP;
  IF v_total <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'record_payment', 'customers', v_customer::text, NULL,
          jsonb_build_object('total', v_total, 'settled_debt', v_settled, 'credit_added', v_credit, 'receipt_number', v_first_receipt));

  IF v_multi THEN
    RETURN jsonb_build_object('payments', v_results, 'total_amount', v_total, 'settled_debt', v_settled, 'credit_added', v_credit);
  END IF;
  RETURN jsonb_build_object('payment_id', v_first_payment, 'receipt_number', v_first_receipt,
                            'settled_debt', v_settled, 'credit_added', v_credit);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_payment(jsonb) TO authenticated;

-- ============ 4. approve_delete: lock the customer before any stock ============
CREATE OR REPLACE FUNCTION public.approve_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_req delete_requests%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_item RECORD;
  v_before numeric;
  v_debt debts%ROWTYPE;
  v_found_debt boolean;
  v_total_collected numeric;
  v_refund numeric;
  v_orig uuid;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
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
    SELECT * INTO v_sale FROM sales WHERE id = v_req.entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

    IF v_sale.status = 'posted' THEN
      -- Lock order: sale (above) -> customer -> debts -> stock, the same as
      -- approve_sale and the payment paths.
      IF v_sale.customer_id IS NOT NULL THEN
        PERFORM 1 FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
      END IF;
      SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale.id FOR UPDATE;
      v_found_debt := FOUND;

      -- Undo the stock effect applied at approve_sale() time.
      FOR v_item IN SELECT product_id, quantity FROM sale_items WHERE sale_id = v_sale.id LOOP
        IF v_sale.sales_rep_id IS NOT NULL THEN
          UPDATE rep_stock SET quantity = quantity + v_item.quantity, updated_at = now()
           WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = v_item.product_id;
          INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id)
          VALUES (v_sale.factory_id, v_sale.sales_rep_id, v_item.product_id, 'reversal', v_item.quantity, v_sale.invoice_number, 'Sale deleted', v_uid);
        ELSE
          SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
          UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
          INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
          VALUES (v_sale.factory_id, v_item.product_id, 'returned', v_item.quantity, v_sale.invoice_number, 'Sale deleted', v_uid, COALESCE(v_before,0), COALESCE(v_before,0) + v_item.quantity);
        END IF;
      END LOOP;

      -- Refund everything ever actually collected for this sale (register
      -- payments + any later installments against its debt) plus whatever
      -- credit balance was applied to it, back to the customer's credit --
      -- nothing is handed back out of a till here, it just becomes
      -- available to them again.
      SELECT COALESCE(SUM(amount), 0) INTO v_total_collected FROM payments_received WHERE sale_id = v_sale.id;
      v_refund := v_total_collected + v_sale.credit_applied;

      IF v_found_debt THEN
        DELETE FROM debts WHERE id = v_debt.id;
      END IF;

      IF v_sale.customer_id IS NOT NULL THEN
        UPDATE customers SET
          total_purchases = GREATEST(total_purchases - v_sale.grand_total, 0),
          outstanding_balance = GREATEST(outstanding_balance - COALESCE(v_debt.outstanding, 0), 0),
          total_transactions = GREATEST(total_transactions - 1, 0),
          credit_balance = credit_balance + v_refund,
          updated_at = now()
        WHERE id = v_sale.customer_id;

        -- Ledger: compensating entries only; the original SALE / ADVANCE_APPLIED
        -- rows are never edited.
        SELECT id INTO v_orig FROM customer_account_transactions
         WHERE txn_type = 'SALE' AND reference_type = 'sale' AND reference_id = v_sale.id;

        PERFORM public._customer_ledger_post(
          v_sale.factory_id, v_sale.customer_id, 'REVERSAL', 'sale', v_sale.id, v_sale.id, NULL, v_debt.id,
          v_sale.grand_total, 0, 0, 0, -COALESCE(v_debt.outstanding, 0),
          NULL, 'Reversal of sale ' || v_sale.invoice_number, v_req.reason, v_orig, NULL, v_uid);
        IF v_sale.credit_applied > 0 THEN
          PERFORM public._customer_ledger_post(
            v_sale.factory_id, v_sale.customer_id, 'ADVANCE_RESTORED', 'sale', v_sale.id, v_sale.id, NULL, NULL,
            0, 0, v_sale.credit_applied, v_sale.credit_applied, 0,
            NULL, 'Advance restored from reversed sale ' || v_sale.invoice_number, v_req.reason, NULL, NULL, v_uid);
        END IF;
        IF v_total_collected > 0 THEN
          PERFORM public._customer_ledger_post(
            v_sale.factory_id, v_sale.customer_id, 'REVERSAL', 'sale_payments', v_sale.id, v_sale.id, NULL, NULL,
            0, v_total_collected, 0, v_total_collected, 0,
            NULL, 'Payments on reversed sale ' || v_sale.invoice_number || ' returned to account credit', v_req.reason, NULL, NULL, v_uid);
        END IF;
      END IF;
    END IF;

    -- Soft delete either way: 30-day retention, restorable from the
    -- Deleted Sales admin tab (see 20260923130000_...).
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
$function$;

-- ============ 5. restore_sale: never resurrect a reversed sale ============
CREATE OR REPLACE FUNCTION public.restore_sale(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale sales%ROWTYPE;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only an admin can restore a deleted sale';
  END IF;
  SELECT * INTO v_sale FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_sale.deleted_at IS NULL THEN
    RAISE EXCEPTION 'This sale is not deleted';
  END IF;
  -- approve_delete() fully reverses a posted sale (stock back, debt removed,
  -- payments and advance returned to the customer's credit, compensating
  -- ledger rows). Un-hiding it would show a posted sale with none of that
  -- behind it, so it has to be recorded again as a new sale instead.
  IF v_sale.status = 'posted' THEN
    RAISE EXCEPTION 'Sale % was approved before it was deleted, and the deletion already reversed its stock and the customer''s account. Record it again as a new sale instead of restoring it.', v_sale.invoice_number;
  END IF;

  UPDATE sales SET deleted_at = NULL WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_sale.factory_id, 'restore_sale', 'sales', p_id::text,
          jsonb_build_object('deleted', true), jsonb_build_object('deleted', false));

  RETURN jsonb_build_object('restored', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.restore_sale(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_sale(uuid) TO authenticated;
