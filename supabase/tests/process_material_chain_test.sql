-- ============================================================================
-- Acceptance tests: an earlier day's change carries to the later days
-- (20261104180000_process_material_chain.sql). Runs as an admin.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9900000-0000-0000-0000-000000000001', 'pcfac', 'PC Factory');
INSERT INTO auth.users(id, email) VALUES ('a9900000-0000-0000-0000-000000000001', 'admin@pc');
DELETE FROM user_roles WHERE user_id = 'a9900000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a9900000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO raw_materials(id, factory_id, name, unit) VALUES
  ('c9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'PC Preform', 'Piece');
SELECT set_config('test.uid', 'a9900000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.line(d date) RETURNS production_material_reports LANGUAGE sql AS $$
  SELECT * FROM production_material_reports WHERE material_id = 'c9900000-0000-0000-0000-000000000001' AND report_date = d $$;

-- @@ Test 1: the 3rd is edited; the 4th opens at the new balance
DO $$
DECLARE f uuid := 'f9900000-0000-0000-0000-000000000001'; m uuid := 'c9900000-0000-0000-0000-000000000001';
  d3 date := CURRENT_DATE - 1; d4 date := CURRENT_DATE;
BEGIN
  PERFORM public.save_production_material_report(jsonb_build_object('factory_id', f, 'report_date', d3,
    'lines', jsonb_build_array(jsonb_build_object('material_id', m, 'opening', 100000, 'qty_used', 30000))));
  PERFORM public.save_production_material_report(jsonb_build_object('factory_id', f, 'report_date', d4,
    'lines', jsonb_build_array(jsonb_build_object('material_id', m, 'opening', 70000, 'qty_in', 5000, 'qty_used', 10000))));
  PERFORM pg_temp.check((pg_temp.line(d4)).balance = 65000, '4th balance 65,000');

  PERFORM public.save_production_material_report(jsonb_build_object('id', (pg_temp.line(d3)).id,
    'qty_used', 40000, 'damages', 124));
  PERFORM pg_temp.check((pg_temp.line(d3)).balance = 60000, '3rd balance 60,000');
  PERFORM pg_temp.check((pg_temp.line(d4)).opening = 60000 AND (pg_temp.line(d4)).total = 65000
                        AND (pg_temp.line(d4)).balance = 55000, '4th follows: opening 60,000, balance 55,000');
END $$;

-- @@ Test 2: a back-dated day slots in; a change that drives a later day below 0 is refused
DO $$
DECLARE f uuid := 'f9900000-0000-0000-0000-000000000001'; m uuid := 'c9900000-0000-0000-0000-000000000001';
  e text;
BEGIN
  PERFORM public.save_production_material_report(jsonb_build_object('factory_id', f, 'report_date', CURRENT_DATE - 2,
    'lines', jsonb_build_array(jsonb_build_object('material_id', m, 'opening', 120000, 'qty_used', 20000))));
  PERFORM pg_temp.check((pg_temp.line(CURRENT_DATE - 1)).opening = 100000, 'the 3rd opens at the 2nd''s balance');
  PERFORM pg_temp.check((pg_temp.line(CURRENT_DATE)).balance = 55000, 'the 4th unchanged');
  e := pg_temp.err(format($q$SELECT public.save_production_material_report(%L)$q$,
         jsonb_build_object('id', (pg_temp.line(CURRENT_DATE - 1)).id, 'qty_used', 99000)));
  PERFORM pg_temp.check(e LIKE '%below 0%', 'refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((pg_temp.line(CURRENT_DATE)).balance = 55000, 'nothing changed');
END $$;

-- @@ Test 3 (20261110240000): a day entered on its own Opening that can't take the carried
-- balance no longer blocks edits on other days; a linked day pushed below 0 still is refused
DO $$
DECLARE f uuid := 'f9900000-0000-0000-0000-000000000001';
  m uuid := 'c9900000-0000-0000-0000-000000000002';
  d1 date := CURRENT_DATE - 9; d2 date := CURRENT_DATE - 8; d3 date := CURRENT_DATE - 7;
  e text; v_d2 production_material_reports;
BEGIN
  INSERT INTO raw_materials(id, factory_id, name, unit) VALUES (m, f, 'PC Bottle', 'Piece');
  -- d1 ends 18,509; d2 entered by hand on its own Opening 50,000, used 47,020.
  INSERT INTO production_material_reports(factory_id, report_date, material_id, material_name, unit, opening, qty_used)
  VALUES (f, d1, m, 'PC Bottle', 'Piece', 20000, 1491);
  ALTER TABLE production_material_reports DISABLE TRIGGER trg_pm_rechain;
  INSERT INTO production_material_reports(factory_id, report_date, material_id, material_name, unit, opening, qty_used)
  VALUES (f, d2, m, 'PC Bottle', 'Piece', 50000, 47020);
  ALTER TABLE production_material_reports ENABLE TRIGGER trg_pm_rechain;
  PERFORM public.save_production_material_report(jsonb_build_object('factory_id', f, 'report_date', d3,
    'lines', jsonb_build_array(jsonb_build_object('material_id', m, 'opening', 2980, 'qty_in', 1000, 'qty_used', 500))));

  -- Edit d1 (before) and d3 (after): both save; d2 keeps its own Opening.
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d1;
  PERFORM public.save_production_material_report(jsonb_build_object('id', v_d2.id, 'qty_used', 1500));
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d3;
  PERFORM public.save_production_material_report(jsonb_build_object('id', v_d2.id, 'qty_used', 600));
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d2;
  PERFORM pg_temp.check(v_d2.opening = 50000, 'd2 keeps its own opening: ' || v_d2.opening);
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d3;
  PERFORM pg_temp.check(v_d2.opening = 2980 AND v_d2.balance = 3380, 'd3 follows d2: ' || v_d2.balance);

  -- Edit d2 itself (used): saves on its own Opening.
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d2;
  PERFORM public.save_production_material_report(jsonb_build_object('id', v_d2.id, 'qty_used', 47000));
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d3;
  PERFORM pg_temp.check(v_d2.opening = 3000, 'd3 follows d2''s edit: ' || v_d2.opening);

  -- d2 given Qty In: now it can join the chain (opening 18,500).
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d2;
  PERFORM public.save_production_material_report(jsonb_build_object('id', v_d2.id, 'qty_in', 30000));
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d2;
  PERFORM pg_temp.check(v_d2.opening = 18500 AND v_d2.balance = 1500, 'd2 on the chain: ' || v_d2.opening);

  -- Now linked: d1 used up so d2 would go below 0 -> refused.
  SELECT * INTO v_d2 FROM production_material_reports WHERE material_id = m AND report_date = d1;
  e := pg_temp.err(format($q$SELECT public.save_production_material_report(%L)$q$,
         jsonb_build_object('id', v_d2.id, 'qty_used', 19000)));
  PERFORM pg_temp.check(e LIKE '%below 0%', 'linked day refused: ' || COALESCE(e, 'no error'));
END $$;
