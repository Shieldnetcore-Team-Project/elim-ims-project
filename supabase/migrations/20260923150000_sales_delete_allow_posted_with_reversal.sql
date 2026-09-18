-- ============================================================================
-- Sales deletion: now allowed on ANY sale, including posted ones — with a
-- real reversal, not a block
-- ----------------------------------------------------------------------------
-- 20260923130000_sales_customer_credit_and_soft_delete.sql deliberately
-- refused to let a 'posted' sale be deleted this way, since it already
-- carries real stock/debt/customer-balance effects that a plain soft-delete
-- wouldn't undo. In practice the whole point of "delete a wrongly entered
-- transaction" is usually a sale that already went through — so this
-- migration replaces that block with an actual reversal, run once, at
-- approve_delete() time (same "nothing happens until an admin approves"
-- principle as everywhere else in this app):
--
--   - Every sale_items line's quantity is added back to stock (products.
--     current_stock, or rep_stock if it was a rep sale), with a matching
--     'returned' / 'reversal' movement row for the audit trail.
--   - Whatever was ever actually collected for this sale — every
--     payments_received row with this sale_id, which naturally includes any
--     later installments paid via record_payment against its debt, not just
--     what was paid at the register — plus any of the customer's credit
--     balance that was applied to it, is refunded back to
--     customers.credit_balance. Nothing is handed back out of a physical
--     till; this just makes that value available to the customer again,
--     same as any other credit.
--   - The debt row (if the sale had a balance) is deleted, and
--     total_purchases/outstanding_balance/total_transactions are unwound by
--     the sale's original grand_total and the debt's current (possibly
--     partially paid down) outstanding amount.
--   - The sale itself is then soft-deleted exactly as before (30-day
--     retention, restorable from the Deleted Sales admin tab).
--
-- request_delete() no longer refuses a 'posted' sale either — the earlier
-- "can't delete a posted sale" exception is gone; any status can now be
-- requested, an admin still has to approve it either way.
-- ============================================================================

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
    SELECT factory_id, invoice_number INTO v_factory, v_label
      FROM sales WHERE id = p_entity_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

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
  v_sale sales%ROWTYPE;
  v_item RECORD;
  v_before numeric;
  v_debt debts%ROWTYPE;
  v_found_debt boolean;
  v_total_collected numeric;
  v_refund numeric;
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
    SELECT * INTO v_sale FROM sales WHERE id = v_req.entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

    IF v_sale.status = 'posted' THEN
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

      SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale.id FOR UPDATE;
      v_found_debt := FOUND;
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
$$;
GRANT EXECUTE ON FUNCTION public.approve_delete(uuid) TO authenticated;
