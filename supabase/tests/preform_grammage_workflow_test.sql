-- ============================================================================
-- Acceptance test: preform → blown bottle → PM, per grammage
-- (20261025090000_preform_grammage_workflow.sql)
--
-- Store issues three 50cl preform grammages (12 g, 12.5 g, 13 g) to QC, in
-- bags; QC blows several sessions in the same day (and two in the same
-- shift); only good bottles reach the 50cl bottle stock; QC issues to PM;
-- PM receives and rejects some bottles at the PM stage; reports keep every
-- grammage row; corrections keep the original.
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('9f000000-0000-0000-0000-000000000001', 'pfgram', 'Grammage Factory');
INSERT INTO auth.users(id, email) VALUES
  ('9a000000-0000-0000-0000-000000000001', 'store@pfgram'),
  ('9a000000-0000-0000-0000-000000000002', 'qc@pfgram'),
  ('9a000000-0000-0000-0000-000000000003', 'pm@pfgram'),
  ('9a000000-0000-0000-0000-000000000004', 'manager@pfgram'),
  ('9a000000-0000-0000-0000-000000000005', 'auditor@pfgram');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '9a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
INSERT INTO roles(slug, label, is_system) VALUES ('test_gram_manager', 'Production Manager (gram test)', false)
  ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'test_gram_manager', 'preform-production', a
  FROM unnest(ARRAY['view','create','edit','submit','print','export','reverse']::action_key[]) a
  ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id::text LIKE '9a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('9a000000-0000-0000-0000-000000000001', 'store_keeper', '9f000000-0000-0000-0000-000000000001'),
  ('9a000000-0000-0000-0000-000000000002', 'qc_officer', '9f000000-0000-0000-0000-000000000001'),
  ('9a000000-0000-0000-0000-000000000003', 'production', '9f000000-0000-0000-0000-000000000001'),
  ('9a000000-0000-0000-0000-000000000004', 'test_gram_manager', '9f000000-0000-0000-0000-000000000001'),
  ('9a000000-0000-0000-0000-000000000005', 'auditor', '9f000000-0000-0000-0000-000000000001');

INSERT INTO suppliers(id, factory_id, name) VALUES
  ('9e000000-0000-0000-0000-000000000001', '9f000000-0000-0000-0000-000000000001', 'Gram Plastics');
