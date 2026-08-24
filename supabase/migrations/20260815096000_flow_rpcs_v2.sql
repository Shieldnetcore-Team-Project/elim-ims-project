-- ============================================================================
-- FLOW RPCs v2 — action-based guards + workflow status engine
-- ----------------------------------------------------------------------------
-- Every status-changing RPC below:
--   1. Checks has_permission(uid, module, <specific action>) — not a ranked
--      'write'/'approve' tier.
--   2. Calls assert_valid_transition(old_status, new_status) — no RPC decides
--      for itself whether a jump is legal; the workflow_transitions table is
--      the single source of truth.
--   3. Blocks the original submitter from approve/reject/post/reverse
--      (checker-only actions). CANCEL is intentionally NOT self-blocked —
--      withdrawing your own not-yet-posted submission is normal, not a
--      control bypass.
--   4. Applies the real-world effect (stock/balance/role change) at POST
--      time, not at APPROVE time — approval is pure review, posting is what
--      commits the transaction. REVERSE undoes exactly what POST applied.
--   5. Writes its own audit_logs row.
-- super_admin bypasses has_permission() entirely (existing has_role check)
-- and is exempt from the self-block, per the deliberate solo-admin bypass.
-- ============================================================================

ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS writeoff_amount numeric(14,2);

-- ============================================================================
-- 1. EXPENSES
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_expense(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'approved');

  UPDATE expenses SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'approved'));
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_expense(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_expense(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'reject') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE expenses SET status = 'rejected', approval_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(),
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> '' THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'rejected', 'reason', p_reason));
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_expense(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_expense(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid(); v_name text;
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'post') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot post an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  SELECT COALESCE(full_name, email, 'Unknown') INTO v_name FROM profiles WHERE id = v_uid;
  UPDATE expenses SET status = 'posted', approval_status = 'approved', approved_by = v_name, approved_at = now(),
    reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'post_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted'));
  RETURN jsonb_build_object('posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.post_expense(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_expense(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'cancel') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE expenses SET status = 'cancelled' WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'cancel_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'cancelled', 'reason', p_reason));
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_expense(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_expense(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted expense'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  UPDATE expenses SET status = 'reversed' WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reverse_expense(uuid, text) TO authenticated;

-- ============================================================================
-- 2. DEBT WRITE-OFFS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.status = 'paid' THEN RAISE EXCEPTION 'Debt is already closed'; END IF;
  IF v_debt.writeoff_status IN ('pending_approval','approved') THEN RAISE EXCEPTION 'A write-off request is already pending for this debt'; END IF;

  UPDATE debts SET writeoff_status = 'pending_approval', writeoff_requested_by = v_uid, writeoff_requested_at = now(),
    writeoff_reason = p_reason, writeoff_reviewed_by = NULL, writeoff_reviewed_at = NULL, writeoff_reject_reason = NULL
  WHERE id = p_debt_id;
  RETURN jsonb_build_object('requested', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_debt_writeoff(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_debt_writeoff(p_debt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'approved');

  UPDATE debts SET writeoff_status = 'approved', writeoff_reviewed_by = v_uid, writeoff_reviewed_at = now() WHERE id = p_debt_id;
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_debt_writeoff(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'reject') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'rejected');

  UPDATE debts SET writeoff_status = 'rejected', writeoff_reviewed_by = v_uid, writeoff_reviewed_at = now(), writeoff_reject_reason = p_reason
  WHERE id = p_debt_id;
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_debt_writeoff(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_debt_writeoff(p_debt_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_written_off numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'post') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot post a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'posted');

  v_written_off := v_debt.outstanding;
  UPDATE debts SET amount_paid = total_amount, outstanding = 0, status = 'paid', updated_at = now(),
    writeoff_status = 'posted', writeoff_amount = v_written_off
  WHERE id = p_debt_id;
  IF v_debt.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_written_off, 0), updated_at = now() WHERE id = v_debt.customer_id;
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'post_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('outstanding', v_debt.outstanding, 'status', v_debt.status),
          jsonb_build_object('outstanding', 0, 'status', 'paid', 'written_off', v_written_off));
  RETURN jsonb_build_object('closed', true, 'written_off', v_written_off);
END; $$;
GRANT EXECUTE ON FUNCTION public.post_debt_writeoff(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'cancel') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'cancelled');

  UPDATE debts SET writeoff_status = 'cancelled' WHERE id = p_debt_id;
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_debt_writeoff(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_debt_writeoff(p_debt_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a write-off'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'reversed');
  IF v_debt.writeoff_amount IS NULL THEN RAISE EXCEPTION 'No recorded write-off amount to reverse'; END IF;

  UPDATE debts SET
    amount_paid = GREATEST(amount_paid - v_debt.writeoff_amount, 0),
    outstanding = outstanding + v_debt.writeoff_amount,
    status = CASE WHEN amount_paid - v_debt.writeoff_amount <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
    updated_at = now(), writeoff_status = 'reversed'
  WHERE id = p_debt_id;
  IF v_debt.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = outstanding_balance + v_debt.writeoff_amount, updated_at = now() WHERE id = v_debt.customer_id;
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'reverse_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('status', 'paid', 'outstanding', 0),
          jsonb_build_object('status', 'reversed', 'restored', v_debt.writeoff_amount, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true, 'restored', v_debt.writeoff_amount);
END; $$;
GRANT EXECUTE ON FUNCTION public.reverse_debt_writeoff(uuid, text) TO authenticated;

-- close_debt shim, still points at the request step for zero-downtime compat.
CREATE OR REPLACE FUNCTION public.close_debt(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.request_debt_writeoff(p_debt_id, p_reason);
END; $$;
GRANT EXECUTE ON FUNCTION public.close_debt(uuid, text) TO authenticated;

-- ============================================================================
-- 3. PAYMENTS (confirm/reject/reverse — money already moved at record time)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.confirm_payment(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payments_received%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payments', 'confirm') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot confirm a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'confirmed');

  UPDATE payments_received SET status = 'confirmed', review_status = 'approved', reviewed_by = v_uid, reviewed_at = now(), review_note = p_note
  WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'confirmed'));
  RETURN jsonb_build_object('confirmed', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_payment(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payments_received%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payments', 'reject') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to flag/reject a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE payments_received SET status = 'rejected', review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason
  WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'rejected', 'reason', p_reason));
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_payment(uuid, text) TO authenticated;

-- Backward-compat shim for the old name.
CREATE OR REPLACE FUNCTION public.flag_payment(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN RETURN public.reject_payment(p_id, p_reason); END; $$;
GRANT EXECUTE ON FUNCTION public.flag_payment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_payment(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row payments_received%ROWTYPE; v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payments', 'reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  IF v_row.sale_id IS NOT NULL THEN
    SELECT * INTO v_debt FROM debts WHERE sale_id = v_row.sale_id FOR UPDATE;
    IF FOUND THEN
      UPDATE debts SET
        amount_paid = GREATEST(amount_paid - v_row.amount, 0),
        outstanding = LEAST(outstanding + v_row.amount, total_amount),
        status = CASE WHEN amount_paid - v_row.amount <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
        updated_at = now()
      WHERE id = v_debt.id;
    END IF;
    UPDATE sales SET amount_paid = GREATEST(amount_paid - v_row.amount, 0), balance = balance + v_row.amount WHERE id = v_row.sale_id;
  END IF;
  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = outstanding_balance + v_row.amount, updated_at = now()
    WHERE id = v_row.customer_id;
  END IF;

  UPDATE payments_received SET status = 'reversed', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status, 'amount', v_row.amount),
          jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reverse_payment(uuid, text) TO authenticated;

-- ============================================================================
-- 4. PAYROLL
-- ============================================================================
CREATE OR REPLACE FUNCTION public.process_payroll(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_employee_id uuid := (payload->>'employee_id')::uuid;
  v_month int := (payload->>'period_month')::int;
  v_year int := (payload->>'period_year')::int;
  v_overtime numeric := COALESCE((payload->>'overtime')::numeric, 0);
  v_paye numeric := COALESCE((payload->>'paye')::numeric, 0);
  v_pension numeric := COALESCE((payload->>'pension')::numeric, 0);
  v_loans numeric := COALESCE((payload->>'loans')::numeric, 0);
  v_advance numeric := COALESCE((payload->>'advance')::numeric, 0);
  v_other_deductions numeric := COALESCE((payload->>'other_deductions')::numeric, 0);
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'transfer');
  v_emp employees%ROWTYPE; v_gross numeric; v_net numeric; v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_month IS NULL OR v_month < 1 OR v_month > 12 THEN RAISE EXCEPTION 'period_month must be 1-12'; END IF;
  IF v_year IS NULL THEN RAISE EXCEPTION 'period_year required'; END IF;

  SELECT * INTO v_emp FROM employees WHERE id = v_employee_id AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found in this factory'; END IF;

  v_gross := v_emp.basic_salary + COALESCE(v_emp.housing_allowance,0) + COALESCE(v_emp.transport_allowance,0)
           + COALESCE(v_emp.meal_allowance,0) + COALESCE(v_emp.medical_allowance,0) + COALESCE(v_emp.other_allowances,0) + v_overtime;
  v_net := v_gross - v_paye - v_pension - v_loans - v_advance - v_other_deductions;

  INSERT INTO payroll(
    factory_id, employee_id, period_month, period_year,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    overtime, gross_salary, paye, pension, loans, advance, other_deductions, net_salary,
    payment_method, status, bank_name, account_number, submitted_by, submitted_at
  ) VALUES (
    v_factory, v_employee_id, v_month, v_year,
    v_emp.basic_salary, v_emp.housing_allowance, v_emp.transport_allowance, v_emp.meal_allowance, v_emp.medical_allowance, v_emp.other_allowances,
    v_overtime, v_gross, v_paye, v_pension, v_loans, v_advance, v_other_deductions, v_net,
    v_method, 'pending_approval', v_emp.bank_name, v_emp.account_number, v_uid, now()
  ) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'gross_salary', v_gross, 'net_salary', v_net);
END; $$;
GRANT EXECUTE ON FUNCTION public.process_payroll(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_payroll(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'approved');

  UPDATE payroll SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_payroll(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_payroll(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'reject') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE payroll SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_payroll(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_payroll(p_id uuid, p_payment_date date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'post') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot post a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  UPDATE payroll SET status = 'posted', payment_date = p_payment_date, reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'post_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'net_salary', v_row.net_salary));
  RETURN jsonb_build_object('posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.post_payroll(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_payroll(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'cancel') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE payroll SET status = 'cancelled' WHERE id = p_id;
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_payroll(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_payroll(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted payroll run'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  UPDATE payroll SET status = 'reversed' WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reverse_payroll(uuid, text) TO authenticated;

-- ============================================================================
-- 5. STOCK WRITE-OFFS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_stock_adjustment(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_entity_type text := payload->>'entity_type';
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_movement_type text := COALESCE(payload->>'movement_type', 'adjusted');
  v_reason text := payload->>'reason';
  v_factory uuid; v_id uuid;
BEGIN
  IF v_entity_type NOT IN ('raw_material','finished_good') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_delta IS NULL OR v_delta >= 0 THEN RAISE EXCEPTION 'quantity_delta must be negative for a write-off request'; END IF;

  IF v_entity_type = 'raw_material' THEN
    IF NOT public.has_permission(v_uid, 'raw-materials', 'submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id INTO v_factory FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  ELSE
    IF NOT public.has_permission(v_uid, 'finished-goods', 'submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id INTO v_factory FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  END IF;

  INSERT INTO stock_adjustment_requests(factory_id, entity_type, material_id, product_id, quantity_delta, movement_type, reason, submitted_by, status)
  VALUES (v_factory, v_entity_type, v_material_id, v_product_id, v_delta, v_movement_type, v_reason, v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_stock_adjustment(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_stock_adjustment(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'approved');

  UPDATE stock_adjustment_requests SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_stock_adjustment(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_stock_adjustment(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'reject') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'rejected');

  UPDATE stock_adjustment_requests SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_stock_adjustment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_stock_adjustment(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_unit_cost numeric;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'post') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot post a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'posted');

  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, unit_cost INTO v_before, v_unit_cost FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    UPDATE raw_materials SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_unit_cost, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  ELSE
    SELECT current_stock INTO v_before FROM products WHERE id = v_req.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, v_req.movement_type::movement_type, v_req.quantity_delta, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  END IF;

  UPDATE stock_adjustment_requests SET status = 'posted', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'post_stock_adjustment', v_req.entity_type, COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity_delta));
  RETURN jsonb_build_object('posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.post_stock_adjustment(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_stock_adjustment(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req stock_adjustment_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'cancelled');
  UPDATE stock_adjustment_requests SET status = 'cancelled' WHERE id = p_id;
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_stock_adjustment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_stock_adjustment(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_unit_cost numeric; v_restore numeric;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted write-off'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'reversed');

  v_restore := abs(v_req.quantity_delta);
  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, unit_cost INTO v_before, v_unit_cost FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    UPDATE raw_materials SET current_stock = current_stock + v_restore, updated_at = now() WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, 'adjusted', v_restore, v_unit_cost, 'Reversal of write-off', p_reason, v_uid, v_before, v_before + v_restore);
  ELSE
    SELECT current_stock INTO v_before FROM products WHERE id = v_req.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_restore, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, 'adjusted', v_restore, 'Reversal of write-off', p_reason, v_uid, v_before, v_before + v_restore);
  END IF;

  UPDATE stock_adjustment_requests SET status = 'reversed' WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'reverse_stock_adjustment', v_req.entity_type, COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_restore, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reverse_stock_adjustment(uuid, text) TO authenticated;

-- ============================================================================
-- 6. ROLE GRANTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_role_grant(p_target_user_id uuid, p_role public.app_role, p_factory_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_target_user_id) THEN RAISE EXCEPTION 'Target user not found'; END IF;

  INSERT INTO role_grant_requests(target_user_id, role, factory_id, action, requested_by, status)
  VALUES (p_target_user_id, p_role, p_factory_id, 'grant', v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_role_grant(uuid, public.app_role, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_role_revoke(p_user_id uuid, p_role public.app_role, p_factory_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_user_id AND role = p_role AND factory_id IS NOT DISTINCT FROM p_factory_id) THEN
    RAISE EXCEPTION 'Role assignment not found';
  END IF;

  INSERT INTO role_grant_requests(target_user_id, role, factory_id, action, requested_by, status)
  VALUES (p_user_id, p_role, p_factory_id, 'revoke', v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_role_revoke(uuid, public.app_role, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_role_grant(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'approved');

  UPDATE role_grant_requests SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_request_id;
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_role_grant(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_role_grant(p_request_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'reject') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'rejected');

  UPDATE role_grant_requests SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason WHERE id = p_request_id;
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_role_grant(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_role_grant(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'post') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot post a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'posted');

  IF v_req.action = 'grant' THEN
    INSERT INTO user_roles(user_id, role, factory_id) VALUES (v_req.target_user_id, v_req.role, v_req.factory_id) ON CONFLICT (user_id, role, factory_id) DO NOTHING;
  ELSE
    DELETE FROM user_roles WHERE user_id = v_req.target_user_id AND role = v_req.role AND factory_id IS NOT DISTINCT FROM v_req.factory_id;
  END IF;

  UPDATE role_grant_requests SET status = 'posted', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_request_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'post_role_' || v_req.action, 'user_roles', v_req.target_user_id::text,
          jsonb_build_object('action', v_req.action, 'role', v_req.role, 'requested_by', v_req.requested_by), jsonb_build_object('applied', true));
  RETURN jsonb_build_object('posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.post_role_grant(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_role_grant(p_request_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req role_grant_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'cancelled');
  UPDATE role_grant_requests SET status = 'cancelled' WHERE id = p_request_id;
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_role_grant(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_role_grant(p_request_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted role change'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'reversed');

  -- Undo exactly what post_role_grant applied.
  IF v_req.action = 'grant' THEN
    DELETE FROM user_roles WHERE user_id = v_req.target_user_id AND role = v_req.role AND factory_id IS NOT DISTINCT FROM v_req.factory_id;
  ELSE
    INSERT INTO user_roles(user_id, role, factory_id) VALUES (v_req.target_user_id, v_req.role, v_req.factory_id) ON CONFLICT (user_id, role, factory_id) DO NOTHING;
  END IF;

  UPDATE role_grant_requests SET status = 'reversed' WHERE id = p_request_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'reverse_role_' || v_req.action, 'user_roles', v_req.target_user_id::text,
          jsonb_build_object('action', v_req.action, 'role', v_req.role), jsonb_build_object('reversed', true, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reverse_role_grant(uuid, text) TO authenticated;
