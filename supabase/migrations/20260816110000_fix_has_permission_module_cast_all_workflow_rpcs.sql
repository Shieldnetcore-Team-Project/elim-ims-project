-- ============================================================================
-- FIX (part 3): every workflow-engine RPC has the same has_permission bug
-- ----------------------------------------------------------------------------
-- 20260816109000_fix_has_permission_module_cast.sql fixed 13 functions found
-- via one grep pattern. Sales (create_sale) was fixed by it; the very next
-- page tried (Production) hit the identical error from create_production --
-- a function that pattern never caught, because its module argument was
-- ALREADY followed by an ::action_key cast (`'production', 'create'::action_key`),
-- which is a different textual shape from the uncast calls fixed in 108000.
--
-- Re-auditing with a pattern that catches ANY bare string literal in the
-- module position (has_permission(v_uid, 'literal', ...) regardless of what
-- follows) found the real scope: almost every dual-control workflow RPC
-- authored earlier today (2026-08-16) -- expenses, debt write-offs,
-- payments, payroll, stock write-offs, role grants, goods receiving,
-- costing, production, production requests -- uses the exact same
-- insufficient pattern (module as bare literal, action cast). Every one of
-- them is a live landmine identical to the Sales/Production ones, just not
-- yet clicked.
--
-- Functions that pass the module through a DECLAREd `v_module
-- public.module_key` variable (approve_stock_adjustment, reject_stock_adjustment,
-- post_stock_adjustment, reverse_stock_adjustment) were re-verified safe and
-- are NOT touched -- confirmed by inspecting each call site directly, not
-- assumed from the presence of a v_module declaration in scope (that
-- shortcut is exactly what caused this gap the first time).
--
-- Fix, same as before: CREATE OR REPLACE with the identical signature,
-- adding ::module_key to the module argument at every has_permission call
-- that still passes it as a bare literal. No signature changes, no CASCADE
-- risk, old has_permission overload still not dropped.
-- ============================================================================

-- ============================================================================
-- EXPENSES
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_expense(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid(); v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve an expense you submitted yourself';
  END IF;

  PERFORM public.record_workflow_action('expenses', p_id, 'approve', v_row.status, v_row.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('expenses', p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_row.status, 'approved');
  UPDATE expenses SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'approved'));
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $$;

CREATE OR REPLACE FUNCTION public.reject_expense(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE expenses SET status = 'rejected', approval_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(),
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> '' THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;
  PERFORM public.record_workflow_action('expenses', p_id, 'reject', v_row.status, 'rejected', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'rejected', 'reason', p_reason));
  RETURN jsonb_build_object('rejected', true);
END; $$;

CREATE OR REPLACE FUNCTION public.post_expense(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid(); v_name text;
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  PERFORM public.record_workflow_action('expenses', p_id, 'post', v_row.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'post_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted'));
  RETURN jsonb_build_object('posted', true);
END; $$;