INSERT INTO brands(id, factory_id, name, category, grammage, supplier_id) VALUES
  ('9b000000-0000-0000-0000-000000000012', '9f000000-0000-0000-0000-000000000001', 'Sentric', 'Bag', '12g', '9e000000-0000-0000-0000-000000000001'),
  ('9b000000-0000-0000-0000-000000000125', '9f000000-0000-0000-0000-000000000001', 'Sentric', 'Bag', '12.5g', '9e000000-0000-0000-0000-000000000001'),
  ('9b000000-0000-0000-0000-000000000013', '9f000000-0000-0000-0000-000000000001', 'KRS', 'Bag', '13g', NULL);
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('9d000000-0000-0000-0000-000000000050', '9f000000-0000-0000-0000-000000000001', '50cl Bottle', 'Piece', 0, 0, 'semi_finished');
-- Different bag sizes on purpose: the conversion is never assumed.
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform, brand_id) VALUES
  ('9c000000-0000-0000-0000-000000000012', '9f000000-0000-0000-0000-000000000001', 'Preform 12g', 'Piece', 5000, 5000, 1, 500, true, '9b000000-0000-0000-0000-000000000012'),
  ('9c000000-0000-0000-0000-000000000125', '9f000000-0000-0000-0000-000000000001', 'Preform 12.5g', 'Piece', 4800, 4800, 1, 1200, true, '9b000000-0000-0000-0000-000000000125'),
  ('9c000000-0000-0000-0000-000000000013', '9f000000-0000-0000-0000-000000000001', 'Preform 13g', 'Piece', 3000, 3000, 1, 1000, true, '9b000000-0000-0000-0000-000000000013');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '9a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE TEMP TABLE ids(k text PRIMARY KEY, id uuid);
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = p $$;
-- One QC blowing session: save + bottle + submit, as the Preforms tab does.
CREATE OR REPLACE FUNCTION pg_temp.blow(p_key text, p_material uuid, p_shift text, p_blown int, p_damaged int, p_client uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := public.save_preform_shift(jsonb_build_object('operator_id', '9a000000-0000-0000-0000-000000000002',
         'material_id', p_material, 'production_date', public._pf_today(), 'shift', p_shift,
         'good_bottles', p_blown - p_damaged, 'damaged_bottles', p_damaged, 'client_ref', p_client));
  INSERT INTO ids VALUES (p_key, (v->>'id')::uuid) ON CONFLICT (k) DO UPDATE SET id = EXCLUDED.id;
  IF v->>'status' <> 'draft' THEN RETURN v; END IF;
  PERFORM public.set_shift_bottle_by_name((v->>'id')::uuid, '50cl Bottle');
  RETURN public.submit_preform_shift((v->>'id')::uuid);
END;
$$;

-- @@ Test 1 (acceptance 1, 2, 4): Store issues each grammage in bags using its own factor; QC sees and accepts them
DO $$
DECLARE v jsonb; e text;
  qc uuid := '9a000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM pg_temp.as_user('1');
  -- 12 g: 500 per bag, 2 bags + 0 loose = 1,000. 12.5 g: 1,200 per bag, 1 bag + 300 = 1,500. 13 g: 1 bag = 1,000.
  v := public.issue_preforms(jsonb_build_object('material_id', '9c000000-0000-0000-0000-000000000012', 'operator_id', qc,
         'bags', 2, 'loose_pieces', 0, 'client_ref', '9a100000-0000-0000-0000-000000000001'));
  INSERT INTO ids VALUES ('iss12', (v->>'id')::uuid);
  PERFORM pg_temp.check((v->>'pieces')::numeric = 1000, '2 bags x 500 = 1000');
  -- The same issue posted twice is one issue.
  v := public.issue_preforms(jsonb_build_object('material_id', '9c000000-0000-0000-0000-000000000012', 'operator_id', qc,
         'bags', 2, 'loose_pieces', 0, 'client_ref', '9a100000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check((v->>'duplicate')::boolean AND (v->>'id')::uuid = pg_temp.id('iss12'), 'duplicate issue not posted twice');
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = '9c000000-0000-0000-0000-000000000012') = 4000, 'Store down by 1000 once');

  v := public.issue_preforms(jsonb_build_object('material_id', '9c000000-0000-0000-0000-000000000125', 'operator_id', qc,
         'bags', 1, 'loose_pieces', 300));
  INSERT INTO ids VALUES ('iss125', (v->>'id')::uuid);
  PERFORM pg_temp.check((v->>'pieces')::numeric = 1500, '1 bag x 1200 + 300 loose = 1500');
  v := public.issue_preforms(jsonb_build_object('material_id', '9c000000-0000-0000-0000-000000000013', 'operator_id', qc, 'bags', 1));
  INSERT INTO ids VALUES ('iss13', (v->>'id')::uuid);

  -- More than the Store holds is refused.
  e := pg_temp.err($q$SELECT public.issue_preforms(jsonb_build_object('material_id','9c000000-0000-0000-0000-000000000013',
        'operator_id','9a000000-0000-0000-0000-000000000002','bags',3))$q$);
  PERFORM pg_temp.check(e LIKE '%Not enough%', 'over-issue refused: ' || COALESCE(e, 'no error'));

  PERFORM pg_temp.as_user('2');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM preform_issues WHERE operator_id = qc AND status = 'issued') = 3, 'QC sees three issues');
  PERFORM public.respond_preform_issue(pg_temp.id('iss12'), true);
  PERFORM public.respond_preform_issue(pg_temp.id('iss125'), true);
  PERFORM public.respond_preform_issue(pg_temp.id('iss13'), true);
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE operator_id = qc AND material_id = '9c000000-0000-0000-0000-000000000012') = 1000, '12 g held separately');
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE operator_id = qc AND material_id = '9c000000-0000-0000-0000-000000000125') = 1500, '12.5 g held separately');
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE operator_id = qc AND material_id = '9c000000-0000-0000-0000-000000000013') = 1000, '13 g held separately');
END $$;

-- @@ Test 2 (acceptance 3, 5, 6, 7, 9): 500 blown with 10 damaged gives 490 good; two sessions in one shift; posted once
DO $$
DECLARE v jsonb; r record;
  qc uuid := '9a000000-0000-0000-0000-000000000002';
  m12 uuid := '9c000000-0000-0000-0000-000000000012';
  b50 uuid := '9d000000-0000-0000-0000-000000000050';
