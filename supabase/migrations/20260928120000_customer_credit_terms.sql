-- ============================================================================
-- Credit terms: credit limits, due dates, overdue and recovery tracking
-- ----------------------------------------------------------------------------
-- Backs the Warehouse "Credit sales" tab. A debt row is already created for
-- every approved sale that wasn't fully paid (approve_sale); this adds:
--
--   customers.credit_limit  maximum the customer may owe (NULL = no limit)
--   customers.credit_days   payment terms; a new debt falls due this many
--                           days after it is raised (default 30)
--   debts.due_date          set automatically when the debt is created
--   debts.paid_at           the recovery date: stamped when a debt reaches
--                           'paid', cleared again if a reversal reopens it
--
-- Credit terms are set only through set_customer_credit_terms() (customers:
-- approve), never by a direct table write, so whoever can edit a customer's
-- phone number can't also raise their credit limit. approve_sale() refuses a
-- sale that would take the customer over their limit, unless the approver
-- is chairman/super_admin.
--
-- Also fixes a gap in the customers column lockdown: 20260816107000 and
-- 20260923140000 revoked UPDATE on the balance columns at column level, but
-- the original table-level UPDATE grant was never revoked, and Postgres
-- ignores a column-level REVOKE while the table-level grant stands. So the
-- balance columns were still directly writable (and settable on INSERT).
-- Same fix products/raw_materials got in 20260826090000: revoke table-level,
-- re-grant only the master-data columns the Customers page actually writes.
-- ============================================================================

