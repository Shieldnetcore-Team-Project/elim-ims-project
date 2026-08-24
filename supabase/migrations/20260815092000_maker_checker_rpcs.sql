-- ============================================================================
-- MAKER-CHECKER PHASE 1 — RPCs
-- ----------------------------------------------------------------------------
-- New/changed RPCs for the six Phase 1 flows. Every approve/reject RPC here:
--   1. Requires the 'approve' tier on the relevant module (not 'write').
--   2. Blocks the submitter from approving/rejecting their own submission,
--      unless they are super_admin (the deliberate solo-admin bypass).
--   3. Writes its own audit_logs row from inside the function, so the trail
--      can't be skipped by a client that doesn't call the separate
--      src/lib/audit.ts helper.
-- ============================================================================

-- ============================================================================
-- 1. EXPENSES — approve_expense/reject_expense now trust auth.uid(), not a
--    free-text name, and block self-approval.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_expense(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row expenses%ROWTYPE;
  v_uid uuid := auth.uid();
  v_name text;
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Expense is already %', v_row.approval_status; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve an expense you submitted yourself';
  END IF;

  SELECT COALESCE(full_name, email, 'Unknown') INTO v_name FROM profiles WHERE id = v_uid;

  UPDATE expenses SET approval_status = 'approved', approved_by = v_name, approved_at = now(),
    reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_expense', 'expenses', p_id::text,
          jsonb_build_object('approval_status', v_row.approval_status),
          jsonb_build_object('approval_status', 'approved', 'approved_by', v_name));

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_expense(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_expense(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row expenses%ROWTYPE;
  v_uid uuid := auth.uid();
  v_name text;
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Expense is already %', v_row.approval_status; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject an expense you submitted yourself';
  END IF;

  SELECT COALESCE(full_name, email, 'Unknown') INTO v_name FROM profiles WHERE id = v_uid;

  UPDATE expenses SET
    approval_status = 'rejected', approved_by = v_name, approved_at = now(),
    reviewed_by = v_uid, reviewed_at = now(),
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_expense', 'expenses', p_id::text,
          jsonb_build_object('approval_status', v_row.approval_status),
          jsonb_build_object('approval_status', 'rejected', 'reason', p_reason));

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_expense(uuid, text) TO authenticated;

-- ============================================================================
-- 2. DEBT WRITE-OFFS — close_debt splits into request/approve/reject.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.status = 'paid' THEN RAISE EXCEPTION 'Debt is already closed'; END IF;
  IF v_debt.writeoff_status = 'requested' THEN RAISE EXCEPTION 'A write-off request is already pending for this debt'; END IF;

  UPDATE debts SET
    writeoff_status = 'requested', writeoff_requested_by = v_uid, writeoff_requested_at = now(),
    writeoff_reason = p_reason, writeoff_reviewed_by = NULL, writeoff_reviewed_at = NULL, writeoff_reject_reason = NULL
  WHERE id = p_debt_id;

  RETURN jsonb_build_object('requested', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_debt_writeoff(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_debt_writeoff(p_debt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_debt debts%ROWTYPE;
  v_written_off numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_status <> 'requested' THEN RAISE EXCEPTION 'No pending write-off request for this debt'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a write-off you requested yourself';
  END IF;

  v_written_off := v_debt.outstanding;

  UPDATE debts SET
    amount_paid = total_amount, outstanding = 0, status = 'paid', updated_at = now(),
    writeoff_status = 'approved', writeoff_reviewed_by = v_uid, writeoff_reviewed_at = now()
  WHERE id = p_debt_id;

  IF v_debt.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_written_off, 0), updated_at = now()
     WHERE id = v_debt.customer_id;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'approve_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('outstanding', v_debt.outstanding, 'status', v_debt.status),
          jsonb_build_object('outstanding', 0, 'status', 'paid', 'written_off', v_written_off,
                              'requested_by', v_debt.writeoff_requested_by, 'reason', v_debt.writeoff_reason));

  RETURN jsonb_build_object('closed', true, 'written_off', v_written_off);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_debt_writeoff(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_status <> 'requested' THEN RAISE EXCEPTION 'No pending write-off request for this debt'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a write-off you requested yourself';
  END IF;

  UPDATE debts SET
    writeoff_status = 'rejected', writeoff_reviewed_by = v_uid, writeoff_reviewed_at = now(), writeoff_reject_reason = p_reason
  WHERE id = p_debt_id;

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_debt_writeoff(uuid, text) TO authenticated;

-- Backward-compat shim: a stale cached client calling the old close_debt now
-- creates a pending request instead of hard-failing with "function not found".
CREATE OR REPLACE FUNCTION public.close_debt(p_debt_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.request_debt_writeoff(p_debt_id, p_reason);
END;
$$;
GRANT EXECUTE ON FUNCTION public.close_debt(uuid, text) TO authenticated;

-- ============================================================================
-- 3. PAYMENTS — non-blocking post-hoc review. Money/receipt/balances are
--    untouched by confirm/flag; record_payment and create_sale keep working
--    exactly as before (still immediate).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.confirm_payment(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row payments_received%ROWTYPE;
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payments', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.review_status <> 'pending' THEN RAISE EXCEPTION 'Payment is already %', v_row.review_status; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot confirm a payment you recorded yourself';
  END IF;

  UPDATE payments_received SET review_status = 'approved', reviewed_by = v_uid, reviewed_at = now(), review_note = p_note
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_payment', 'payments_received', p_id::text,
          jsonb_build_object('review_status', 'pending'), jsonb_build_object('review_status', 'approved'));

  RETURN jsonb_build_object('confirmed', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.flag_payment(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row payments_received%ROWTYPE;
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payments', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to flag a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.review_status <> 'pending' THEN RAISE EXCEPTION 'Payment is already %', v_row.review_status; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot flag a payment you recorded yourself';
  END IF;

  UPDATE payments_received SET review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'flag_payment', 'payments_received', p_id::text,
          jsonb_build_object('review_status', 'pending'), jsonb_build_object('review_status', 'rejected', 'reason', p_reason));

  RETURN jsonb_build_object('flagged', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.flag_payment(uuid, text) TO authenticated;

-- ============================================================================
-- 4. PAYROLL — no RPC existed before. process_payroll recomputes gross/net
--    server-side (never trusts client-sent salary figures); approve_payroll
--    finalizes to 'paid'.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.process_payroll(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_emp employees%ROWTYPE;
  v_gross numeric;
  v_net numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_month IS NULL OR v_month < 1 OR v_month > 12 THEN RAISE EXCEPTION 'period_month must be 1-12'; END IF;
  IF v_year IS NULL THEN RAISE EXCEPTION 'period_year required'; END IF;

  SELECT * INTO v_emp FROM employees WHERE id = v_employee_id AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found in this factory'; END IF;

  -- Salary/allowances are ALWAYS pulled from the employee record server-side,
  -- never from the client payload — this is the one place in the app where a
  -- financial total used to be entirely client-computed and trusted as-is.
  v_gross := v_emp.basic_salary + COALESCE(v_emp.housing_allowance,0) + COALESCE(v_emp.transport_allowance,0)
           + COALESCE(v_emp.meal_allowance,0) + COALESCE(v_emp.medical_allowance,0) + COALESCE(v_emp.other_allowances,0)
           + v_overtime;
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
END;
$$;
GRANT EXECUTE ON FUNCTION public.process_payroll(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_payroll(p_id uuid, p_payment_date date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row payroll%ROWTYPE;
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.status <> 'pending_approval' THEN RAISE EXCEPTION 'Payroll record is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a payroll run you submitted yourself';
  END IF;

  UPDATE payroll SET status = 'paid', payment_date = p_payment_date, reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status),
          jsonb_build_object('status', 'paid', 'net_salary', v_row.net_salary));

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_payroll(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_payroll(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row payroll%ROWTYPE;
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.status <> 'pending_approval' THEN RAISE EXCEPTION 'Payroll record is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a payroll run you submitted yourself';
  END IF;

  UPDATE payroll SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason
  WHERE id = p_id;

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_payroll(uuid, text) TO authenticated;

-- ============================================================================
-- 5. STOCK WRITE-OFFS — negative deltas only, request/approve/reject. The
--    existing adjust_raw_material/adjust_finished_stock now reject negative
--    deltas outright so this path can't be bypassed by calling them directly.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_stock_adjustment(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_entity_type text := payload->>'entity_type';
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_movement_type text := COALESCE(payload->>'movement_type', 'adjusted');
  v_reason text := payload->>'reason';
  v_factory uuid;
  v_id uuid;
BEGIN
  IF v_entity_type NOT IN ('raw_material','finished_good') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_delta IS NULL OR v_delta >= 0 THEN RAISE EXCEPTION 'quantity_delta must be negative for a write-off request'; END IF;

  IF v_entity_type = 'raw_material' THEN
    IF NOT public.has_permission(v_uid, 'raw-materials', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id INTO v_factory FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  ELSE
    IF NOT public.has_permission(v_uid, 'finished-goods', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id INTO v_factory FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  END IF;

  INSERT INTO stock_adjustment_requests(factory_id, entity_type, material_id, product_id, quantity_delta, movement_type, reason, submitted_by)
  VALUES (v_factory, v_entity_type, v_material_id, v_product_id, v_delta, v_movement_type, v_reason, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_stock_adjustment(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_stock_adjustment(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req stock_adjustment_requests%ROWTYPE;
  v_module public.module_key;
  v_before numeric;
  v_unit_cost numeric;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a stock write-off you submitted yourself';
  END IF;

  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, unit_cost INTO v_before, v_unit_cost FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    UPDATE raw_materials SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_unit_cost, 'Approved write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  ELSE
    SELECT current_stock INTO v_before FROM products WHERE id = v_req.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, v_req.movement_type::movement_type, v_req.quantity_delta, 'Approved write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  END IF;

  UPDATE stock_adjustment_requests SET review_status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'approve_stock_adjustment', v_req.entity_type,
          COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before),
          jsonb_build_object('current_stock', v_before + v_req.quantity_delta, 'delta', v_req.quantity_delta));

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_stock_adjustment(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_stock_adjustment(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req stock_adjustment_requests%ROWTYPE;
  v_module public.module_key;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a stock write-off you submitted yourself';
  END IF;

  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  UPDATE stock_adjustment_requests SET review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason
  WHERE id = p_id;

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_stock_adjustment(uuid, text) TO authenticated;

-- Existing adjust RPCs now reject reductions outright — routine positive
-- adjustments stay immediate/frictionless, reductions must go through the
-- request/approve pair above.
CREATE OR REPLACE FUNCTION public.adjust_raw_material(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_reason text := payload->>'reason';
  v_material raw_materials%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'Adjustment must be non-zero'; END IF;
  IF v_delta < 0 THEN RAISE EXCEPTION 'Negative adjustments require approval — use request_stock_adjustment'; END IF;

  UPDATE raw_materials SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_material.factory_id, v_material_id, 'adjusted', v_delta, v_material.unit_cost, NULL, COALESCE(v_reason, 'Manual adjustment'), v_uid,
          v_material.current_stock, v_material.current_stock + v_delta);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_raw_material(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.adjust_finished_stock(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_reason text := payload->>'reason';
  v_movement_type movement_type := COALESCE((payload->>'movement_type')::movement_type, 'adjusted');
  v_product products%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_movement_type NOT IN ('adjusted','damaged','returned') THEN
    RAISE EXCEPTION 'Invalid movement_type for a manual adjustment';
  END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'Adjustment must be non-zero'; END IF;
  IF v_delta < 0 THEN RAISE EXCEPTION 'Negative adjustments require approval — use request_stock_adjustment'; END IF;

  UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_product_id;

  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_product.factory_id, v_product_id, v_movement_type, v_delta, NULL,
          COALESCE(v_reason, initcap(v_movement_type::text)), v_uid, v_product.current_stock, v_product.current_stock + v_delta);

  RETURN jsonb_build_object('adjusted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.adjust_finished_stock(jsonb) TO authenticated;

-- ============================================================================
-- 6. ROLE GRANTS — request/approve/reject for user_roles changes.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_role_grant(p_target_user_id uuid, p_role public.app_role, p_factory_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_target_user_id) THEN RAISE EXCEPTION 'Target user not found'; END IF;

  INSERT INTO role_grant_requests(target_user_id, role, factory_id, action, requested_by)
  VALUES (p_target_user_id, p_role, p_factory_id, 'grant', v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_role_grant(uuid, public.app_role, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_role_revoke(p_user_id uuid, p_role public.app_role, p_factory_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = p_user_id AND role = p_role AND factory_id IS NOT DISTINCT FROM p_factory_id
  ) THEN RAISE EXCEPTION 'Role assignment not found'; END IF;

  INSERT INTO role_grant_requests(target_user_id, role, factory_id, action, requested_by)
  VALUES (p_user_id, p_role, p_factory_id, 'revoke', v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_role_revoke(uuid, public.app_role, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_role_grant(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a role change you requested yourself';
  END IF;

  IF v_req.action = 'grant' THEN
    INSERT INTO user_roles(user_id, role, factory_id) VALUES (v_req.target_user_id, v_req.role, v_req.factory_id)
    ON CONFLICT (user_id, role, factory_id) DO NOTHING;
  ELSE
    DELETE FROM user_roles WHERE user_id = v_req.target_user_id AND role = v_req.role AND factory_id IS NOT DISTINCT FROM v_req.factory_id;
  END IF;

  UPDATE role_grant_requests SET review_status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_request_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'approve_role_' || v_req.action, 'user_roles', v_req.target_user_id::text,
          jsonb_build_object('action', v_req.action, 'role', v_req.role, 'requested_by', v_req.requested_by),
          jsonb_build_object('applied', true));

  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_role_grant(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_role_grant(p_request_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users', 'approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;
  IF v_req.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a role change you requested yourself';
  END IF;

  UPDATE role_grant_requests SET review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason
  WHERE id = p_request_id;

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_role_grant(uuid, text) TO authenticated;