BEGIN
  PERFORM pg_temp.as_user('2');
  v := pg_temp.blow('s12a', m12, 'day', 500, 10, '9a200000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(v->>'status' = 'completed' AND (v->>'stocked')::numeric = 490, '490 good stocked: ' || v::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b50) = 490, 'only 490 in the 50cl bottle stock');
  SELECT * INTO r FROM preform_shift_records WHERE id = pg_temp.id('s12a');
  PERFORM pg_temp.check(r.damaged_bottles = 10 AND r.good_bottles = 490 AND r.usage_qty = 500, 'damage stays on the blowing record');
  PERFORM pg_temp.check((SELECT -quantity FROM preform_movements WHERE shift_record_id = r.id AND movement_type = 'damaged_bottles') = 10,
                        'the 10 damaged are a preform-ledger line against the 12 g preform');
  PERFORM pg_temp.check(r.opening_qty = 0 AND r.issued_qty = 1000 AND r.available_qty = 1000 AND r.expected_remaining = 500,
                        'opening 0 + received 1000 = 1000; 500 unprocessed');

  -- The same session submitted again (retry / double click) posts nothing.
  v := pg_temp.blow('s12a_again', m12, 'day', 500, 10, '9a200000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check((v->>'duplicate')::boolean AND pg_temp.id('s12a_again') = pg_temp.id('s12a'), 'duplicate session not posted: ' || v::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b50) = 490, 'still 490');

  -- A second session in the same day shift on the same grammage is allowed.
  v := pg_temp.blow('s12b', m12, 'day', 300, 5, '9a200000-0000-0000-0000-000000000002');
  SELECT * INTO r FROM preform_shift_records WHERE id = pg_temp.id('s12b');
  PERFORM pg_temp.check(r.opening_qty = 500 AND r.issued_qty = 0 AND r.available_qty = 500 AND r.expected_remaining = 200,
                        'second session opens with what the first left: ' || row_to_json(r)::text);

  -- Other grammages the same day keep their own records.
  PERFORM pg_temp.blow('s125', '9c000000-0000-0000-0000-000000000125', 'day', 1200, 20, '9a200000-0000-0000-0000-000000000003');
  PERFORM pg_temp.blow('s13', '9c000000-0000-0000-0000-000000000013', 'night', 800, 0, '9a200000-0000-0000-0000-000000000004');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b50) = 490 + 295 + 1180 + 800, '50cl bottle stock = good only');
END $$;

-- @@ Test 3 (acceptance 8): more than is held is refused and moves nothing
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT pg_temp.blow('over', '9c000000-0000-0000-0000-000000000012', 'night', 201, 0, '9a200000-0000-0000-0000-000000000009')$q$);
  PERFORM pg_temp.check(e LIKE '%Short by 1 pieces%', 'over-use refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE material_id = '9c000000-0000-0000-0000-000000000012') = 200, '12 g still 200');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = '9d000000-0000-0000-0000-000000000050') = 2765, 'bottle stock unchanged');
END $$;

-- @@ Test 4 (acceptance 13, 14): grammage report keeps one row per session and grammage, with bags, totals and zero variance
DO $$
DECLARE r record; n int;
  f uuid := '9f000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.as_user('5');  -- the auditor reads it
  SELECT COUNT(*) INTO n FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today());
  PERFORM pg_temp.check(n = 4, 'four sessions, none merged: ' || n);
  SELECT COUNT(DISTINCT grammage) INTO n FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today());
  PERFORM pg_temp.check(n = 3, 'three grammages');
  PERFORM pg_temp.check((SELECT bool_and(capacity = '50cl') FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today())), 'capacity 50cl');

  SELECT * INTO r FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today()) WHERE id = pg_temp.id('s12a');
  PERFORM pg_temp.check(r.grammage = '12g' AND r.supplier = 'Gram Plastics' AND r.pieces_per_bag = 500, 'specification: ' || row_to_json(r)::text);
  PERFORM pg_temp.check(r.received_bags = 2 AND r.received_loose = 0 AND r.received_pieces = 1000, 'received 2 bags = 1000');
  PERFORM pg_temp.check(r.opening_qty + r.received_pieces = r.available_qty, 'opening + received = available');
  PERFORM pg_temp.check(r.processed = 500 AND r.damaged_bottles = 10 AND r.good_bottles = 490 AND r.closing_qty = 500, 'processed / damage / good / closing');
  PERFORM pg_temp.check(r.stocked = 490 AND r.stock_variance = 0 AND r.ledger_variance = 0, 'reconciled: ' || row_to_json(r)::text);

  SELECT * INTO r FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today()) WHERE id = pg_temp.id('s125');
  PERFORM pg_temp.check(r.received_bags = 1 AND r.received_loose = 300 AND r.pieces_per_bag = 1200, '12.5 g: 1 bag + 300 at 1200/bag');

  -- Filters.
  SELECT COUNT(*) INTO n FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today(), p_grammage => '12 g');
  PERFORM pg_temp.check(n = 2, 'grammage filter ignores spacing: ' || n);
  SELECT COUNT(*) INTO n FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today(), p_shift => 'night');
  PERFORM pg_temp.check(n = 1, 'shift filter');
  SELECT COUNT(*) INTO n FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today(), p_supplier => '9e000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(n = 3, 'supplier filter (13 g has none)');
  SELECT COUNT(*) INTO n FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today(), p_capacity => '75cl');
  PERFORM pg_temp.check(n = 0, 'capacity filter');

  -- Combined 50cl bottles keep the grammage breakdown underneath.
  SELECT COUNT(*) INTO n FROM public.bottle_source_breakdown(f, public._pf_today(), public._pf_today());
  PERFORM pg_temp.check(n = 3, 'three source grammages for 50cl');
  PERFORM pg_temp.check((SELECT SUM(good_in_period) FROM public.bottle_source_breakdown(f, public._pf_today(), public._pf_today())) = 2765,
                        'breakdown adds up to the bottle stock in');
  PERFORM pg_temp.check((SELECT good_in_period FROM public.bottle_source_breakdown(f, public._pf_today(), public._pf_today()) WHERE grammage = '12g') = 785,
                        '12 g: 490 + 295');
