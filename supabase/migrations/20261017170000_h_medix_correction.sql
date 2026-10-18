-- ============================================================================
-- Data correction: H-Medix (requested 17 Oct 2026)
-- ----------------------------------------------------------------------------
-- What the records showed:
--   * Two distributor records for one customer: "H-Medix" (created 15 Oct)
--     and "H MEDIX" (added by the distributor seed the same evening).
--   * The same ₦360,000 part-payment cheque entered on both, 3 minutes apart
--     (RCP20261017-42212 on H-Medix, RCP20261017-52911 on H MEDIX), each held
--     as advance.
--   * The goods H-Medix collected on 15 Oct (12 × 35cl @ ₦2,550 + 200 × 50cl
--     @ ₦2,650 = ₦560,600) were posted as a *marketer* dispatch,
--     DSP-20261015-10916, to the old H-Medix marketer row. So no invoice and
--     no debt was ever raised, and H-Medix showed nothing owed.
--
-- Correction (each step mirrors the system's own function for it, and runs
-- only while the records are still in that state, so it is safe to re-run
-- and does nothing on any other database):
--   1. The dispatch is reversed: the goods come off the old marketer row and
--      back into Warehouse stock (as reverse_stock_dispatch does).
--   2. The same goods are invoiced to H-Medix, dated 15 Oct, at the
--      dispatched prices, and posted (as approve_sale does): stock out of the
--      Warehouse again, so Warehouse stock nets to no change; the ₦360,000
--      cheque already on H-Medix's account is applied; ₦200,600 is left as
--      debt.
--   3. The duplicate cheque on H MEDIX is rejected and the ₦360,000 credit it
--      put on that account is taken off with a reversing ledger entry.
--   4. H MEDIX comes off the distributor list. Its account history is
--      append-only, so it is unregistered and renamed rather than deleted.
-- Posted by this migration, not by a person: user fields are left empty and
-- the audit log records it as a data correction.
--
-- Also: the Distributors "Paid" column counted only cash taken with a sale.
-- Advance applied to an invoice is a payment too, so Paid now includes it
-- (Paid + Outstanding = Invoiced).
-- ============================================================================

-- ============ Distributor accounts: advance applied counts as paid ============
-- Same as 20261017120000 apart from the "paid" column.
CREATE OR REPLACE FUNCTION public.distributor_accounts(p_factory uuid)
RETURNS TABLE(customer_id uuid, name text, phone text, marketer text,
              invoices bigint, invoiced numeric, paid numeric, outstanding numeric,
              advance numeric, last_sale date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distributor-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.phone, sr.full_name,
         COALESCE(t.n, 0), COALESCE(t.invoiced, 0), COALESCE(t.paid, 0), COALESCE(t.outstanding, 0),
         COALESCE(c.credit_balance, 0)::numeric, t.last_sale
    FROM customers c
    LEFT JOIN sales_reps sr ON sr.id = c.sales_rep_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS n,
             SUM(s.grand_total)::numeric AS invoiced,
             SUM(s.amount_paid + COALESCE(s.credit_applied, 0))::numeric AS paid,
             SUM(GREATEST(s.balance, 0))::numeric AS outstanding,
             MAX(s.sale_date)::date AS last_sale
        FROM sales s
       WHERE s.customer_id = c.id AND s.status = 'posted' AND s.deleted_at IS NULL
         AND NOT COALESCE(s.is_pr, false)
    ) t ON true
   WHERE c.factory_id = p_factory AND c.registered
   ORDER BY COALESCE(t.outstanding, 0) DESC, c.name;
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_accounts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_accounts(uuid) TO authenticated;

-- ============ The correction ============
DO $$
DECLARE
  c_reason constant text := 'Data correction 17 Oct 2026: H-Medix is a distributor; goods posted to it as a marketer are invoiced to its customer account';
  v_disp stock_dispatches%ROWTYPE;
  v_keep customers%ROWTYPE;
  v_dup customers%ROWTYPE;
  v_pay payments_received%ROWTYPE;
  v_led customer_account_transactions%ROWTYPE;
  v_item record;
  v_before numeric;
  v_prefix text;
  v_invoice text;
  v_sale uuid;
  v_total numeric;
  v_credit numeric;
  v_apply numeric;
  v_balance numeric;
  v_debt uuid;
