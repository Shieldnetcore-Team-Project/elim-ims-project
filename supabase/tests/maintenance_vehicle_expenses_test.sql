-- ============================================================================
-- Acceptance tests: save_vehicle_expenses (20261121090000)
-- A vehicle sheet saves all its lines at once; a general-tab edit keeps the
-- vehicle; bad sheets are refused whole.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fa000000-0000-0000-0000-0000000000f1', 'mvtest', 'MV Test Factory');
INSERT INTO auth.users(id, email) VALUES ('a0000000-0000-0000-0000-0000000000f1', 'admin@mv');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a0000000-0000-0000-0000-0000000000f1', 'super_admin', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO vehicles(id, factory_id, plate_number) VALUES
  ('ee000000-0000-0000-0000-0000000000f1', 'fa000000-0000-0000-0000-0000000000f1', 'ABJ-465 YT');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: sheet saves every line; edit from Expenses keeps the vehicle
DO $$
DECLARE r jsonb; v_id uuid; n int;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000f1', false);
  r := public.save_vehicle_expenses(jsonb_build_object(
    'factory_id','fa000000-0000-0000-0000-0000000000f1',
    'vehicle_id','ee000000-0000-0000-0000-0000000000f1',
    'driver_name','James/Emma',
    'lines', jsonb_build_array(
      jsonb_build_object('kind','part','description','Gasket','amount',1500),
      jsonb_build_object('kind','part','category','ENGINE OIL','description','Engine oil','quantity',8,'unit_price',3400,'amount',27200),
      jsonb_build_object('kind','fuel','quantity',113,'unit_price',1400,'amount',158700))));
  PERFORM pg_temp.check((r->>'lines')::int = 3 AND (r->>'total')::numeric = 187400, 'three lines, total');
  n := (SELECT count(*) FROM maintenance_expenses
         WHERE vehicle_id = 'ee000000-0000-0000-0000-0000000000f1' AND driver_name = 'James/Emma');
  PERFORM pg_temp.check(n = 3, 'lines carry vehicle and driver');
  n := (SELECT count(*) FROM maintenance_expenses WHERE line_kind = 'fuel' AND category = 'FUEL' AND quantity = 113);
  PERFORM pg_temp.check(n = 1, 'fuel line under FUEL');
  n := (SELECT count(*) FROM maintenance_expenses WHERE description = 'Gasket' AND category = 'VEHICLE MAINT.');
  PERFORM pg_temp.check(n = 1, 'part defaults to VEHICLE MAINT.');

  v_id := (SELECT id FROM maintenance_expenses WHERE description = 'Gasket');
  PERFORM public.save_maintenance_expense(jsonb_build_object(
    'id', v_id, 'factory_id','fa000000-0000-0000-0000-0000000000f1',
    'category','VEHICLE MAINT.','description','Gasket','amount',1600));
  n := (SELECT count(*) FROM maintenance_expenses WHERE id = v_id AND amount = 1600
          AND vehicle_id IS NOT NULL AND line_kind = 'part');
  PERFORM pg_temp.check(n = 1, 'general edit keeps vehicle fields');
END $$;

-- @@ Test 2: a bad line refuses the whole sheet
DO $$
DECLARE ok boolean := false; n int;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000f1', false);
  n := (SELECT count(*) FROM maintenance_expenses);
  BEGIN
    PERFORM public.save_vehicle_expenses(jsonb_build_object(
      'factory_id','fa000000-0000-0000-0000-0000000000f1',
      'vehicle_id','ee000000-0000-0000-0000-0000000000f1',
      'lines', jsonb_build_array(
        jsonb_build_object('kind','part','description','Bolt','amount',1500),
        jsonb_build_object('kind','fuel','amount',5000))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%litres%';
  END;
  PERFORM pg_temp.check(ok, 'fuel without litres refused');
  PERFORM pg_temp.check((SELECT count(*) FROM maintenance_expenses) = n, 'nothing saved');
  ok := false;
  BEGIN
    PERFORM public.save_vehicle_expenses(jsonb_build_object(
      'factory_id','fa000000-0000-0000-0000-0000000000f1',
      'lines', jsonb_build_array(jsonb_build_object('kind','part','description','Bolt','amount',1))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%vehicle%';
  END;
  PERFORM pg_temp.check(ok, 'missing vehicle refused');
END $$;