END $$;

-- @@ Test 5 (acceptance 10, 11): bottle stock report; issue to PM from bottle stock only, within requested and in stock
DO $$
DECLARE v jsonb; e text; r record;
  f uuid := '9f000000-0000-0000-0000-000000000001';
  b50 uuid := '9d000000-0000-0000-0000-000000000050';
BEGIN
  PERFORM pg_temp.as_user('2');
  SELECT * INTO r FROM public.bottle_stock_report(f, public._pf_today(), public._pf_today()) WHERE product_id = b50;
  PERFORM pg_temp.check(r.opening = 0 AND r.from_blowing = 2765 AND r.issued_to_pm = 0 AND r.closing = 2765 AND r.current_stock = 2765,
                        'bottle report before PM: ' || row_to_json(r)::text);

  e := pg_temp.err($q$SELECT public.dispatch_bottle_transfer(jsonb_build_object('product_id','9d000000-0000-0000-0000-000000000050',
        'quantity', 1100, 'quantity_requested', 1000, 'to_department', 'PM'))$q$);
  PERFORM pg_temp.check(e LIKE '%only 1000 were requested%', 'not more than requested: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.dispatch_bottle_transfer(jsonb_build_object('product_id','9d000000-0000-0000-0000-000000000050',
        'quantity', 3000, 'to_department', 'PM'))$q$);
  PERFORM pg_temp.check(e LIKE '%Not enough%', 'not more than in bottle stock: ' || COALESCE(e, 'no error'));

  v := public.dispatch_bottle_transfer(jsonb_build_object('product_id', b50, 'quantity', 1000, 'quantity_requested', 1000,
         'to_department', 'PM', 'shift', 'day', 'production_reference', 'BATCH-50CL-01',
         'client_ref', '9a300000-0000-0000-0000-000000000001'));
  INSERT INTO ids VALUES ('t1', (v->>'id')::uuid);
  v := public.dispatch_bottle_transfer(jsonb_build_object('product_id', b50, 'quantity', 1000, 'to_department', 'PM',
         'client_ref', '9a300000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check((v->>'duplicate')::boolean, 'issue to PM posted once');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b50) = 1765, 'bottle stock down 1000');
  SELECT * INTO r FROM bottle_transfers WHERE id = pg_temp.id('t1');
  PERFORM pg_temp.check(r.quantity_requested = 1000 AND r.shift = 'day' AND r.production_reference = 'BATCH-50CL-01', 'issue details kept');

  -- PM receives; never more than issued.
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format('SELECT public.receive_bottle_transfer(%L, 1001)', pg_temp.id('t1')));
  PERFORM pg_temp.check(e LIKE '%cannot be more%', 'PM cannot receive more than issued: ' || COALESCE(e, 'no error'));
  PERFORM public.receive_bottle_transfer(pg_temp.id('t1'), 1000);
  PERFORM pg_temp.check((SELECT quantity FROM department_stock WHERE factory_id = f AND department = 'PM' AND product_id = b50) = 1000, 'PM holds 1000');

  -- No direct writes to rejections or PM stock.
  e := format($q$INSERT INTO bottle_rejections(factory_id, reference, transfer_id, product_id, department, quantity, reason, production_date)
        VALUES (%L, 'X', %L, %L, 'PM', 1, 'x', current_date)$q$, f, pg_temp.id('t1'), b50);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated', pg_my_temp_schema()::regnamespace);
  SET LOCAL ROLE authenticated;
  e := pg_temp.err(e);
  PERFORM pg_temp.check(e LIKE '%permission denied%', 'no direct insert into bottle_rejections: ' || COALESCE(e, 'no error'));
  e := pg_temp.err('UPDATE department_stock SET quantity = 0');
  PERFORM pg_temp.check(e LIKE '%permission denied%', 'PM stock not writable: ' || COALESCE(e, 'no error'));
  RESET ROLE;
END $$;

-- @@ Test 6 (acceptance 12, 16): PM-stage rejection is separate from blowing damage; reversal keeps the original
DO $$
DECLARE v jsonb; e text; r record;
  f uuid := '9f000000-0000-0000-0000-000000000001';
  b50 uuid := '9d000000-0000-0000-0000-000000000050';
  blowing_damage numeric;
BEGIN
  SELECT SUM(damaged_preforms + damaged_bottles) INTO blowing_damage FROM preform_shift_records WHERE factory_id = f;

  -- QC issued the bottles: she cannot also record PM's rejection of them.
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format($q$SELECT public.record_bottle_rejection(jsonb_build_object('transfer_id', %L, 'quantity', 5, 'reason', 'x'))$q$, pg_temp.id('t1')));
  PERFORM pg_temp.check(e LIKE '%cannot record PM%', 'issuer cannot reject: ' || COALESCE(e, 'no error'));

  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.record_bottle_rejection(jsonb_build_object('transfer_id', %L, 'quantity', 5))$q$, pg_temp.id('t1')));
  PERFORM pg_temp.check(e LIKE '%Say why%', 'reason required: ' || COALESCE(e, 'no error'));
  v := public.record_bottle_rejection(jsonb_build_object('transfer_id', pg_temp.id('t1'), 'quantity', 25,
         'reason', 'Thin neck, leaking on the filler', 'production_reference', 'BATCH-50CL-01', 'shift', 'day',
         'client_ref', '9a400000-0000-0000-0000-000000000001'));
  INSERT INTO ids VALUES ('rej1', (v->>'id')::uuid);
  v := public.record_bottle_rejection(jsonb_build_object('transfer_id', pg_temp.id('t1'), 'quantity', 25, 'reason', 'again',
         'client_ref', '9a400000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check((v->>'duplicate')::boolean, 'rejection posted once');
  PERFORM pg_temp.check((SELECT quantity FROM department_stock WHERE department = 'PM' AND product_id = b50) = 975, 'PM stock 1000 - 25');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b50) = 1765, 'rejected bottles do not return to bottle stock');
  PERFORM pg_temp.check((SELECT SUM(damaged_preforms + damaged_bottles) FROM preform_shift_records WHERE factory_id = f) = blowing_damage,
                        'blowing-stage damage unchanged');
  e := pg_temp.err(format($q$SELECT public.record_bottle_rejection(jsonb_build_object('transfer_id', %L, 'quantity', 976, 'reason', 'x'))$q$, pg_temp.id('t1')));
  PERFORM pg_temp.check(e LIKE '%at most 975 more%', 'not more than received: ' || COALESCE(e, 'no error'));

  SELECT * INTO r FROM public.bottle_stock_report(f, public._pf_today(), public._pf_today()) WHERE product_id = b50;
  PERFORM pg_temp.check(r.issued_to_pm = 1000 AND r.pm_received = 1000 AND r.pm_rejected = 25 AND r.closing = 1765, 'bottle report: ' || row_to_json(r)::text);

  -- The transfer cannot be reversed under the rejection.
  PERFORM pg_temp.as_user('4');
  e := pg_temp.err(format('SELECT public.reverse_bottle_transfer(%L, %L)', pg_temp.id('t1'), 'wrong'));
  PERFORM pg_temp.check(e LIKE '%Reverse those rejections first%', 'transfer reversal blocked: ' || COALESCE(e, 'no error'));
  -- PM cannot reverse; a manager can, keeping the original.
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format('SELECT public.reverse_bottle_rejection(%L, %L)', pg_temp.id('rej1'), 'oops'));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'PM cannot reverse: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('4');
  PERFORM public.reverse_bottle_rejection(pg_temp.id('rej1'), 'Counted twice');
  SELECT * INTO r FROM bottle_rejections WHERE id = pg_temp.id('rej1');
  PERFORM pg_temp.check(r.status = 'reversed' AND r.quantity = 25 AND r.reason LIKE 'Thin neck%' AND r.reversal_reason = 'Counted twice',
                        'original kept with the correction reason');
  PERFORM pg_temp.check((SELECT quantity FROM department_stock WHERE department = 'PM' AND product_id = b50) = 1000, 'PM stock restored');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM department_stock_movements WHERE transfer_id = pg_temp.id('t1')) = 3,
                        'in, rejected, rejection reversed -- all on the ledger');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM audit_logs WHERE entity = 'bottle_rejections' AND entity_id = pg_temp.id('rej1')::text) = 2, 'audited');
