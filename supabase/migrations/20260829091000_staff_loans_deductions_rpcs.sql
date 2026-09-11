-- ============================================================================
-- STAFF LOANS + FINES/CONTRIBUTIONS — RPCs
-- ----------------------------------------------------------------------------
-- New: record / approve / reject / cancel a staff loan; record / approve /
-- reject a fine or contribution. All maker -> checker, guarded on the
-- payroll module's create / approve / reject / cancel actions.
--
-- Re-declared from 20260816110000_fix_has_permission_module_cast_all_workflow_rpcs.sql:
--   process_payroll   now also computes the loan repayment slice + approved
--                     fines/contributions for the period, schedules the loan
--                     repayments against the new run, and stamps the
--                     adjustments 'applied'. Client-sent `loans` is ignored;
--                     `other_deductions` is treated as a manual extra on top
--                     of the approved fines/contributions.
--   post_payroll      confirms this run's scheduled repayments -> 'paid',
--                     draws down the loan, settles it when cleared.
--   reject/cancel_payroll  releases the run's scheduled repayments and
--                     un-applies its adjustments.
--   reverse_payroll   voids the run's paid repayments, restores the balance,
--                     re-opens a settled loan, un-applies its adjustments.
-- ============================================================================

-- ============ 1. create_staff_loan ============
CREATE OR REPLACE FUNCTION public.create_staff_loan(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_employee uuid := (payload->>'employee_id')::uuid;
  v_principal numeric := (payload->>'principal')::numeric;
  v_disbursed date := COALESCE((payload->>'disbursed_on')::date, CURRENT_DATE);
  v_type text := payload->>'repayment_type';
  v_mode text := NULLIF(payload->>'installment_mode','');
  v_inst_amt numeric := NULLIF(payload->>'installment_amount','')::numeric;
  v_inst_months integer := NULLIF(payload->>'installment_months','')::integer;
  v_reason text := payload->>'reason';
  v_remarks text := payload->>'remarks';
  v_number text; v_id uuid; v_emp employees%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_principal IS NULL OR v_principal <= 0 THEN RAISE EXCEPTION 'Principal must be > 0'; END IF;
  IF v_type NOT IN ('one_time','installment') THEN RAISE EXCEPTION 'repayment_type must be one_time or installment'; END IF;

  SELECT * INTO v_emp FROM employees WHERE id = v_employee AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found in this factory'; END IF;

  IF v_type = 'installment' THEN
    IF v_mode = 'amount' THEN
      IF v_inst_amt IS NULL OR v_inst_amt <= 0 THEN RAISE EXCEPTION 'Installment amount must be > 0'; END IF;
      v_inst_months := NULL;
    ELSIF v_mode = 'months' THEN
      IF v_inst_months IS NULL OR v_inst_months <= 0 THEN RAISE EXCEPTION 'Number of months must be > 0'; END IF;
      v_inst_amt := NULL;
    ELSE
      RAISE EXCEPTION 'installment_mode must be amount or months';
    END IF;
  ELSE
    v_mode := NULL; v_inst_amt := NULL; v_inst_months := NULL;
  END IF;

  v_number := 'LN-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO staff_loans(factory_id, employee_id, loan_number, principal, disbursed_on, repayment_type,
                          installment_mode, installment_amount, installment_months, reason, remarks, submitted_by)
  VALUES (v_factory, v_employee, v_number, v_principal, v_disbursed, v_type,
          v_mode, v_inst_amt, v_inst_months, v_reason, v_remarks, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'loan_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.create_staff_loan(jsonb) TO authenticated;

-- ============ 2. approve / reject / cancel staff loan ============
CREATE OR REPLACE FUNCTION public.approve_staff_loan(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row staff_loans%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_row FROM staff_loans WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Loan is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a loan you recorded yourself';
  END IF;
  UPDATE staff_loans SET status = 'active', approved_by = v_uid, approved_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_staff_loan(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_staff_loan(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row staff_loans%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'reject'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a loan'; END IF;
  SELECT * INTO v_row FROM staff_loans WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Loan is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject a loan you recorded yourself';
  END IF;
  UPDATE staff_loans SET status = 'rejected', approved_by = v_uid, approved_at = now(), reject_reason = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_staff_loan(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_staff_loan(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row staff_loans%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'cancel'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_row FROM staff_loans WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF v_row.status <> 'active' THEN RAISE EXCEPTION 'Only an active loan can be cancelled'; END IF;
  IF EXISTS (SELECT 1 FROM staff_loan_repayments WHERE loan_id = p_id AND status = 'paid') THEN
    RAISE EXCEPTION 'Cannot cancel: repayments have already been made against this loan';
  END IF;
  DELETE FROM staff_loan_repayments WHERE loan_id = p_id AND status = 'scheduled';
  UPDATE staff_loans SET status = 'cancelled', reject_reason = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_staff_loan(uuid, text) TO authenticated;

-- ============ 3. create / approve / reject staff deduction ============
CREATE OR REPLACE FUNCTION public.create_staff_deduction(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_employee uuid := (payload->>'employee_id')::uuid;
  v_kind text := payload->>'kind';
  v_label text := payload->>'label';
  v_amount numeric := (payload->>'amount')::numeric;
  v_month integer := (payload->>'period_month')::integer;
  v_year integer := (payload->>'period_year')::integer;
  v_reason text := payload->>'reason';
  v_number text; v_id uuid; v_emp employees%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_kind NOT IN ('fine','contribution','other') THEN RAISE EXCEPTION 'kind must be fine, contribution or other'; END IF;
  IF v_label IS NULL OR btrim(v_label) = '' THEN RAISE EXCEPTION 'A label is required'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;
  IF v_month IS NULL OR v_month < 1 OR v_month > 12 THEN RAISE EXCEPTION 'period_month must be 1-12'; END IF;
  IF v_year IS NULL THEN RAISE EXCEPTION 'period_year required'; END IF;

  SELECT * INTO v_emp FROM employees WHERE id = v_employee AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found in this factory'; END IF;

  v_number := 'DED-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO staff_deductions(factory_id, employee_id, reference_number, kind, label, amount, period_month, period_year, reason, submitted_by)
  VALUES (v_factory, v_employee, v_number, v_kind, v_label, v_amount, v_month, v_year, v_reason, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'reference_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.create_staff_deduction(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_staff_deduction(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row staff_deductions%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_row FROM staff_deductions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Entry is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve an entry you recorded yourself';
  END IF;
  UPDATE staff_deductions SET status = 'approved', approved_by = v_uid, approved_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_staff_deduction(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_staff_deduction(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row staff_deductions%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'reject'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  SELECT * INTO v_row FROM staff_deductions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Entry is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot reject an entry you recorded yourself';
  END IF;
  UPDATE staff_deductions SET status = 'rejected', approved_by = v_uid, approved_at = now(), reject_reason = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_staff_deduction(uuid, text) TO authenticated;

-- ============ 4. process_payroll — pull loans + approved fines/contributions ============
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
  v_advance numeric := COALESCE((payload->>'advance')::numeric, 0);
  v_manual_other numeric := COALESCE((payload->>'other_deductions')::numeric, 0);
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'transfer');
  v_emp employees%ROWTYPE;
  v_gross numeric; v_net numeric; v_id uuid;
  v_loan staff_loans%ROWTYPE;
  v_this numeric;
  v_loan_ded numeric := 0;
  v_adj_ded numeric := 0;
  v_other_total numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_month IS NULL OR v_month < 1 OR v_month > 12 THEN RAISE EXCEPTION 'period_month must be 1-12'; END IF;
  IF v_year IS NULL THEN RAISE EXCEPTION 'period_year required'; END IF;

  SELECT * INTO v_emp FROM employees WHERE id = v_employee_id AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found in this factory'; END IF;

  IF EXISTS (
    SELECT 1 FROM payroll
    WHERE employee_id = v_employee_id AND period_month = v_month AND period_year = v_year
      AND status IN ('pending_approval','approved','posted')
  ) THEN
    RAISE EXCEPTION 'A payroll run for this employee and period already exists';
  END IF;

  v_gross := v_emp.basic_salary + COALESCE(v_emp.housing_allowance,0) + COALESCE(v_emp.transport_allowance,0)
           + COALESCE(v_emp.meal_allowance,0) + COALESCE(v_emp.medical_allowance,0) + COALESCE(v_emp.other_allowances,0) + v_overtime;

  -- loan repayment slice for this period (active loans with a balance)
  FOR v_loan IN
    SELECT * FROM staff_loans
    WHERE employee_id = v_employee_id AND status = 'active' AND (principal - amount_repaid) > 0
    ORDER BY disbursed_on
    FOR UPDATE
  LOOP
    v_this := CASE
      WHEN v_loan.repayment_type = 'one_time' THEN v_loan.outstanding
      WHEN v_loan.installment_mode = 'amount' THEN LEAST(v_loan.installment_amount, v_loan.outstanding)
      ELSE LEAST(round(v_loan.principal / v_loan.installment_months, 2), v_loan.outstanding)
    END;
    IF v_this > 0 THEN
      v_loan_ded := v_loan_ded + v_this;
    END IF;
  END LOOP;

  -- approved fines / contributions for this period
  SELECT COALESCE(SUM(amount), 0) INTO v_adj_ded
  FROM staff_deductions
  WHERE employee_id = v_employee_id AND period_month = v_month AND period_year = v_year AND status = 'approved';

  v_other_total := v_manual_other + v_adj_ded;
  v_net := v_gross - v_paye - v_pension - v_loan_ded - v_advance - v_other_total;

  INSERT INTO payroll(
    factory_id, employee_id, period_month, period_year,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    overtime, gross_salary, paye, pension, loans, advance, other_deductions, net_salary,
    payment_method, status, bank_name, account_number, submitted_by, submitted_at
  ) VALUES (
    v_factory, v_employee_id, v_month, v_year,
    v_emp.basic_salary, v_emp.housing_allowance, v_emp.transport_allowance, v_emp.meal_allowance, v_emp.medical_allowance, v_emp.other_allowances,
    v_overtime, v_gross, v_paye, v_pension, v_loan_ded, v_advance, v_other_total, v_net,
    v_method, 'pending_approval', v_emp.bank_name, v_emp.account_number, v_uid, now()
  ) RETURNING id INTO v_id;

  -- schedule the loan repayments against this run
  FOR v_loan IN
    SELECT * FROM staff_loans
    WHERE employee_id = v_employee_id AND status = 'active' AND (principal - amount_repaid) > 0
    ORDER BY disbursed_on
  LOOP
    v_this := CASE
      WHEN v_loan.repayment_type = 'one_time' THEN v_loan.outstanding
      WHEN v_loan.installment_mode = 'amount' THEN LEAST(v_loan.installment_amount, v_loan.outstanding)
      ELSE LEAST(round(v_loan.principal / v_loan.installment_months, 2), v_loan.outstanding)
    END;
    IF v_this > 0 THEN
      INSERT INTO staff_loan_repayments(loan_id, factory_id, payroll_id, period_month, period_year, amount, status, created_by)
      VALUES (v_loan.id, v_factory, v_id, v_month, v_year, v_this, 'scheduled', v_uid);
    END IF;
  END LOOP;

  -- stamp the fines / contributions applied to this run
  UPDATE staff_deductions SET status = 'applied', applied_payroll_id = v_id
  WHERE employee_id = v_employee_id AND period_month = v_month AND period_year = v_year AND status = 'approved';

  PERFORM public.record_workflow_action('payroll', v_id, 'submit', NULL, 'pending_approval', NULL);
  RETURN jsonb_build_object('id', v_id, 'gross_salary', v_gross, 'net_salary', v_net,
                            'loan_deduction', v_loan_ded, 'adjustment_deduction', v_adj_ded,
                            'manual_other_deduction', v_manual_other);
END; $$;
GRANT EXECUTE ON FUNCTION public.process_payroll(jsonb) TO authenticated;

-- ============ 5. post_payroll — confirm loan repayments as paid ============
CREATE OR REPLACE FUNCTION public.post_payroll(p_id uuid, p_payment_date date DEFAULT CURRENT_DATE, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid(); v_rep staff_loan_repayments%ROWTYPE;
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

  FOR v_rep IN SELECT * FROM staff_loan_repayments WHERE payroll_id = p_id AND status = 'scheduled' FOR UPDATE LOOP
    UPDATE staff_loan_repayments SET status = 'paid', paid_at = now() WHERE id = v_rep.id;
    UPDATE staff_loans SET amount_repaid = amount_repaid + v_rep.amount, updated_at = now() WHERE id = v_rep.loan_id;
    UPDATE staff_loans SET status = 'settled' WHERE id = v_rep.loan_id AND status = 'active' AND amount_repaid >= principal;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'post_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'net_salary', v_row.net_salary));
  RETURN jsonb_build_object('posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.post_payroll(uuid, date, text) TO authenticated;

-- ============ 6. reject / cancel payroll — release scheduled repayments + adjustments ============
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

  DELETE FROM staff_loan_repayments WHERE payroll_id = p_id AND status = 'scheduled';
  UPDATE staff_deductions SET status = 'approved', applied_payroll_id = NULL WHERE applied_payroll_id = p_id AND status = 'applied';
  RETURN jsonb_build_object('rejected', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_payroll(uuid, text) TO authenticated;

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

  DELETE FROM staff_loan_repayments WHERE payroll_id = p_id AND status = 'scheduled';
  UPDATE staff_deductions SET status = 'approved', applied_payroll_id = NULL WHERE applied_payroll_id = p_id AND status = 'applied';
  RETURN jsonb_build_object('cancelled', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.cancel_payroll(uuid, text) TO authenticated;

-- ============ 7. reverse_payroll — void paid repayments, restore balances ============
CREATE OR REPLACE FUNCTION public.reverse_payroll(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid(); v_rep staff_loan_repayments%ROWTYPE;
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

  FOR v_rep IN SELECT * FROM staff_loan_repayments WHERE payroll_id = p_id AND status = 'paid' FOR UPDATE LOOP
    UPDATE staff_loan_repayments SET status = 'void' WHERE id = v_rep.id;
    UPDATE staff_loans
       SET amount_repaid = GREATEST(amount_repaid - v_rep.amount, 0),
           status = CASE WHEN status = 'settled' THEN 'active' ELSE status END,
           updated_at = now()
     WHERE id = v_rep.loan_id;
  END LOOP;
  UPDATE staff_deductions SET status = 'approved', applied_payroll_id = NULL WHERE applied_payroll_id = p_id AND status = 'applied';

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.reverse_payroll(uuid, text) TO authenticated;
