-- ============================================================================
-- Acceptance test: QC moves preforms stuck in "Received from Store" onto her
-- blowing stock and blows them (20261026100000_qc_move_preforms_to_blowing.sql)
--
-- One preform issued the old way to QC with no pieces per bag (skipped by
-- the one-time move): one line still awaiting confirmation, one confirmed and
-- partly used. Runs as supabase/tests/pglite/README.md describes.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('4f000000-0000-0000-0000-000000000001', 'mvbl', 'Move To Blowing Factory');
INSERT INTO auth.users(id, email) VALUES
  ('4a000000-0000-0000-0000-000000000001', 'store@mvbl'),
  ('4a000000-0000-0000-0000-000000000002', 'qc@mvbl'),
  ('4a000000-0000-0000-0000-000000000003', 'pm@mvbl');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '4a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '4a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('4a000000-0000-0000-0000-000000000001', 'store_keeper', '4f000000-0000-0000-0000-000000000001'),
  ('4a000000-0000-0000-0000-000000000002', 'qc_officer', '4f000000-0000-0000-0000-000000000001'),
  ('4a000000-0000-0000-0000-000000000003', 'production', '4f000000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('4d000000-0000-0000-0000-000000000050', '4f000000-0000-0000-0000-000000000001', '50cl Bottle', 'Piece', 0, 0, 'semi_finished');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform) VALUES
  ('4c000000-0000-0000-0000-000000000001', '4f000000-0000-0000-0000-000000000001', 'YUNO MOLD Preform 12.5g', 'Piece', 10000, 10000, 1, NULL, true),
  ('4c000000-0000-0000-0000-000000000002', '4f000000-0000-0000-0000-000000000001', 'Bottle Caps', 'Piece', 1000, 1000, 1, NULL, false);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '4a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: stuck lines move once into her blowing stock; she blows them; only good bottles stocked
DO $$
DECLARE v jsonb; e text; r record;
  qc uuid := '4a000000-0000-0000-0000-000000000002';
  yuno uuid := '4c000000-0000-0000-0000-000000000001';
  store_before numeric;
BEGIN
  -- The old way, to the QC department: 3,200 confirmed (100 used), 1,600 still awaiting.
  PERFORM pg_temp.as_user('1');
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', yuno, 'quantity', 3200, 'purpose', 'general',
            'issued_to_department', 'quality_control', 'issued_to_user', qc));
  PERFORM public.issue_raw_material(jsonb_build_object('material_id', yuno, 'quantity', 1600, 'purpose', 'general',
            'issued_to_department', 'quality_control', 'issued_to_user', qc));
  PERFORM pg_temp.as_user('2');
  PERFORM public.qc_confirm_store_receipt((SELECT id FROM qc_store_receipts WHERE material_id = yuno AND quantity = 3200));
  PERFORM public.qc_record_store_usage(jsonb_build_object('material_id', yuno, 'quantity', 100, 'reason', 'Quality test'));
  store_before := (SELECT current_stock FROM raw_materials WHERE id = yuno);

  -- Not a preform / no bag size / not QC.
  e := pg_temp.err($q$SELECT public.qc_move_preforms_to_blowing('4c000000-0000-0000-0000-000000000002', 100)$q$);
  PERFORM pg_temp.check(e LIKE '%is not a preform%', 'caps refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.qc_move_preforms_to_blowing('4c000000-0000-0000-0000-000000000001')$q$);
  PERFORM pg_temp.check(e LIKE '%pieces per bag%', 'bag size needed: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err($q$SELECT public.qc_move_preforms_to_blowing('4c000000-0000-0000-0000-000000000001', 1600)$q$);
  PERFORM pg_temp.check(e LIKE '%Quality Control person%', 'production refused: ' || COALESCE(e, 'no error'));

  PERFORM pg_temp.as_user('2');
  v := public.qc_move_preforms_to_blowing(yuno, 1600);
  PERFORM pg_temp.check((v->>'pieces')::numeric = 4700 AND (v->>'from_pending')::numeric = 1600
                        AND (v->>'from_confirmed')::numeric = 3100, 'moved 1600 awaiting + 3100 unused: ' || v::text);
  PERFORM pg_temp.check((SELECT pieces_per_bag FROM raw_materials WHERE id = yuno) = 1600, 'bag size set');
  SELECT * INTO r FROM preform_issues WHERE id = (v->>'id')::uuid;
  PERFORM pg_temp.check(r.status = 'accepted' AND r.operator_id = qc AND r.bags = 2 AND r.loose_pieces = 1500,
                        '4700 = 2 bags + 1500: ' || row_to_json(r)::text);
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE operator_id = qc AND material_id = yuno) = 4700, 'in her blowing stock');
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = yuno) = store_before, 'Store untouched');
  -- Nothing left in the general store for this preform; a second move is refused.
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM qc_store_receipts WHERE material_id = yuno AND status = 'pending'), 'no line awaiting');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM qc_store_receipts WHERE material_id = yuno AND status = 'confirmed')
                        - (SELECT SUM(quantity) FROM qc_store_usage WHERE material_id = yuno) = 0, 'general store available 0');
  e := pg_temp.err($q$SELECT public.qc_move_preforms_to_blowing('4c000000-0000-0000-0000-000000000001')$q$);
  PERFORM pg_temp.check(e LIKE '%Nothing of%left%', 'moved once: ' || COALESCE(e, 'no error'));

  -- She blows them on Process preforms: 4,000 blown, 40 damaged -> 3,960 good.
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', yuno, 'production_date', public._pf_today(),
         'shift', 'day', 'good_bottles', 3960, 'damaged_bottles', 40, 'client_ref', '4a900000-0000-0000-0000-000000000001'));
  PERFORM public.set_shift_bottle_by_name((v->>'id')::uuid, '50cl Bottle');
  v := public.submit_preform_shift((v->>'id')::uuid);
  PERFORM pg_temp.check(v->>'status' = 'completed' AND (v->>'stocked')::numeric = 3960, 'blown: ' || v::text);
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE operator_id = qc AND material_id = yuno) = 700, '700 left to blow');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = '4d000000-0000-0000-0000-000000000050') = 3960, 'only good bottles');
END $$;