END $$;

-- @@ Test 7 (acceptance 16): reversing a session keeps it on record and restores the preforms; reports exclude nothing silently
DO $$
DECLARE r record; e text;
  f uuid := '9f000000-0000-0000-0000-000000000001';
BEGIN
  -- The 13 g night session: its stocking first, then the session.
  PERFORM pg_temp.as_user('4');
  PERFORM public.reverse_preform_stocking((SELECT id FROM preform_stockings WHERE shift_record_id = pg_temp.id('s13')), 'Wrong grammage entered');
  PERFORM public.reverse_preform_shift(pg_temp.id('s13'), 'Wrong grammage entered');
  PERFORM pg_temp.check((SELECT quantity FROM preform_holdings WHERE material_id = '9c000000-0000-0000-0000-000000000013') = 1000, '13 g back to 1000');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = '9d000000-0000-0000-0000-000000000050') = 1765 - 800, 'its 800 bottles out of stock');
  SELECT * INTO r FROM public.preform_grammage_report(f, public._pf_today(), public._pf_today()) WHERE id = pg_temp.id('s13');
  PERFORM pg_temp.check(r.status = 'reversed' AND r.processed = 800, 'reversed session still listed with its figures');
  PERFORM pg_temp.check(r.ledger_variance IS NULL AND r.stock_variance IS NULL, 'no variance claimed on a reversed session');