CREATE OR REPLACE FUNCTION public.cancel_expense(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE expenses SET status = 'cancelled' WHERE id = p_id;
  PERFORM public.record_workflow_action('expenses', p_id, 'cancel', v_row.status, 'cancelled', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'cancel_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'cancelled', 'reason', p_reason));
  RETURN jsonb_build_object('cancelled', true);
END; $$;

CREATE OR REPLACE FUNCTION public.reverse_expense(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted expense'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  UPDATE expenses SET status = 'reversed' WHERE id = p_id;
  PERFORM public.record_workflow_action('expenses', p_id, 'reverse', v_row.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;

-- ============================================================================
-- DEBT WRITE-OFFS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.status = 'paid' THEN RAISE EXCEPTION 'Debt is already closed'; END IF;
  IF v_debt.writeoff_status IN ('pending_approval','approved') THEN RAISE EXCEPTION 'A write-off request is already pending for this debt'; END IF;

  UPDATE debts SET writeoff_status = 'pending_approval', writeoff_requested_by = v_uid, writeoff_requested_at = now(),
    writeoff_reason = p_reason, writeoff_reviewed_by = NULL, writeoff_reviewed_at = NULL, writeoff_reject_reason = NULL
  WHERE id = p_debt_id;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'submit', v_debt.writeoff_status, 'pending_approval', p_reason);
  RETURN jsonb_build_object('requested', true);
END; $$;

CREATE OR REPLACE FUNCTION public.approve_debt_writeoff(p_debt_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a write-off you requested yourself';
  END IF;

  PERFORM public.record_workflow_action('debts', p_debt_id, 'approve', v_debt.writeoff_status, v_debt.writeoff_status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('debts', p_debt_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'approved');
  UPDATE debts SET writeoff_status = 'approved', writeoff_reviewed_by = v_uid, writeoff_reviewed_at = now() WHERE id = p_debt_id;
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $$;

CREATE OR REPLACE FUNCTION public.reject_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'rejected');

  UPDATE debts SET writeoff_status = 'rejected', writeoff_reviewed_by = v_uid, writeoff_reviewed_at = now(), writeoff_reject_reason = p_reason
  WHERE id = p_debt_id;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'reject', v_debt.writeoff_status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $$;

CREATE OR REPLACE FUNCTION public.post_debt_writeoff(p_debt_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_written_off numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  PERFORM public.record_workflow_action('debts', p_debt_id, 'post', v_debt.writeoff_status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'post_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('outstanding', v_debt.outstanding, 'status', v_debt.status),
          jsonb_build_object('outstanding', 0, 'status', 'paid', 'written_off', v_written_off));
  RETURN jsonb_build_object('closed', true, 'written_off', v_written_off);
END; $$;

CREATE OR REPLACE FUNCTION public.cancel_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'cancelled');

  UPDATE debts SET writeoff_status = 'cancelled' WHERE id = p_debt_id;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'cancel', v_debt.writeoff_status, 'cancelled', p_reason);
  RETURN jsonb_build_object('cancelled', true);
END; $$;

CREATE OR REPLACE FUNCTION public.reverse_debt_writeoff(p_debt_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  PERFORM public.record_workflow_action('debts', p_debt_id, 'reverse', v_debt.writeoff_status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'reverse_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('status', 'paid', 'outstanding', 0),
          jsonb_build_object('status', 'reversed', 'restored', v_debt.writeoff_amount, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true, 'restored', v_debt.writeoff_amount);
END; $$;

-- ============================================================================
-- PAYMENTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.confirm_payment(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payments_received%ROWTYPE; v_uid uuid := auth.uid(); v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot confirm a payment you recorded yourself';
  END IF;

  PERFORM public.record_workflow_action('payments', p_id, 'confirm', v_row.status, v_row.status, p_note);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('payments', p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('confirmed', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_row.status, 'confirmed');
  UPDATE payments_received SET status = 'confirmed', review_status = 'approved', reviewed_by = v_uid, reviewed_at = now(), review_note = p_note
  WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'confirmed'));
  RETURN jsonb_build_object('confirmed', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $$;

CREATE OR REPLACE FUNCTION public.reject_payment(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payments_received%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to flag/reject a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE payments_received SET status = 'rejected', review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason
  WHERE id = p_id;
  PERFORM public.record_workflow_action('payments', p_id, 'reject', v_row.status, 'rejected', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'rejected', 'reason', p_reason));
  RETURN jsonb_build_object('rejected', true);
END; $$;

CREATE OR REPLACE FUNCTION public.reverse_payment(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row payments_received%ROWTYPE; v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  PERFORM public.record_workflow_action('payments', p_id, 'reverse', v_row.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status, 'amount', v_row.amount),
          jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;

-- ============================================================================
-- PAYROLL
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
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  PERFORM public.record_workflow_action('payroll', v_id, 'submit', NULL, 'pending_approval', NULL);
  RETURN jsonb_build_object('id', v_id, 'gross_salary', v_gross, 'net_salary', v_net);
END; $$;

CREATE OR REPLACE FUNCTION public.approve_payroll(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid(); v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a payroll run you submitted yourself';
  END IF;

  PERFORM public.record_workflow_action('payroll', p_id, 'approve', v_row.status, v_row.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('payroll', p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_row.status, 'approved');
  UPDATE payroll SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $$;

CREATE OR REPLACE FUNCTION public.reject_payroll(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE payroll SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('payroll', p_id, 'reject', v_row.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $$;

CREATE OR REPLACE FUNCTION public.post_payroll(p_id uuid, p_payment_date date DEFAULT CURRENT_DATE, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot post a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  UPDATE payroll SET status = 'posted', payment_date = p_payment_date, reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('payroll', p_id, 'post', v_row.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'post_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'net_salary', v_row.net_salary));
  RETURN jsonb_build_object('posted', true);
END; $$;

CREATE OR REPLACE FUNCTION public.cancel_payroll(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE payroll SET status = 'cancelled' WHERE id = p_id;
  PERFORM public.record_workflow_action('payroll', p_id, 'cancel', v_row.status, 'cancelled', p_reason);
  RETURN jsonb_build_object('cancelled', true);
END; $$;

CREATE OR REPLACE FUNCTION public.reverse_payroll(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted payroll run'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  UPDATE payroll SET status = 'reversed' WHERE id = p_id;
  PERFORM public.record_workflow_action('payroll', p_id, 'reverse', v_row.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;

-- ============================================================================
-- STOCK WRITE-OFFS (request only -- approve/reject/post/reverse already
-- use a genuine v_module variable and are not affected)
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
  v_factory uuid; v_id uuid; v_module public.module_key;
BEGIN
  IF v_entity_type NOT IN ('raw_material','finished_good') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'quantity_delta must be non-zero'; END IF;
  v_module := CASE v_entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;

  IF v_entity_type = 'raw_material' THEN
    IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id INTO v_factory FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  ELSE
    IF NOT public.has_permission(v_uid, 'finished-goods'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id INTO v_factory FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  END IF;

  INSERT INTO stock_adjustment_requests(factory_id, entity_type, material_id, product_id, quantity_delta, movement_type, reason, submitted_by, status)
  VALUES (v_factory, v_entity_type, v_material_id, v_product_id, v_delta, v_movement_type, v_reason, v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action(v_module, v_id, 'submit', NULL, 'pending_approval', v_reason);
  RETURN jsonb_build_object('id', v_id);
END; $$;

-- ============================================================================
-- ROLE GRANTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_role_grant(p_target_user_id uuid, p_role text, p_factory_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_target_user_id) THEN RAISE EXCEPTION 'Target user not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM roles WHERE slug = p_role) THEN RAISE EXCEPTION 'Unknown role: %', p_role; END IF;

  INSERT INTO role_grant_requests(target_user_id, role, factory_id, action, requested_by, status)
  VALUES (p_target_user_id, p_role, p_factory_id, 'grant', v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action('users', v_id, 'submit', NULL, 'pending_approval', 'Grant: ' || p_role);
  RETURN jsonb_build_object('id', v_id);
END; $$;

CREATE OR REPLACE FUNCTION public.request_role_revoke(p_user_id uuid, p_role text, p_factory_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_user_id AND role = p_role AND factory_id IS NOT DISTINCT FROM p_factory_id) THEN
    RAISE EXCEPTION 'Role assignment not found';
  END IF;

  INSERT INTO role_grant_requests(target_user_id, role, factory_id, action, requested_by, status)
  VALUES (p_user_id, p_role, p_factory_id, 'revoke', v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action('users', v_id, 'submit', NULL, 'pending_approval', 'Revoke: ' || p_role);
  RETURN jsonb_build_object('id', v_id);
END; $$;

CREATE OR REPLACE FUNCTION public.approve_role_grant(p_request_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE; v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a role change you requested yourself';
  END IF;

  PERFORM public.record_workflow_action('users', p_request_id, 'approve', v_req.status, v_req.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('users', p_request_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_req.status, 'approved');
  UPDATE role_grant_requests SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_request_id;
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $$;

CREATE OR REPLACE FUNCTION public.reject_role_grant(p_request_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'rejected');

  UPDATE role_grant_requests SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason WHERE id = p_request_id;
  PERFORM public.record_workflow_action('users', p_request_id, 'reject', v_req.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $$;

CREATE OR REPLACE FUNCTION public.post_role_grant(p_request_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  PERFORM public.record_workflow_action('users', p_request_id, 'post', v_req.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'post_role_' || v_req.action, 'user_roles', v_req.target_user_id::text,
          jsonb_build_object('action', v_req.action, 'role', v_req.role, 'requested_by', v_req.requested_by), jsonb_build_object('applied', true));
  RETURN jsonb_build_object('posted', true);
END; $$;

CREATE OR REPLACE FUNCTION public.reverse_role_grant(p_request_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted role change'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reverse a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'reversed');

  IF v_req.action = 'grant' THEN
    DELETE FROM user_roles WHERE user_id = v_req.target_user_id AND role = v_req.role AND factory_id IS NOT DISTINCT FROM v_req.factory_id;
  ELSE
    INSERT INTO user_roles(user_id, role, factory_id) VALUES (v_req.target_user_id, v_req.role, v_req.factory_id) ON CONFLICT (user_id, role, factory_id) DO NOTHING;
  END IF;

  UPDATE role_grant_requests SET status = 'reversed' WHERE id = p_request_id;
  PERFORM public.record_workflow_action('users', p_request_id, 'reverse', v_req.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'reverse_role_' || v_req.action, 'user_roles', v_req.target_user_id::text,
          jsonb_build_object('action', v_req.action, 'role', v_req.role), jsonb_build_object('reversed', true, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;

-- ============================================================================
-- GOODS RECEIVING
-- ============================================================================
CREATE OR REPLACE FUNCTION public.submit_goods_receipt(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_unit_cost numeric := NULLIF(payload->>'unit_cost','')::numeric;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_purchase_request_id uuid := NULLIF(payload->>'purchase_request_id','')::uuid;
  v_delivery_reference text := payload->>'delivery_reference';
  v_remarks text := payload->>'remarks';
  v_material raw_materials%ROWTYPE;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;

  IF v_purchase_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM production_requests WHERE id = v_purchase_request_id AND factory_id = v_material.factory_id) THEN
      RAISE EXCEPTION 'Purchase request not found for this factory';
    END IF;
  END IF;

  v_number := 'GR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO goods_receipts(factory_id, receipt_number, material_id, quantity, unit, unit_cost, supplier_id,
                              purchase_request_id, delivery_reference, remarks, submitted_by)
  VALUES (v_material.factory_id, v_number, v_material_id, v_qty, v_material.unit, v_unit_cost, v_supplier_id,
          v_purchase_request_id, v_delivery_reference, v_remarks, v_uid)
  RETURNING id INTO v_id;

  PERFORM public.record_workflow_action('goods-receiving', v_id, 'submit', NULL, 'pending_confirmation', v_remarks);
  RETURN jsonb_build_object('id', v_id, 'receipt_number', v_number);
END; $$;

CREATE OR REPLACE FUNCTION public.confirm_goods_receipt(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req goods_receipts%ROWTYPE;
  v_before numeric;
BEGIN
  SELECT * INTO v_req FROM goods_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt not found'; END IF;
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot confirm a goods receipt you submitted yourself — dual control requires a different person';
  END IF;

  PERFORM public.assert_valid_transition(v_req.status, 'confirmed');
  UPDATE goods_receipts SET status = 'confirmed', confirmed_by = v_uid, confirmed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'confirm', v_req.status, 'confirmed', p_comment);

  PERFORM public.assert_valid_transition('confirmed', 'posted');
  SELECT current_stock INTO v_before FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
  UPDATE raw_materials SET
    current_stock = current_stock + v_req.quantity,
    unit_cost = COALESCE(v_req.unit_cost, unit_cost),
    supplier_id = COALESCE(v_req.supplier_id, supplier_id),
    updated_at = now()
  WHERE id = v_req.material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_req.factory_id, v_req.material_id, 'received', v_req.quantity, v_req.unit_cost, v_req.receipt_number,
          COALESCE(v_req.remarks, 'Goods receipt confirmed'), v_uid, v_before, v_before + v_req.quantity);

  UPDATE goods_receipts SET status = 'posted' WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'post', 'confirmed', 'posted', p_comment);

  IF v_req.purchase_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed' WHERE id = v_req.purchase_request_id AND request_type = 'purchase';
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'confirm_goods_receipt', 'goods_receipts', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity));

  RETURN jsonb_build_object('confirmed', true, 'posted', true);
END; $$;

CREATE OR REPLACE FUNCTION public.reject_goods_receipt(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req goods_receipts%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a goods receipt'; END IF;
  SELECT * INTO v_req FROM goods_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt not found'; END IF;
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a goods receipt you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'rejected');

  UPDATE goods_receipts SET status = 'rejected', confirmed_by = v_uid, confirmed_at = now(), reject_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'reject', v_req.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $$;

CREATE OR REPLACE FUNCTION public.cancel_goods_receipt(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req goods_receipts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM goods_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt not found'; END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'cancelled');

  UPDATE goods_receipts SET status = 'cancelled' WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'cancel', v_req.status, 'cancelled', p_reason);
  RETURN jsonb_build_object('cancelled', true);
END; $$;

-- ============================================================================
-- COSTING
-- ============================================================================
CREATE OR REPLACE FUNCTION public.submit_costing_sheet(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_yield numeric := (payload->>'yield_quantity')::numeric;
  v_labor numeric := COALESCE((payload->>'labor_cost')::numeric, 0);
  v_overhead_percent numeric := NULLIF(payload->>'overhead_percent','')::numeric;
  v_overhead numeric;
  v_pack_qty numeric := COALESCE((payload->>'pack_quantity')::numeric, 1);
  v_pack_cost numeric := COALESCE((payload->>'pack_cost')::numeric, 0);
  v_apply boolean := COALESCE((payload->>'apply_to_product')::boolean, false);
  v_notes text := payload->>'notes';
  v_items jsonb := payload->'items';
  v_price_options jsonb := payload->'price_options';
  v_item jsonb;
  v_price jsonb;
  v_material raw_materials%ROWTYPE;
  v_qty numeric;
  v_line numeric;
  v_material_cost numeric := 0;
  v_total numeric;
  v_unit_cost numeric;
  v_cost_per_pack numeric;
  v_proposed numeric;
  v_margin numeric;
  v_number text;
  v_sheet_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_yield IS NULL OR v_yield <= 0 THEN RAISE EXCEPTION 'Yield quantity must be > 0'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one material line is required'; END IF;

  PERFORM 1 FROM products WHERE id = v_product_id AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found for this factory'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material % not found', v_item->>'material_id'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Material quantity must be > 0'; END IF;
    v_line := v_qty * v_material.unit_cost;
    v_material_cost := v_material_cost + v_line;
  END LOOP;

  IF v_overhead_percent IS NOT NULL THEN
    v_overhead := round(v_material_cost * v_overhead_percent / 100, 2);
  ELSE
    v_overhead := COALESCE((payload->>'overhead_cost')::numeric, 0);
  END IF;

  v_total := v_material_cost + v_labor + v_overhead;
  v_unit_cost := v_total / v_yield;
  v_cost_per_pack := v_unit_cost * v_pack_qty + v_pack_cost;

  v_number := 'CST-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO costing_sheets(factory_id, product_id, sheet_number, yield_quantity, labor_cost, overhead_cost,
                              overhead_percent, pack_quantity, pack_cost, cost_per_pack,
                              material_cost, total_cost, unit_cost, apply_to_product, notes, created_by)
  VALUES (v_factory, v_product_id, v_number, v_yield, v_labor, v_overhead,
          v_overhead_percent, v_pack_qty, v_pack_cost, v_cost_per_pack,
          v_material_cost, v_total, v_unit_cost, v_apply, v_notes, v_uid)
  RETURNING id INTO v_sheet_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    INSERT INTO costing_sheet_items(sheet_id, material_id, quantity, unit_cost, line_total)
    VALUES (v_sheet_id, v_material.id, v_qty, v_material.unit_cost, v_qty * v_material.unit_cost);
  END LOOP;

  IF v_price_options IS NOT NULL THEN
    FOR v_price IN SELECT * FROM jsonb_array_elements(v_price_options) LOOP
      v_proposed := (v_price->>'proposed_price')::numeric;
      IF v_proposed IS NOT NULL AND v_proposed >= 0 THEN
        v_margin := v_proposed - v_cost_per_pack;
        INSERT INTO costing_price_options(sheet_id, proposed_price, margin, margin_percent)
        VALUES (v_sheet_id, v_proposed, v_margin,
                CASE WHEN v_proposed > 0 THEN round(v_margin / v_proposed * 100, 2) ELSE 0 END);
      END IF;
    END LOOP;
  END IF;

  PERFORM public.record_workflow_action('costing', v_sheet_id, 'submit', NULL, 'pending_approval', v_notes);
  RETURN jsonb_build_object('id', v_sheet_id, 'sheet_number', v_number, 'unit_cost', v_unit_cost,
                             'total_cost', v_total, 'cost_per_pack', v_cost_per_pack);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_costing_sheet(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := (payload->>'id')::uuid;
  v_yield numeric := (payload->>'yield_quantity')::numeric;
  v_labor numeric := COALESCE((payload->>'labor_cost')::numeric, 0);
  v_overhead_percent numeric := NULLIF(payload->>'overhead_percent','')::numeric;
  v_overhead numeric;
  v_pack_qty numeric := COALESCE((payload->>'pack_quantity')::numeric, 1);
  v_pack_cost numeric := COALESCE((payload->>'pack_cost')::numeric, 0);
  v_apply boolean := COALESCE((payload->>'apply_to_product')::boolean, false);
  v_notes text := payload->>'notes';
  v_items jsonb := payload->'items';
  v_price_options jsonb := payload->'price_options';
  v_item jsonb;
  v_price jsonb;
  v_material raw_materials%ROWTYPE;
  v_qty numeric;
  v_line numeric;
  v_material_cost numeric := 0;
  v_total numeric;
  v_unit_cost numeric;
  v_cost_per_pack numeric;
  v_proposed numeric;
  v_margin numeric;
  v_row costing_sheets%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'edit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM costing_sheets WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF v_row.status <> 'pending_approval' THEN RAISE EXCEPTION 'Cannot edit a costing sheet after it has been reviewed'; END IF;
  IF v_yield IS NULL OR v_yield <= 0 THEN RAISE EXCEPTION 'Yield quantity must be > 0'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one material line is required'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material % not found', v_item->>'material_id'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Material quantity must be > 0'; END IF;
    v_line := v_qty * v_material.unit_cost;
    v_material_cost := v_material_cost + v_line;
  END LOOP;

  IF v_overhead_percent IS NOT NULL THEN
    v_overhead := round(v_material_cost * v_overhead_percent / 100, 2);
  ELSE
    v_overhead := COALESCE((payload->>'overhead_cost')::numeric, 0);
  END IF;

  v_total := v_material_cost + v_labor + v_overhead;
  v_unit_cost := v_total / v_yield;
  v_cost_per_pack := v_unit_cost * v_pack_qty + v_pack_cost;

  UPDATE costing_sheets SET
    yield_quantity = v_yield, labor_cost = v_labor, overhead_cost = v_overhead, overhead_percent = v_overhead_percent,
    pack_quantity = v_pack_qty, pack_cost = v_pack_cost, cost_per_pack = v_cost_per_pack,
    material_cost = v_material_cost, total_cost = v_total, unit_cost = v_unit_cost,
    apply_to_product = v_apply, notes = v_notes
  WHERE id = v_id;

  DELETE FROM costing_sheet_items WHERE sheet_id = v_id;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    INSERT INTO costing_sheet_items(sheet_id, material_id, quantity, unit_cost, line_total)
    VALUES (v_id, v_material.id, v_qty, v_material.unit_cost, v_qty * v_material.unit_cost);
  END LOOP;

  DELETE FROM costing_price_options WHERE sheet_id = v_id;
  IF v_price_options IS NOT NULL THEN
    FOR v_price IN SELECT * FROM jsonb_array_elements(v_price_options) LOOP
      v_proposed := (v_price->>'proposed_price')::numeric;
      IF v_proposed IS NOT NULL AND v_proposed >= 0 THEN
        v_margin := v_proposed - v_cost_per_pack;
        INSERT INTO costing_price_options(sheet_id, proposed_price, margin, margin_percent)
        VALUES (v_id, v_proposed, v_margin,
                CASE WHEN v_proposed > 0 THEN round(v_margin / v_proposed * 100, 2) ELSE 0 END);
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'unit_cost', v_unit_cost, 'cost_per_pack', v_cost_per_pack);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_costing_sheet(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row costing_sheets%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE costing_sheets SET status = 'cancelled' WHERE id = p_id;
  PERFORM public.record_workflow_action('costing', p_id, 'cancel', v_row.status, 'cancelled', p_reason);
  RETURN jsonb_build_object('cancelled', true);
END; $$;

CREATE OR REPLACE FUNCTION public.approve_costing_sheet(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row costing_sheets%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Costing approval must be done by someone other than who submitted the sheet';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  UPDATE costing_sheets SET status = 'posted', approved_by = v_uid, approved_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('costing', p_id, 'approve', v_row.status, 'posted', p_comment);

  IF v_row.apply_to_product THEN
    UPDATE products SET cost_price = v_row.cost_per_pack, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_row.factory_id, 'approve_costing_sheet', 'products', v_row.product_id::text,
            jsonb_build_object('sheet_id', p_id), jsonb_build_object('cost_price', v_row.cost_per_pack));
  END IF;

  RETURN jsonb_build_object('approved', true, 'posted', true, 'applied', v_row.apply_to_product, 'cost_per_pack', v_row.cost_per_pack);
END; $$;

CREATE OR REPLACE FUNCTION public.reject_costing_sheet(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row costing_sheets%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a costing sheet'; END IF;
  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a costing sheet you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE costing_sheets SET status = 'rejected', approved_by = v_uid, approved_at = now(), reject_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('costing', p_id, 'reject', v_row.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $$;

-- ============================================================================
-- PRODUCTION (this is the one the user actually hit -- entering Production)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_production(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity_produced')::numeric;
  v_unit text := payload->>'unit';
  v_cost numeric := COALESCE((payload->>'production_cost')::numeric, 0);
  v_supervisor text := payload->>'supervisor';
  v_batch text := payload->>'batch_number';
  v_remarks text := payload->>'remarks';
  v_date date := COALESCE((payload->>'production_date')::date, CURRENT_DATE);
  v_request_id uuid := NULLIF(payload->>'production_request_id','')::uuid;
  v_prefix text; v_number text; v_id uuid; v_product products%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'create'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  IF v_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM production_requests WHERE id = v_request_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Production request not found for this factory';
    END IF;
  END IF;

  SELECT COALESCE(production_prefix,'PRD-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'PRD-'; END IF;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO production(factory_id, production_number, production_date, product_id, quantity_produced, unit,
                          production_cost, supervisor, batch_number, remarks, created_by, production_request_id)
  VALUES (v_factory, v_number, v_date, v_product_id, v_qty, COALESCE(v_unit, v_product.unit),
          v_cost, v_supervisor, v_batch, v_remarks, v_uid, v_request_id)
  RETURNING id INTO v_id;

  IF v_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed', production_id = v_id WHERE id = v_request_id;
  END IF;

  PERFORM public.record_workflow_action('production', v_id, 'submit', NULL, 'pending_confirmation', v_remarks);
  RETURN jsonb_build_object('id', v_id, 'production_number', v_number);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_production(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := (payload->>'id')::uuid;
  v_qty numeric := (payload->>'quantity_produced')::numeric;
  v_unit text := payload->>'unit';
  v_cost numeric := COALESCE((payload->>'production_cost')::numeric, 0);
  v_supervisor text := payload->>'supervisor';
  v_batch text := payload->>'batch_number';
  v_remarks text := payload->>'remarks';
  v_date date := (payload->>'production_date')::date;
  v_row production%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM production WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;
  IF v_row.status <> 'pending_confirmation' THEN RAISE EXCEPTION 'Cannot edit a batch after Store has acted on it'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  UPDATE production SET
    quantity_produced = v_qty,
    unit = COALESCE(v_unit, unit),
    production_cost = v_cost,
    supervisor = v_supervisor,
    batch_number = v_batch,
    remarks = v_remarks,
    production_date = COALESCE(v_date, production_date)
  WHERE id = v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_production(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row production%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'cancel'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'cancelled');

  UPDATE production SET status = 'cancelled' WHERE id = p_id;
  IF v_row.production_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'materials_issued'
    WHERE id = v_row.production_request_id AND production_status = 'completed';
  END IF;
  PERFORM public.record_workflow_action('production', p_id, 'cancel', v_row.status, 'cancelled', p_reason);
  RETURN jsonb_build_object('cancelled', true);
END; $$;

CREATE OR REPLACE FUNCTION public.confirm_production_batch(
  p_id uuid, p_actual_received numeric, p_damaged numeric, p_rejected numeric, p_comment text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_row production%ROWTYPE; v_accepted numeric; v_before numeric;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Store confirmation must be done by someone other than who recorded the batch';
  END IF;
  IF p_actual_received IS NULL OR p_actual_received < 0 THEN RAISE EXCEPTION 'Actual quantity received must be >= 0'; END IF;
  IF COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN RAISE EXCEPTION 'Damaged/rejected quantities cannot be negative'; END IF;
  IF COALESCE(p_damaged,0) + COALESCE(p_rejected,0) > p_actual_received THEN
    RAISE EXCEPTION 'Damaged + rejected cannot exceed actual quantity received';
  END IF;
  v_accepted := p_actual_received - COALESCE(p_damaged,0) - COALESCE(p_rejected,0);

  PERFORM public.assert_valid_transition(v_row.status, 'confirmed');
  UPDATE production SET
    actual_quantity_received = p_actual_received, damaged_quantity = COALESCE(p_damaged,0),
    rejected_quantity = COALESCE(p_rejected,0), accepted_quantity = v_accepted,
    confirmed_by = v_uid, confirmed_at = now(), status = 'confirmed'
  WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'confirm', v_row.status, 'confirmed', p_comment);

  PERFORM public.assert_valid_transition('confirmed', 'posted');
  SELECT current_stock INTO v_before FROM products WHERE id = v_row.product_id FOR UPDATE;
  UPDATE products SET current_stock = current_stock + v_accepted, updated_at = now() WHERE id = v_row.product_id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_row.factory_id, v_row.product_id, 'produced', v_accepted, v_row.production_number,
          'Production batch confirmed by Store', v_uid, v_before, v_before + v_accepted);
  UPDATE production SET status = 'posted' WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'post', 'confirmed', 'posted', p_comment);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_production_batch', 'production', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_accepted, 'accepted_quantity', v_accepted));

  RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_accepted);
END; $$;

CREATE OR REPLACE FUNCTION public.reject_production_batch(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row production%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a production batch'; END IF;
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a batch you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE production SET status = 'rejected', confirmed_by = v_uid, confirmed_at = now(), reject_reason = p_reason WHERE id = p_id;
  IF v_row.production_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'materials_issued'
    WHERE id = v_row.production_request_id AND production_status = 'completed';
  END IF;
  PERFORM public.record_workflow_action('production', p_id, 'reject', v_row.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $$;

-- ============================================================================
-- PRODUCTION REQUESTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_production_request(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_requested_by_name text := payload->>'requested_by_name';
  v_department text := payload->>'department';
  v_request_type text := COALESCE(payload->>'request_type', 'production_material');
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_qty numeric := (payload->>'quantity_requested')::numeric;
  v_unit text := payload->>'unit';
  v_remarks text := payload->>'remarks';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_number text;
  v_id uuid;
  v_product products%ROWTYPE;
  v_material raw_materials%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_requested_by_name IS NULL OR btrim(v_requested_by_name) = '' THEN RAISE EXCEPTION 'Requesting staff name is required'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity requested must be > 0'; END IF;

  IF v_request_type = 'purchase' THEN
    SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
    IF v_material.factory_id <> v_factory THEN RAISE EXCEPTION 'Material does not belong to factory'; END IF;

    v_number := 'PR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

    INSERT INTO production_requests(factory_id, request_number, requested_by_name, requested_by, department,
                                     request_type, material_id, supplier_id, quantity_requested, unit, remarks)
    VALUES (v_factory, v_number, v_requested_by_name, v_uid, v_department,
            'purchase', v_material_id, v_supplier_id, v_qty, COALESCE(v_unit, v_material.unit), v_remarks)
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'request_number', v_number);
  END IF;

  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one raw material is required'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  v_number := 'PR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO production_requests(factory_id, request_number, requested_by_name, requested_by, department,
                                   request_type, product_id, quantity_requested, unit, remarks)
  VALUES (v_factory, v_number, v_requested_by_name, v_uid, v_department,
          'production_material', v_product_id, v_qty, COALESCE(v_unit, v_product.unit), v_remarks)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    IF (v_item->>'material_id') IS NULL OR (v_item->>'quantity')::numeric <= 0 THEN
      RAISE EXCEPTION 'Each material line needs a material and a quantity > 0';
    END IF;
    INSERT INTO production_request_items(request_id, material_id, quantity_requested, unit)
    VALUES (v_id, (v_item->>'material_id')::uuid, (v_item->>'quantity')::numeric, v_item->>'unit');
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'request_number', v_number);
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a request you submitted yourself';
  END IF;

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved',
    po_number = CASE WHEN v_row.request_type = 'purchase' THEN
      'PO-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0')
      ELSE po_number END
  WHERE id = p_id;

  RETURN jsonb_build_object('approved', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_production_request(p_id uuid, p_approver_name text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a request you submitted yourself';
  END IF;

  UPDATE production_requests SET
    approval_status = 'rejected', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'rejected',
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;

  RETURN jsonb_build_object('rejected', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_production_request_materials(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_request_id uuid := (payload->>'request_id')::uuid;
  v_issued_by text := payload->>'issued_by_name';
  v_row production_requests%ROWTYPE;
  v_item production_request_items%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_issued_by IS NULL OR btrim(v_issued_by) = '' THEN RAISE EXCEPTION 'Issuer name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = v_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.request_type <> 'production_material' THEN RAISE EXCEPTION 'Only production-material requests can have materials issued'; END IF;
  IF v_row.approval_status <> 'approved' THEN RAISE EXCEPTION 'Request must be approved before materials can be issued'; END IF;
  IF v_row.materials_issued THEN RAISE EXCEPTION 'Materials already issued for this request'; END IF;

  FOR v_item IN SELECT * FROM production_request_items WHERE request_id = v_request_id LOOP
    PERFORM issue_raw_material(jsonb_build_object(
      'material_id', v_item.material_id,
      'quantity', v_item.quantity_requested,
      'purpose', 'production',
      'reference', v_row.request_number,
      'reason', 'Production Request ' || v_row.request_number
    ));
    UPDATE production_request_items SET quantity_issued = quantity_requested WHERE id = v_item.id;
  END LOOP;

  UPDATE production_requests SET
    materials_issued = true, issued_by_name = v_issued_by, issued_at = now(),
    production_status = 'materials_issued'
  WHERE id = v_request_id;

  RETURN jsonb_build_object('issued', true);
END;
$$;
