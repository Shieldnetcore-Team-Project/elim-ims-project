-- ============================================================================
-- Acceptance tests: maintenance_expenses (20261120090000_maintenance_expenses.sql)
-- Maintenance expenses can be recorded and corrected before Accounts review;
-- Accounts decisions are tracked; approved rows are locked, rejected rows reopen
-- for correction and resubmission.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fa000000-0000-0000-0000-0000000000e1', 'mxtest', 'MX Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a0000000-0000-0000-0000-0000000000e1', 'admin@mx'),
  ('a0000000-0000-0000-0000-0000000000e2', 'maint@mx'),
  ('a0000000-0000-0000-0000-0000000000e3', 'accounts@mx');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a0000000-0000-0000-0000-0000000000e1', 'super_admin', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a0000000-0000-0000-0000-0000000000e2', 'maintenance', 'fa000000-0000-0000-0000-0000000000e1')
ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a0000000-0000-0000-0000-0000000000e3', 'accountant', 'fa000000-0000-0000-0000-0000000000e1')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: admin records, edits, deletes
DO $$
DECLARE r jsonb; n int;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e1', false);
  r := public.save_maintenance_expense(jsonb_build_object(
    'factory_id','fa000000-0000-0000-0000-0000000000e1','category','FUEL','amount',15000,
    'description','Diesel for generator','payment_method','Cash'));
  PERFORM pg_temp.check((r->>'expense_number') LIKE 'MEX-%', 'number given');
  PERFORM public.save_maintenance_expense(jsonb_build_object(
    'id', r->>'id', 'factory_id','fa000000-0000-0000-0000-0000000000e1','category','GENERATOR','amount',16000));
  n := (SELECT count(*) FROM maintenance_expenses WHERE id = (r->>'id')::uuid AND category = 'GENERATOR' AND amount = 16000);
  PERFORM pg_temp.check(n = 1, 'edit applied');
  PERFORM public.delete_maintenance_expense((r->>'id')::uuid);
  n := (SELECT count(*) FROM maintenance_expenses WHERE id = (r->>'id')::uuid);
  PERFORM pg_temp.check(n = 0, 'deleted');
END $$;

-- @@ Test 5: Accounts can approve or reject; reviewed entries are immutable
DO $$
DECLARE r jsonb; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e2', false);
  r := public.save_maintenance_expense(jsonb_build_object(
    'factory_id','fa000000-0000-0000-0000-0000000000e1','category','FUEL','amount',4500));

  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e3', false);
  PERFORM public.decide_maintenance_expense((r->>'id')::uuid, true, 'Receipt checked');
  PERFORM pg_temp.check(
    (SELECT approval_status = 'approved' AND review_note = 'Receipt checked'
       FROM maintenance_expenses WHERE id = (r->>'id')::uuid),
    'Accounts approval recorded');

  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e1', false);
  BEGIN
    PERFORM public.save_maintenance_expense(jsonb_build_object(
      'id',r->>'id','factory_id','fa000000-0000-0000-0000-0000000000e1',
      'category','FUEL','amount',5000));
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM LIKE '%Approved maintenance expenses%';
  END;
  PERFORM pg_temp.check(ok, 'approved expense cannot be edited');
  ok := false;
  BEGIN
    PERFORM public.delete_maintenance_expense((r->>'id')::uuid);
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM LIKE '%Approved maintenance expenses%';
  END;
  PERFORM pg_temp.check(ok, 'approved expense cannot be deleted');
END $$;

-- @@ Test 6: rejecting requires a reason and is audited
DO $$
DECLARE r jsonb; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e2', false);
  r := public.save_maintenance_expense(jsonb_build_object(
    'factory_id','fa000000-0000-0000-0000-0000000000e1','category','FUEL','amount',6000));
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e3', false);
  BEGIN
    PERFORM public.decide_maintenance_expense((r->>'id')::uuid, false, NULL);
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM LIKE '%reason is required%';
  END;
  PERFORM pg_temp.check(ok, 'rejection requires a reason');
  PERFORM public.decide_maintenance_expense((r->>'id')::uuid, false, 'Receipt is missing');
  PERFORM pg_temp.check(
    (SELECT approval_status = 'rejected' AND review_note = 'Receipt is missing'
       FROM maintenance_expenses WHERE id = (r->>'id')::uuid),
    'Accounts rejection recorded');

  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e2', false);
  PERFORM public.save_maintenance_expense(jsonb_build_object(
    'id',r->>'id','factory_id','fa000000-0000-0000-0000-0000000000e1',
    'category','FUEL','amount',6200));
  PERFORM pg_temp.check(
    (SELECT approval_status = 'pending_review' AND reviewed_by IS NULL AND review_note IS NULL
       FROM maintenance_expenses WHERE id = (r->>'id')::uuid),
    'corrected rejected expense returns to review');
END $$;

-- @@ Test 2: maintenance role records but cannot delete
DO $$
DECLARE r jsonb; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e2', false);
  r := public.save_maintenance_expense(jsonb_build_object(
    'factory_id','fa000000-0000-0000-0000-0000000000e1','category','TRANSPORTATION','amount',2000));
  BEGIN
    PERFORM public.delete_maintenance_expense((r->>'id')::uuid);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient%';
  END;
  PERFORM pg_temp.check(ok, 'maintenance cannot delete');
END $$;

-- @@ Test 3: bad input refused
DO $$
DECLARE ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e1', false);
  BEGIN
    PERFORM public.save_maintenance_expense(jsonb_build_object(
      'factory_id','fa000000-0000-0000-0000-0000000000e1','category','FUEL','amount',0));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%above 0%';
  END;
  PERFORM pg_temp.check(ok, 'zero amount refused');
  ok := false;
  BEGIN
    PERFORM public.save_maintenance_expense(jsonb_build_object(
      'factory_id','fa000000-0000-0000-0000-0000000000e1','amount',100));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%category%';
  END;
  PERFORM pg_temp.check(ok, 'missing category refused');
END $$;

-- @@ Test 4: TIRE keeps type and size; a typed-in head is accepted
DO $$
DECLARE r jsonb; n int;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000e1', false);
  r := public.save_maintenance_expense(jsonb_build_object(
    'factory_id','fa000000-0000-0000-0000-0000000000e1','category','TIRE','amount',85000,
    'tire_type','Tubeless','tire_size','195/65 R15'));
  n := (SELECT count(*) FROM maintenance_expenses WHERE id = (r->>'id')::uuid
          AND tire_type = 'Tubeless' AND tire_size = '195/65 R15');
  PERFORM pg_temp.check(n = 1, 'tire fields saved');
  PERFORM public.save_maintenance_expense(jsonb_build_object(
    'id', r->>'id', 'factory_id','fa000000-0000-0000-0000-0000000000e1','category','TIRE','amount',90000));
  n := (SELECT count(*) FROM maintenance_expenses WHERE id = (r->>'id')::uuid AND tire_size = '195/65 R15' AND amount = 90000);
  PERFORM pg_temp.check(n = 1, 'edit without tire keys keeps them');
  r := public.save_maintenance_expense(jsonb_build_object(
    'factory_id','fa000000-0000-0000-0000-0000000000e1','category','SECURITY','amount',5000));
  PERFORM pg_temp.check((r->>'expense_number') LIKE 'MEX-%', 'typed head accepted');
END $$;