END $$;

-- @@ Test 8: drill-down returns the issue, ledger, stocking and PM issue behind a session
DO $$
DECLARE t jsonb;
BEGIN
  PERFORM pg_temp.as_user('5');
  t := public.preform_record_trace(pg_temp.id('s12a'));
  PERFORM pg_temp.check(jsonb_array_length(t->'issues') = 1 AND (t->'issues'->0->>'bags')::numeric = 2, 'source issue');
  PERFORM pg_temp.check(t->'record'->>'grammage' = '12g' AND t->'record'->>'capacity' = '50cl', 'specification');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM jsonb_array_elements(t->'movements') x WHERE x->>'type' = 'damaged_bottles' AND (x->>'quantity')::numeric = -10), 'damage line');
  PERFORM pg_temp.check((t->'stockings'->0->>'accepted')::numeric = 490, 'bottle receipt');
  PERFORM pg_temp.check(jsonb_array_length(t->'pm_issues') = 1 AND t->'pm_issues'->0->>'production_reference' = 'BATCH-50CL-01', 'PM issue');
END $$;

-- @@ Test 9: no access to the reports without the module
DO $$
DECLARE e text;
BEGIN
  PERFORM set_config('test.uid', '9a000000-0000-0000-0000-0000000000ff', false);
  e := pg_temp.err($q$SELECT * FROM public.preform_grammage_report('9f000000-0000-0000-0000-000000000001', current_date, current_date)$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'report refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.record_bottle_rejection('{}'::jsonb)$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'rejection refused: ' || COALESCE(e, 'no error'));
END $$;
