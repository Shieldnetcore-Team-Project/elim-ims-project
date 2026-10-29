-- ============================================================================
-- The Warehouse corrects a posting to a distributor and reposts it
-- ----------------------------------------------------------------------------
-- The user (2026-10-29): the Warehouse must be able to correct and repost
-- what it posted. Postings to marketers already have this
-- (correct_stock_dispatch, 20261027200000). A posting to a distributor is a
-- sale, posted the moment the Warehouse saves it (20261029140000), so until
-- now only an approved deletion could undo it.
--
-- correct_warehouse_posting(p_id, payload) does it in one step, like the
-- marketer correction:
--   1. the old posting is reversed exactly as an approved deletion reverses
--      a posted sale (_reverse_posted_sale, the sales branch of
--      approve_delete, 20260928110000, unchanged): its goods back into
--      Warehouse stock, its debt removed, whatever was paid on it (and any
--      advance it used) returned to the distributor's credit, compensating
--      ledger rows; the sale is soft-deleted;
--   2. a new posting to the same distributor with the corrected lines is made
--      through create_sale and posted at once -- never waiting for approval
--      (stock out, debt, ledger) -- and the distributor's credit, including
--      what they had paid on the old one, is applied to it automatically.
-- Only the difference has to be possible: the old goods go back first, then
-- the corrected ones come out. If anything fails (not enough stock, credit
-- limit) nothing changes.
--
-- Who: whoever can post (sales write, as create_sale). Only a posted
-- Warehouse posting to a distributor; a reason is optional. The new posting
-- goes to Accounts to confirm like any other; the old one drops off their
-- list. Audited.
-- payload: { items: [{product_id, quantity, unit_price?}], discount?,
--            sale_date?, reason? }
-- ============================================================================

CREATE OR REPLACE FUNCTION public._reverse_posted_sale(p_sale uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale sales%ROWTYPE;
  v_item RECORD;
  v_before numeric;
  v_debt debts%ROWTYPE;
  v_found_debt boolean;
  v_total_collected numeric;
  v_refund numeric;
  v_orig uuid;
BEGIN
  SELECT * INTO v_sale FROM sales WHERE id = p_sale FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

  IF v_sale.status = 'posted' THEN
    IF v_sale.customer_id IS NOT NULL THEN
      PERFORM 1 FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
    END IF;
    SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale.id FOR UPDATE;
    v_found_debt := FOUND;

    FOR v_item IN SELECT product_id, quantity FROM sale_items WHERE sale_id = v_sale.id LOOP
      IF v_sale.sales_rep_id IS NOT NULL THEN
        UPDATE rep_stock SET quantity = quantity + v_item.quantity, updated_at = now()
         WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = v_item.product_id;
        INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id)
        VALUES (v_sale.factory_id, v_sale.sales_rep_id, v_item.product_id, 'reversal', v_item.quantity, v_sale.invoice_number, p_reason, v_uid);
      ELSE
        SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
        UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
        INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
        VALUES (v_sale.factory_id, v_item.product_id, 'returned', v_item.quantity, v_sale.invoice_number, p_reason, v_uid,
                COALESCE(v_before, 0), COALESCE(v_before, 0) + v_item.quantity);
      END IF;
    END LOOP;

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

      SELECT id INTO v_orig FROM customer_account_transactions
       WHERE txn_type = 'SALE' AND reference_type = 'sale' AND reference_id = v_sale.id;

      PERFORM public._customer_ledger_post(
        v_sale.factory_id, v_sale.customer_id, 'REVERSAL', 'sale', v_sale.id, v_sale.id, NULL, v_debt.id,
        v_sale.grand_total, 0, 0, 0, -COALESCE(v_debt.outstanding, 0),
        NULL, 'Reversal of sale ' || v_sale.invoice_number, p_reason, v_orig, NULL, v_uid);
      IF v_sale.credit_applied > 0 THEN
        PERFORM public._customer_ledger_post(
          v_sale.factory_id, v_sale.customer_id, 'ADVANCE_RESTORED', 'sale', v_sale.id, v_sale.id, NULL, NULL,
          0, 0, v_sale.credit_applied, v_sale.credit_applied, 0,
          NULL, 'Advance restored from reversed sale ' || v_sale.invoice_number, p_reason, NULL, NULL, v_uid);
      END IF;
      IF v_total_collected > 0 THEN
        PERFORM public._customer_ledger_post(
          v_sale.factory_id, v_sale.customer_id, 'REVERSAL', 'sale_payments', v_sale.id, v_sale.id, NULL, NULL,
          0, v_total_collected, 0, v_total_collected, 0,
          NULL, 'Payments on reversed sale ' || v_sale.invoice_number || ' returned to account credit', p_reason, NULL, NULL, v_uid);
      END IF;
    END IF;
  END IF;

  UPDATE sales SET deleted_at = now() WHERE id = p_sale;
END;
$$;
REVOKE ALL ON FUNCTION public._reverse_posted_sale(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.correct_warehouse_posting(p_id uuid, payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old sales%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_items jsonb := payload->'items';
  v_new jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_old FROM sales WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Posting not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_old.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT public.is_warehouse_posting(v_old) THEN
    RAISE EXCEPTION '% isn''t a Warehouse posting to a distributor', v_old.invoice_number;
  END IF;
  IF v_old.status <> 'posted' THEN
    RAISE EXCEPTION '% is %, not posted -- only a posted one is corrected here', v_old.invoice_number,
      replace(v_old.status::text, '_', ' ');
  END IF;
  -- The reason is optional: the Warehouse just changes the lines and reposts.
  v_reason := COALESCE(v_reason, 'figures corrected');
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'Add at least one product line'; END IF;

  PERFORM public._reverse_posted_sale(p_id, 'Corrected: ' || v_reason);

  v_new := public.create_sale(jsonb_build_object(
    'factory_id', v_old.factory_id,
    'sale_date', COALESCE(NULLIF(payload->>'sale_date', ''), v_old.sale_date::text),
    'customer_id', v_old.customer_id,
    'customer_name', v_old.customer_name,
    'customer_phone', v_old.customer_phone,
    'customer_address', v_old.customer_address,
    'discount', COALESCE(NULLIF(payload->>'discount', '')::numeric, v_old.discount),
    'vat', v_old.vat,
    'amount_paid', 0,
    'sales_person', v_old.sales_person,
    'remarks', 'Correction of ' || v_old.invoice_number || ': ' || v_reason,
    'items', v_items));

  -- The corrected posting never waits for approval: posted now even where
  -- create_sale still leaves Warehouse postings pending (20261029140000 not
  -- yet applied), so Warehouse stock follows the correction at once.
  IF v_new->>'status' = 'pending_approval' THEN
    PERFORM public._post_sale((v_new->>'sale_id')::uuid, 'Corrected Warehouse posting - posted at once');
    v_new := v_new || jsonb_build_object('status', 'posted');
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_old.factory_id, 'correct_warehouse_posting', 'sales', p_id::text,
          jsonb_build_object('invoice_number', v_old.invoice_number, 'grand_total', v_old.grand_total,
                             'items', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity,
                                                                          'unit_price', unit_price))
                                         FROM sale_items WHERE sale_id = p_id)),
          jsonb_build_object('reason', v_reason, 'new', v_new));
  RETURN v_new || jsonb_build_object('replaced', v_old.invoice_number);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_warehouse_posting(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_warehouse_posting(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
