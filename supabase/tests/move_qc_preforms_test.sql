-- ============================================================================
-- Acceptance test: preforms in "Received from Store" move to QC → Preforms
-- (20261023230000_move_qc_preforms_to_preform_page.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Two preforms issued the old way (Issue
-- Stock to a QC person): one still awaiting confirmation, one confirmed and
-- partly used. The same function the migration ran is run again here.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('5f000000-0000-0000-0000-000000000001', 'mvpf', 'Move Preforms Factory');
INSERT INTO auth.users(id, email) VALUES
  ('5a000000-0000-0000-0000-000000000001', 'store@mvpf'),
  ('5a000000-0000-0000-0000-000000000002', 'qc@mvpf');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '5a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '5a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('5a000000-0000-0000-0000-000000000001', 'store_keeper', '5f000000-0000-0000-0000-000000000001'),
  ('5a000000-0000-0000-0000-000000000002', 'qc_officer', '5f000000-0000-0000-0000-000000000001');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform) VALUES
  ('5c000000-0000-0000-0000-000000000001', '5f000000-0000-0000-0000-000000000001', 'Hana', 'Piece', 14280, 14280, 1, 1428, true),
  ('5c000000-0000-0000-0000-000000000002', '5f000000-0000-0000-0000-000000000001', 'Preform 29mm', 'Piece', 11520, 11520, 1, 1152, true);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '5a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: awaiting -> preform issue to accept; confirmed -> blowing stock (what is left)
DO $$
DECLARE msg text; r record;
  qc uuid := '5a000000-0000-0000-0000-000000000002';
  hana uuid := '5c000000-0000-0000-0000-000000000001';
  p29 uuid := '5c000000-0000-0000-0000-000000000002';
BEGIN
  -- The old way: Issue Stock of preforms to the QC person.
  PERFORM pg_temp.as_user('1');
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', hana, 'quantity', 2856, 'purpose', 'general',
            'issued_to_department', 'quality_control', 'issued_to_user', qc));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', p29, 'quantity', 2304, 'purpose', 'general',
            'issued_to_department', 'quality_control', 'issued_to_user', qc));
  -- QC confirms the 29mm and uses 304 of it; the Hana stays awaiting.
  PERFORM pg_temp.as_user('2');
  PERFORM public.qc_confirm_store_receipt((SELECT id FROM qc_store_receipts WHERE material_id = p29));
  PERFORM public.qc_record_store_usage(jsonb_build_object('material_id', p29, 'quantity', 304, 'reason', 'Quality test'));

  msg := public._move_qc_preforms_to_blowing();
  PERFORM pg_temp.check(msg LIKE 'Moved to Preforms: 1 awaiting acceptance, 1 already confirmed.%', msg);

  -- Hana: a preform issue waiting for her, the old line marked moved.
  SELECT * INTO r FROM preform_issues WHERE material_id = hana;
  PERFORM pg_temp.check(r.status = 'issued' AND r.operator_id = qc AND r.pieces = 2856 AND r.bags = 2 AND r.loose_pieces = 0,
                        'Hana awaiting her: ' || row_to_json(r)::text);
  PERFORM pg_temp.check((SELECT status = 'moved' AND moved_to_issue = r.id FROM qc_store_receipts WHERE material_id = hana),
                        'old Hana line moved');
  -- Preform 29mm: the 2,000 she still had are in her blowing stock.
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE operator_id = qc AND material_id = p29) = 2000,
                        'blowing stock 2000');
  PERFORM pg_temp.check((SELECT status FROM preform_issues WHERE material_id = p29) = 'accepted', 'already accepted');
  -- Not counted twice: nothing left in the general QC store.
  PERFORM pg_temp.check(
    (SELECT SUM(quantity) FROM qc_store_receipts WHERE material_id = p29 AND status = 'confirmed')
    - (SELECT SUM(quantity) FROM qc_store_usage WHERE material_id = p29) = 0, 'general QC store emptied');
  -- The Store was not charged again.
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = hana) = 14280 - 2856
                        AND (SELECT current_stock FROM raw_materials WHERE id = p29) = 11520 - 2304, 'Store unchanged');

  -- She accepts the Hana on the Preforms page like any issue.
  PERFORM public.respond_preform_issue(r.id, true);
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE operator_id = qc AND material_id = hana) = 2856,
                        'Hana in her blowing stock after accepting');

  -- Running it again moves nothing more.
  msg := public._move_qc_preforms_to_blowing();
  PERFORM pg_temp.check(msg LIKE 'Moved to Preforms: 0 awaiting acceptance, 0 already confirmed.%', 'idempotent: ' || msg);
END $$;
