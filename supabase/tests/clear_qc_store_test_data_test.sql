-- ============================================================================
-- Acceptance test: clear the QC test data from "Received from Store" and the
-- lists (20261026120000_clear_qc_store_test_data.sql)
--
-- As in the factory: the Store issued preforms to the QC department; QC
-- confirmed them; one preform was moved to Preforms and then undone by the
-- first clean-up (its stock already went back to the Store). Clearing must
-- return the rest to the Store exactly once and empty QC's lists.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('2f000000-0000-0000-0000-000000000001', 'clrqc', 'Clear QC Store Factory');
INSERT INTO auth.users(id, email) VALUES
  ('2a000000-0000-0000-0000-000000000001', 'store@clrqc'),
  ('2a000000-0000-0000-0000-000000000002', 'qc@clrqc');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '2a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '2a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('2a000000-0000-0000-0000-000000000001', 'store_keeper', '2f000000-0000-0000-0000-000000000001'),
  ('2a000000-0000-0000-0000-000000000002', 'qc_officer', '2f000000-0000-0000-0000-000000000001');
INSERT INTO brands(id, factory_id, name, category, grammage) VALUES
  ('2b000000-0000-0000-0000-000000000001', '2f000000-0000-0000-0000-000000000001', 'Preform', 'Bag', '27gr');
-- "Sentric" is a preform only by its brand ("Preform · 27gr").
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform, brand_id) VALUES
  ('2c000000-0000-0000-0000-000000000001', '2f000000-0000-0000-0000-000000000001', 'Preform', 'Piece', 300000, 300000, 1, 1428, true, NULL),
  ('2c000000-0000-0000-0000-000000000002', '2f000000-0000-0000-0000-000000000001', 'Sentric', 'Piece', 20000, 20000, 1, 740, false,
   '2b000000-0000-0000-0000-000000000001'),
  ('2c000000-0000-0000-0000-000000000003', '2f000000-0000-0000-0000-000000000001', 'YUNO MOLD', 'Piece', 50000, 50000, 1, 1600, true, NULL);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '2a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p uuid) RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM raw_materials WHERE id = p $$;

-- @@ Test 1: Received from Store cleared, each piece back in the Store once; lists empty
DO $$
DECLARE msg text; e text;
  qc uuid := '2a000000-0000-0000-0000-000000000002';
  hana uuid := '2c000000-0000-0000-0000-000000000001';
  sentric uuid := '2c000000-0000-0000-0000-000000000002';
  yuno uuid := '2c000000-0000-0000-0000-000000000003';
BEGIN
  -- The Store issues to the QC department (no person), QC confirms everything.
  PERFORM pg_temp.as_user('1');
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', hana, 'quantity', 124236, 'purpose', 'general', 'issued_to_department', 'quality_control'));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', hana, 'quantity', 42840, 'purpose', 'general', 'issued_to_department', 'quality_control'));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', sentric, 'quantity', 5920, 'purpose', 'general', 'issued_to_department', 'quality_control'));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', yuno, 'quantity', 16000, 'purpose', 'general', 'issued_to_department', 'quality_control'));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', yuno, 'quantity', 9600, 'purpose', 'general', 'issued_to_department', 'quality_control'));
  PERFORM pg_temp.as_user('2');
  PERFORM public.qc_confirm_store_receipt(id) FROM qc_store_receipts WHERE material_id IN (hana, sentric, yuno);
  -- QC used 600 YUNO for a test.
  PERFORM public.qc_record_store_usage(jsonb_build_object('material_id', yuno, 'quantity', 600, 'reason', 'Quality test'));
  PERFORM pg_temp.check(pg_temp.stock(hana) = 300000 - 167076 AND pg_temp.stock(sentric) = 14080 AND pg_temp.stock(yuno) = 24400, 'issued');

  -- Hana moved to Preforms, then the first clean-up took it back to the Store.
  PERFORM public.qc_move_preforms_to_blowing(hana);
  PERFORM set_config('test.uid', '', false);
  PERFORM public._clear_preform_activity(now() + interval '1 hour', 'test entries');
  PERFORM pg_temp.check(pg_temp.stock(hana) = 300000, 'Hana already back via Preforms');
  -- The flagging the migration does first.
  UPDATE preform_issues SET test_cleared = true WHERE reversal_reason LIKE 'Test data cleared:%';

  msg := public._clear_qc_store_preforms(now() + interval '1 hour', 'QC store test entries');
  PERFORM pg_temp.check(msg LIKE 'Received from Store cleared: 3 preform(s), 31520 pieces back%', msg);
  PERFORM pg_temp.check(pg_temp.stock(hana) = 300000, 'Hana not returned twice');
  PERFORM pg_temp.check(pg_temp.stock(sentric) = 20000, 'Sentric (preform by brand) back');
  PERFORM pg_temp.check(pg_temp.stock(yuno) = 50000, 'YUNO back, including what QC used in the test');

  -- QC's lists: nothing left to show; nothing deleted.
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM qc_store_receipts WHERE material_id IN (hana, sentric, yuno) AND NOT test_cleared), 'receipts hidden');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM qc_store_usage WHERE material_id IN (hana, sentric, yuno) AND NOT test_cleared), 'usage hidden');
  PERFORM pg_temp.check((SELECT count(*) FROM qc_store_receipts WHERE material_id IN (hana, sentric, yuno)) = 5, 'rows kept');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM preform_issues WHERE material_id = hana AND NOT test_cleared), 'preform issue hidden');

  -- Nothing left for QC to use or move; running again changes nothing.
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT public.qc_move_preforms_to_blowing('2c000000-0000-0000-0000-000000000003')$q$);
  PERFORM pg_temp.check(e LIKE '%Nothing of%left%', 'cannot move cleared stock: ' || COALESCE(e, 'no error'));
  PERFORM set_config('test.uid', '', false);
  msg := public._clear_qc_store_preforms(now() + interval '1 hour', 'again');
  PERFORM pg_temp.check(msg LIKE 'Received from Store cleared: 0 preform(s), 0 pieces%', msg);
END $$;

-- @@ Test 2: a new issue afterwards counts from zero (cleared use is not subtracted); Sentric can be moved by its brand
DO $$
DECLARE v jsonb;
  qc uuid := '2a000000-0000-0000-0000-000000000002';
  sentric uuid := '2c000000-0000-0000-0000-000000000002';
  yuno uuid := '2c000000-0000-0000-0000-000000000003';
BEGIN
  PERFORM pg_temp.as_user('1');
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', yuno, 'quantity', 1600, 'purpose', 'general', 'issued_to_department', 'quality_control'));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', sentric, 'quantity', 740, 'purpose', 'general', 'issued_to_department', 'quality_control'));
  PERFORM pg_temp.as_user('2');
  PERFORM public.qc_confirm_store_receipt(id) FROM qc_store_receipts WHERE material_id = yuno AND status = 'pending';
  v := public.qc_record_store_usage(jsonb_build_object('material_id', yuno, 'quantity', 1600, 'reason', 'Quality test'));
  PERFORM pg_temp.check((v->>'available')::numeric = 0, 'all 1600 available, old test use not subtracted: ' || v::text);
  v := public.qc_move_preforms_to_blowing(sentric);
  PERFORM pg_temp.check((v->>'pieces')::numeric = 740, 'Sentric moved by its brand: ' || v::text);
END $$;