BEGIN
  SELECT * INTO v_disp FROM stock_dispatches WHERE dispatch_number = 'DSP-20261015-10916';
  SELECT * INTO v_keep FROM customers
   WHERE factory_id = v_disp.factory_id AND name = 'H-Medix' AND registered;
  IF v_disp.id IS NULL OR v_keep.id IS NULL THEN
    RETURN;  -- not the live database
  END IF;

  -- ---- 1 + 2. Dispatch -> invoice ----
  IF v_disp.status = 'posted' THEN
    SELECT SUM(quantity * unit_price) INTO v_total FROM stock_dispatch_items WHERE dispatch_id = v_disp.id;

    -- 1. Reverse the dispatch (as reverse_stock_dispatch).
    FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = v_disp.id LOOP
      SELECT quantity INTO v_before FROM rep_stock
       WHERE sales_rep_id = v_disp.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      IF COALESCE(v_before, 0) < v_item.quantity THEN
        RAISE EXCEPTION 'H-Medix correction: % no longer holds the dispatched goods', v_disp.dispatch_number;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
       WHERE sales_rep_id = v_disp.sales_rep_id AND product_id = v_item.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_disp.factory_id, v_disp.sales_rep_id, v_item.product_id, 'reversal', -v_item.quantity,
              v_disp.dispatch_number, c_reason, NULL, v_before, v_before - v_item.quantity);

      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_disp.factory_id, v_item.product_id, 'return_from_rep', v_item.quantity, v_disp.dispatch_number,
              'Dispatch reversed: ' || c_reason, NULL, v_before, v_before + v_item.quantity);
    END LOOP;
    UPDATE stock_dispatches SET status = 'reversed', reversed_at = now(), reverse_reason = c_reason WHERE id = v_disp.id;

    -- 2. The invoice (as create_sale + approve_sale).
    SELECT COALESCE(invoice_prefix, 'INV-') INTO v_prefix FROM settings WHERE factory_id = v_disp.factory_id;
    v_invoice := COALESCE(v_prefix, 'INV-') || to_char(v_disp.dispatch_date, 'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

    PERFORM 1 FROM customers WHERE id = v_keep.id FOR UPDATE;
    SELECT credit_balance, outstanding_balance INTO v_credit, v_before FROM customers WHERE id = v_keep.id;
    v_apply := LEAST(v_total, GREATEST(COALESCE(v_credit, 0), 0));
    v_balance := v_total - v_apply;

    INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, subtotal, discount, vat,
                      grand_total, amount_paid, balance, payment_method, remarks, created_by, is_pr, status, credit_applied)
    VALUES (v_disp.factory_id, v_invoice, v_disp.dispatch_date, v_keep.id, v_keep.name, v_total, 0, 0,
            v_total, 0, v_total, 'credit',
            'Goods collected ' || to_char(v_disp.dispatch_date, 'DD Mon YYYY') || ' (' || v_disp.dispatch_number
              || ', first posted to H-Medix as a marketer). Part payment by cheque RCP20261017-42212 applied. ' || c_reason,
            NULL, false, 'pending_approval', 0)
    RETURNING id INTO v_sale;

    FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = v_disp.id LOOP
      INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total)
      VALUES (v_sale, v_item.product_id, v_item.quantity, v_item.unit_price, v_item.quantity * v_item.unit_price);

      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock - v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_disp.factory_id, v_item.product_id, 'sold', v_item.quantity, v_invoice, 'Sale', NULL, v_before, v_before - v_item.quantity);
    END LOOP;

    IF v_balance > 0 THEN
      INSERT INTO debts(factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status)
      VALUES (v_disp.factory_id, v_keep.id, v_sale, v_total, 0, v_balance,
              CASE WHEN v_apply > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END)
      RETURNING id INTO v_debt;
    END IF;

    UPDATE customers
       SET total_purchases = total_purchases + v_total,
           outstanding_balance = outstanding_balance + v_balance,
           total_transactions = total_transactions + 1,
           credit_balance = credit_balance - v_apply,
           updated_at = now()
     WHERE id = v_keep.id;

    PERFORM public._customer_ledger_post(
      v_disp.factory_id, v_keep.id, 'SALE', 'sale', v_sale, v_sale, NULL, NULL,
      v_total, 0, 0, 0, v_balance,
      'credit', 'Sale ' || v_invoice, c_reason, NULL, NULL, NULL);
    IF v_apply > 0 THEN
      PERFORM public._customer_ledger_post(
        v_disp.factory_id, v_keep.id, 'ADVANCE_APPLIED', 'sale', v_sale, v_sale, NULL, NULL,
        0, 0, v_apply, -v_apply, 0,
        NULL, 'Advance applied to ' || v_invoice, 'Cheque RCP20261017-42212', NULL, NULL, NULL);
    END IF;

    UPDATE sales SET status = 'posted', approved_at = now(), credit_applied = v_apply, balance = v_balance
     WHERE id = v_sale;

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (NULL, v_disp.factory_id, 'data_correction', 'sales', v_sale::text,
            jsonb_build_object('dispatch', v_disp.dispatch_number, 'dispatch_status', 'posted'),
            jsonb_build_object('invoice', v_invoice, 'customer', v_keep.name, 'grand_total', v_total,
                               'advance_applied', v_apply, 'outstanding', v_balance, 'reason', c_reason));
  END IF;

  -- ---- 3. The duplicate cheque ----
  SELECT * INTO v_pay FROM payments_received WHERE receipt_number = 'RCP20261017-52911';
  IF v_pay.id IS NOT NULL AND v_pay.amount = 360000 AND v_pay.status NOT IN ('rejected','reversed','cancelled') THEN
    SELECT * INTO v_dup FROM customers WHERE id = v_pay.customer_id FOR UPDATE;
    UPDATE payments_received
       SET status = 'rejected', review_status = 'rejected', reviewed_at = now(),
           review_note = 'Duplicate entry: the same ₦360,000 cheque is recorded on H-Medix as RCP20261017-42212'
     WHERE id = v_pay.id;
    FOR v_led IN
      SELECT * FROM customer_account_transactions
       WHERE payment_id = v_pay.id AND txn_type IN ('CUSTOMER_PAYMENT','ADVANCE_PAYMENT') ORDER BY seq DESC
    LOOP
      UPDATE customers SET credit_balance = GREATEST(credit_balance - v_led.credit_delta, 0), updated_at = now()
       WHERE id = v_dup.id;
      PERFORM public._customer_ledger_post(
        v_pay.factory_id, v_dup.id, 'REVERSAL', 'payment_reversal', v_pay.id, NULL, v_pay.id, NULL,
        0, 0, 0, -v_led.credit_delta, 0,
        v_pay.payment_method, 'Reversal of ' || v_pay.receipt_number || ' (duplicate entry, credit removed)',
        'Duplicate of RCP20261017-42212 on H-Medix', v_led.id, NULL, NULL);
    END LOOP;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (NULL, v_pay.factory_id, 'data_correction', 'payments_received', v_pay.id::text,
            jsonb_build_object('status', v_pay.status, 'customer', v_dup.name),
            jsonb_build_object('status', 'rejected', 'reason', 'Duplicate of RCP20261017-42212 on H-Medix'));
  END IF;

  -- ---- 4. One H-Medix on the distributor list ----
  UPDATE customers
     SET registered = false, name = 'H MEDIX (duplicate of H-Medix - do not use)', updated_at = now()
   WHERE factory_id = v_keep.factory_id AND id <> v_keep.id AND registered
     AND regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = 'hmedix'
     AND COALESCE(credit_balance, 0) = 0 AND COALESCE(outstanding_balance, 0) = 0
     AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = customers.id AND s.deleted_at IS NULL);
END;
$$;