-- ============ 1. Columns ============
ALTER TABLE public.customers
  ADD COLUMN credit_limit numeric(14,2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  ADD COLUMN credit_days integer NOT NULL DEFAULT 30 CHECK (credit_days >= 0 AND credit_days <= 365);

ALTER TABLE public.debts
  ADD COLUMN due_date date,
  ADD COLUMN paid_at timestamptz;

-- Existing debts: due 30 days after they were raised; already-paid ones get
-- their last update as the recovery date (the best record there is).
UPDATE public.debts SET due_date = (created_at AT TIME ZONE 'UTC')::date + 30 WHERE due_date IS NULL;
UPDATE public.debts SET paid_at = updated_at WHERE status = 'paid' AND paid_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_debts_open_due ON public.debts (factory_id, due_date) WHERE status <> 'paid';

-- ============ 2. Customers: column-level write lockdown (see header) ============
REVOKE INSERT, UPDATE ON public.customers FROM authenticated, anon;
GRANT INSERT (factory_id, name, phone, email, address, registered) ON public.customers TO authenticated;
GRANT UPDATE (name, phone, email, address, registered, updated_at) ON public.customers TO authenticated;

-- ============ 3. Debts: due date on creation, recovery date on payment ============
-- A trigger rather than edits to every function that creates or settles a
-- debt (approve_sale, adjustments, payments, reversals, write-offs), so no
-- path can forget it.
CREATE OR REPLACE FUNCTION public._debts_credit_dates()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.due_date IS NULL THEN
    NEW.due_date := (COALESCE(NEW.created_at, now()) AT TIME ZONE 'UTC')::date
                    + COALESCE((SELECT credit_days FROM customers WHERE id = NEW.customer_id), 30);
  END IF;
  IF NEW.status = 'paid' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'paid' OR NEW.paid_at IS NULL THEN
      NEW.paid_at := COALESCE(NEW.paid_at, now());
    END IF;
  ELSE
    NEW.paid_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_debts_credit_dates ON public.debts;
CREATE TRIGGER trg_debts_credit_dates
  BEFORE INSERT OR UPDATE ON public.debts
  FOR EACH ROW EXECUTE FUNCTION public._debts_credit_dates();

-- ============ 4. Setting credit terms ============
CREATE OR REPLACE FUNCTION public.set_customer_credit_terms(
  p_customer uuid, p_credit_limit numeric, p_credit_days integer, p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cust customers%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'customers'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_credit_limit IS NOT NULL AND p_credit_limit < 0 THEN RAISE EXCEPTION 'Credit limit cannot be negative'; END IF;
  IF p_credit_days IS NULL OR p_credit_days < 0 OR p_credit_days > 365 THEN
    RAISE EXCEPTION 'Payment terms must be between 0 and 365 days';
  END IF;

  SELECT * INTO v_cust FROM customers WHERE id = p_customer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;

  UPDATE customers SET credit_limit = round(p_credit_limit, 2), credit_days = p_credit_days, updated_at = now()
   WHERE id = p_customer;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_cust.factory_id, 'set_customer_credit_terms', 'customers', p_customer::text,
          jsonb_build_object('credit_limit', v_cust.credit_limit, 'credit_days', v_cust.credit_days),
          jsonb_build_object('credit_limit', round(p_credit_limit, 2), 'credit_days', p_credit_days, 'reason', p_reason));

  RETURN jsonb_build_object('customer_id', p_customer, 'credit_limit', round(p_credit_limit, 2), 'credit_days', p_credit_days);
END;
$$;
REVOKE ALL ON FUNCTION public.set_customer_credit_terms(uuid, numeric, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_credit_terms(uuid, numeric, integer, text) TO authenticated;

-- ============ 5. approve_sale: enforce the credit limit ============
-- Unchanged from 20260924110000_customer_account_ledger.sql apart from the
-- credit-limit check, placed once the final balance is known and while the
-- customer row is locked (so two sales can't both squeeze under the limit).
CREATE OR REPLACE FUNCTION public.approve_sale(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_credit_limit numeric;
  v_owed numeric;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Approval must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  -- The authoritative credit draw-down: however much the customer has
  -- available right now, automatically applied to whatever cash didn't
  -- cover. Locks the customer row so a concurrent sale for the same
  -- customer can't double-spend the same credit.
  IF v_row.customer_id IS NOT NULL AND NOT v_row.is_pr THEN
    SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_row.customer_id FOR UPDATE;
    v_customer_credit := COALESCE(v_customer_credit, 0);
    v_credit_to_apply := LEAST(GREATEST(v_row.grand_total - v_row.amount_paid, 0), v_customer_credit);
  END IF;
  v_final_balance := GREATEST(v_row.grand_total - v_row.amount_paid - v_credit_to_apply, 0);

  -- Credit limit: the debt this sale would add, on top of what the customer
  -- already owes, may not exceed their limit. Chairman/super_admin can
  -- approve over it (the override is in the audit log via approve_sale).
  IF v_final_balance > 0 AND v_row.customer_id IS NOT NULL THEN
    SELECT credit_limit, outstanding_balance INTO v_credit_limit, v_owed
      FROM customers WHERE id = v_row.customer_id FOR UPDATE;
    IF v_credit_limit IS NOT NULL AND COALESCE(v_owed, 0) + v_final_balance > v_credit_limit
       AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
      RAISE EXCEPTION 'Over credit limit: this sale would leave the customer owing % against a limit of %. Collect more payment or ask an admin to approve.',
        round(COALESCE(v_owed, 0) + v_final_balance, 2), v_credit_limit;
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

      v_receipt := public._next_receipt_number(v_row.factory_id);

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
  -- already capped so it can never itself cause this) becomes new credit.
  v_excess := GREATEST(v_row.amount_paid - v_row.grand_total, 0);

  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_row.grand_total,
           outstanding_balance = outstanding_balance + v_final_balance,
           total_transactions = total_transactions + 1,
           credit_balance = credit_balance - v_credit_to_apply + v_excess,
           updated_at = now()
     WHERE id = v_row.customer_id;

    -- Ledger: what was sold and how it was funded, in the same transaction.
    PERFORM public._customer_ledger_post(
      v_row.factory_id, v_row.customer_id, 'SALE', 'sale', p_id, p_id, NULL, NULL,
      v_row.grand_total, v_row.amount_paid, 0, 0, v_final_balance,
      v_row.payment_method, 'Sale ' || v_row.invoice_number, NULL, NULL, NULL, v_uid);
    IF v_credit_to_apply > 0 THEN
      PERFORM public._customer_ledger_post(
        v_row.factory_id, v_row.customer_id, 'ADVANCE_APPLIED', 'sale', p_id, p_id, NULL, NULL,
        0, 0, v_credit_to_apply, -v_credit_to_apply, 0,
        NULL, 'Advance applied to ' || v_row.invoice_number, NULL, NULL, NULL, v_uid);
    END IF;
    IF v_excess > 0 THEN
      PERFORM public._customer_ledger_post(
        v_row.factory_id, v_row.customer_id, 'ADVANCE_PAYMENT', 'sale', p_id, p_id, NULL, NULL,
        0, 0, 0, v_excess, 0,
        v_row.payment_method, 'Overpayment on ' || v_row.invoice_number || ' held as credit', NULL, NULL, NULL, v_uid);
    END IF;
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
$function$;
