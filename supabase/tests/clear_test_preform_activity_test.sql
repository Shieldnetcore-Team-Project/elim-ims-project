-- ============================================================================
-- Acceptance test: undo the test preform activity
-- (20261026110000_clear_test_preform_activity.sql)
--
-- Builds what the factory tested -- preforms issued to QC, blown, good
-- bottles stocked, issued to PM and received, some rejected at PM -- then
-- runs the same undo the migration ran. Everything returns: Store stock,
-- bottle stock, PM stock, QC's balance; the reports are empty; nothing is
-- deleted. Bottle Caps do not show on the all-preforms list.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('3f000000-0000-0000-0000-000000000001', 'clrpf', 'Clear Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('3a000000-0000-0000-0000-000000000001', 'store@clrpf'),
  ('3a000000-0000-0000-0000-000000000002', 'qc@clrpf'),
  ('3a000000-0000-0000-0000-000000000003', 'pm@clrpf');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '3a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '3a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('3a000000-0000-0000-0000-000000000001', 'store_keeper', '3f000000-0000-0000-0000-000000000001'),
  ('3a000000-0000-0000-0000-000000000002', 'qc_officer', '3f000000-0000-0000-0000-000000000001'),
  ('3a000000-0000-0000-0000-000000000003', 'production', '3f000000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('3d000000-0000-0000-0000-000000000050', '3f000000-0000-0000-0000-000000000001', '50cl Bottle', 'Piece', 0, 0, 'semi_finished');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform) VALUES
  ('3c000000-0000-0000-0000-000000000001', '3f000000-0000-0000-0000-000000000001', 'Preform', 'Piece', 200000, 200000, 1, 1428, true),
  ('3c000000-0000-0000-0000-000000000002', '3f000000-0000-0000-0000-000000000001', 'Prima', 'Piece', 120000, 120000, 1, 1428, true),
  ('3c000000-0000-0000-0000-000000000003', '3f000000-0000-0000-0000-000000000001', 'Bottle Cap', 'Piece', 378000, 378000, 1, 9000, false);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '3a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: everything undone, nothing deleted, reports empty
DO $$
DECLARE v jsonb; t uuid; msg text; n int;
  f uuid := '3f000000-0000-0000-0000-000000000001';
  qc uuid := '3a000000-0000-0000-0000-000000000002';
  hana uuid := '3c000000-0000-0000-0000-000000000001';
  prima uuid := '3c000000-0000-0000-0000-000000000002';
  b50 uuid := '3d000000-0000-0000-0000-000000000050';
  rows_before int;
BEGIN
  -- Hana 117 bags issued, accepted, nothing blown. Prima 70 bags, blown in two sessions.
  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', hana, 'operator_id', qc, 'bags', 117));
  PERFORM pg_temp.as_user('2'); PERFORM public.respond_preform_issue((v->>'id')::uuid, true);
  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', prima, 'operator_id', qc, 'bags', 70));
  PERFORM pg_temp.as_user('2'); PERFORM public.respond_preform_issue((v->>'id')::uuid, true);
  -- A third issue never accepted.
  PERFORM pg_temp.as_user('1');
  PERFORM public.issue_preforms(jsonb_build_object('material_id', prima, 'operator_id', qc, 'bags', 1));

  PERFORM pg_temp.as_user('2');
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', prima, 'production_date', public._pf_today(),
         'shift', 'day', 'good_bottles', 20000, 'damaged_bottles', 40));
  PERFORM public.set_shift_bottle_by_name((v->>'id')::uuid, '50cl Bottle');
  PERFORM public.submit_preform_shift((v->>'id')::uuid);
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', prima, 'production_date', public._pf_today(),
         'shift', 'night', 'good_bottles', 13264, 'damaged_bottles', 32));
  PERFORM public.set_shift_bottle_by_name((v->>'id')::uuid, '50cl Bottle');
  PERFORM public.submit_preform_shift((v->>'id')::uuid);
  -- A draft left behind.
  PERFORM public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', hana, 'production_date', public._pf_today(),
         'shift', 'day', 'good_bottles', 5));

  -- 10,000 to PM, received, 25 rejected; 2,000 more still on the way.
  v := public.dispatch_bottle_transfer(jsonb_build_object('product_id', b50, 'quantity', 10000, 'to_department', 'PM'));
  t := (v->>'id')::uuid;
  PERFORM public.dispatch_bottle_transfer(jsonb_build_object('product_id', b50, 'quantity', 2000, 'to_department', 'PM'));
  PERFORM pg_temp.as_user('3');
  PERFORM public.receive_bottle_transfer(t, 10000);
  PERFORM public.record_bottle_rejection(jsonb_build_object('transfer_id', t, 'quantity', 25, 'reason', 'leaking'));

  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b50) = 33264 - 12000, 'bottles before');
  rows_before := (SELECT count(*) FROM preform_issues WHERE factory_id = f)
               + (SELECT count(*) FROM preform_shift_records WHERE factory_id = f)
               + (SELECT count(*) FROM preform_stockings WHERE factory_id = f)
               + (SELECT count(*) FROM bottle_transfers WHERE factory_id = f);

  -- The undo, as the migration runs it (no signed-in user).
  PERFORM set_config('test.uid', '', false);
  msg := public._clear_preform_activity(now() + interval '1 hour', 'test');
  PERFORM pg_temp.check(msg LIKE 'Undone: 1 PM rejection(s), 2 issue(s) to PM, 2 stocking(s), 3 blowing record(s), 3 Store issue(s)%', msg);

  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = hana) = 200000, 'Hana back in the Store');
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = prima) = 120000, 'Prima back in the Store');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b50) = 0, 'no good bottles left');
  PERFORM pg_temp.check((SELECT quantity FROM department_stock WHERE factory_id = f AND product_id = b50) = 0, 'PM holds none');
  PERFORM pg_temp.check((SELECT COALESCE(SUM(quantity), 0) FROM preform_holdings WHERE factory_id = f) = 0, 'QC holds none');
  -- Nothing deleted.
  PERFORM pg_temp.check(rows_before = (SELECT count(*) FROM preform_issues WHERE factory_id = f)
               + (SELECT count(*) FROM preform_shift_records WHERE factory_id = f)
               + (SELECT count(*) FROM preform_stockings WHERE factory_id = f)
               + (SELECT count(*) FROM bottle_transfers WHERE factory_id = f), 'every row kept');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM preform_issues WHERE factory_id = f AND status IN ('issued', 'accepted'))
                    AND NOT EXISTS (SELECT 1 FROM preform_shift_records WHERE factory_id = f AND status <> 'reversed'),
                        'all reversed / cancelled');

  -- Reports empty.
  PERFORM pg_temp.as_user('2');
  SELECT count(*) INTO n FROM public.preform_daily_report(f, public._pf_today() - 30, public._pf_today())
   WHERE opening <> 0 OR received <> 0 OR usage <> 0 OR closing <> 0;
  PERFORM pg_temp.check(n = 0, 'Process preforms rows all zero: ' || n);
  PERFORM pg_temp.check((SELECT bool_and(issued = 0 AND blown = 0 AND good = 0 AND qc_holds = 0)
                           FROM public.qc_preform_overview(f)), 'Store-to-PM list all zero');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.qc_preform_overview(f) WHERE material = 'Bottle Cap'), 'Bottle Cap not a preform');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.qc_bottle_report(f, public._pf_today() - 30, public._pf_today())
                                      WHERE quantity_in <> 0 OR released <> 0), 'bottles report empty');

  -- Run again: nothing more to undo.
  PERFORM set_config('test.uid', '', false);
  msg := public._clear_preform_activity(now() + interval '1 hour', 'test');
  PERFORM pg_temp.check(msg LIKE 'Undone: 0 PM rejection(s), 0 issue(s) to PM, 0 stocking(s), 0 blowing record(s), 0 Store issue(s)%', msg);
END $$;

-- @@ Test 2: anything recorded after the cut-off is left alone
DO $$
DECLARE v jsonb; msg text;
  qc uuid := '3a000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', '3c000000-0000-0000-0000-000000000002', 'operator_id', qc, 'bags', 1));
  PERFORM set_config('test.uid', '', false);
  msg := public._clear_preform_activity(now() - interval '1 hour', 'test');
  PERFORM pg_temp.check((SELECT status FROM preform_issues WHERE id = (v->>'id')::uuid) = 'issued', 'new issue untouched: ' || msg);
END $$;
