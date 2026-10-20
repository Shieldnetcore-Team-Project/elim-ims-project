-- ============================================================================
-- Acceptance tests: preform production workflow
-- (20261020130000_preform_production_workflow.sql).
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test; a failed assertion raises an exception naming what was wrong. Uses its
-- own factory, users and materials; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f1000000-0000-0000-0000-000000000001', 'pftest', 'Preform Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'admin@test'),
  ('a1000000-0000-0000-0000-000000000002', 'store@test'),
  ('a1000000-0000-0000-0000-000000000003', 'operator1@test'),
  ('a1000000-0000-0000-0000-000000000004', 'operator2@test'),
  ('a1000000-0000-0000-0000-000000000005', 'qc@test'),
  ('a1000000-0000-0000-0000-000000000006', 'pm@test'),
  ('a1000000-0000-0000-0000-000000000007', 'manager@test'),
  ('a1000000-0000-0000-0000-000000000008', 'stranger@test'),
  ('a1000000-0000-0000-0000-000000000009', 'auditor@test'),
  ('a1000000-0000-0000-0000-00000000000a', 'warehouse2@test');
UPDATE profiles SET full_name = split_part(email, '@', 1) WHERE id::text LIKE 'a1000000-%';
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'a1000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);

-- A production manager role as the factory creates it from the UI (after
-- the migration ran), with the defaults the migration gives such roles.
INSERT INTO roles(slug, label, is_system) VALUES ('test_production_manager', 'Production Manager (test)', false);
INSERT INTO role_permissions(role, module, action)
SELECT 'test_production_manager', 'preform-production', a
  FROM unnest(ARRAY['view','create','edit','submit','print','export','reverse']::action_key[]) a;
-- Something with no preform rights at all.
INSERT INTO roles(slug, label, is_system) VALUES ('test_nobody', 'Nobody (test)', false);
INSERT INTO role_permissions(role, module, action) VALUES ('test_nobody', 'dashboard', 'view');

INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('a1000000-0000-0000-0000-000000000002', 'store_officer', 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000003', 'production', 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000004', 'production', 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000005', 'qc_officer', 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000006', 'production', 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000007', 'test_production_manager', 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000008', 'test_nobody', 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000009', 'auditor', 'f1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-00000000000a', 'store_officer', 'f1000000-0000-0000-0000-000000000001');

-- Preforms in the store: 100,000 pieces at 10 each; a second preform with
-- no pieces-per-bag set up.
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost) VALUES
  ('d1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'Test Preform (75cl)', 'Piece', 100000, 1000000, 10),
  ('d1000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'Test Preform (50cl)', 'Piece', 5000, 50000, 10);
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'Test Empty Bottle (75cl)', 'Piece', 0, 0, 'semi_finished');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'a1000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
-- Runs p_sql and returns the error message, or NULL when it succeeded.
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.holding(p_op text) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE((SELECT quantity FROM preform_holdings
                    WHERE operator_id = ('a1000000-0000-0000-0000-' || lpad(p_op, 12, '0'))::uuid
                      AND material_id = 'd1000000-0000-0000-0000-000000000001'), 0)
$$;
CREATE OR REPLACE FUNCTION pg_temp.store() RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM raw_materials WHERE id = 'd1000000-0000-0000-0000-000000000001' $$;
CREATE OR REPLACE FUNCTION pg_temp.bottles() RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM products WHERE id = 'e1000000-0000-0000-0000-000000000001' $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

-- @@ Test 1: setup -- pieces per bag and bottle product; only a manager may set them
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err($q$SELECT public.preform_setup_material('d1000000-0000-0000-0000-000000000001', 1152, 'e1000000-0000-0000-0000-000000000001')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'operator cannot set up a material: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('7');
  e := pg_temp.err($q$SELECT public.preform_setup_material('d1000000-0000-0000-0000-000000000001', 1152.5, NULL)$q$);
  PERFORM pg_temp.check(e LIKE '%whole number%', 'fractional pieces per bag refused');
  PERFORM public.preform_setup_material('d1000000-0000-0000-0000-000000000001', 1152, 'e1000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check((SELECT pieces_per_bag = 1152 AND output_product_id = 'e1000000-0000-0000-0000-000000000001'
                           FROM raw_materials WHERE id = 'd1000000-0000-0000-0000-000000000001'), 'setup saved');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'preform_setup_material'
                                  AND entity_id = 'd1000000-0000-0000-0000-000000000001'), 'setup audited');
END $$;

-- @@ Test 2 (acceptance 1): the store issues 40 bags; the operator sees 46,080 pieces waiting
DO $$
DECLARE v jsonb; v2 jsonb; e text; s jsonb;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err($q$SELECT public.issue_preforms('{"material_id":"d1000000-0000-0000-0000-000000000001","operator_id":"a1000000-0000-0000-0000-000000000003","bags":40}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'operator cannot issue to themselves');
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT public.issue_preforms('{"material_id":"d1000000-0000-0000-0000-000000000002","operator_id":"a1000000-0000-0000-0000-000000000003","bags":1}')$q$);
  PERFORM pg_temp.check(e LIKE '%Set pieces per bag%', 'no pieces-per-bag, no issue: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.issue_preforms('{"material_id":"d1000000-0000-0000-0000-000000000001","operator_id":"a1000000-0000-0000-0000-000000000008","bags":1}')$q$);
  PERFORM pg_temp.check(e LIKE '%not set up to work the blowing line%', 'cannot issue to a non-operator');
  e := pg_temp.err($q$SELECT public.issue_preforms('{"material_id":"d1000000-0000-0000-0000-000000000001","operator_id":"a1000000-0000-0000-0000-000000000003","bags":100}')$q$);
  PERFORM pg_temp.check(e LIKE '%Not enough%115200 needed%' OR e LIKE '%Not enough%', 'insufficient store stock refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check(pg_temp.store() = 100000, 'refused issue moved nothing');

  v := public.issue_preforms(jsonb_build_object('material_id', 'd1000000-0000-0000-0000-000000000001',
         'operator_id', 'a1000000-0000-0000-0000-000000000003', 'bags', 40,
         'client_ref', 'c1000000-0000-0000-0000-000000000001'));
  INSERT INTO ids VALUES ('issue1', (v->>'id')::uuid);
  PERFORM pg_temp.check((v->>'pieces')::numeric = 46080, '40 bags x 1152 = 46080 pieces');
  -- Same click twice: one issue, one stock movement.
  v2 := public.issue_preforms(jsonb_build_object('material_id', 'd1000000-0000-0000-0000-000000000001',
         'operator_id', 'a1000000-0000-0000-0000-000000000003', 'bags', 40,
         'client_ref', 'c1000000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check((v2->>'id') = (v->>'id') AND (v2->>'duplicate')::boolean, 'duplicate submit returns the same issue');
  PERFORM pg_temp.check(pg_temp.store() = 100000 - 46080, 'store stock down exactly once');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM raw_material_movements WHERE reference = v->>'reference') = 1, 'one store movement');
  PERFORM pg_temp.check((SELECT current_value FROM raw_materials WHERE id = 'd1000000-0000-0000-0000-000000000001') = (100000 - 46080) * 10,
                        'store value reduced at average cost');
  PERFORM pg_temp.check(pg_temp.holding('3') = 0, 'nothing in the holding until the operator accepts');

  PERFORM pg_temp.as_user('3');
  s := public.preform_day_summary('a1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', public._pf_today());
  PERFORM pg_temp.check((s->>'pending_pieces')::numeric = 46080 AND (s->>'pending_issues')::int = 1, 'operator sees 46080 waiting');
  PERFORM pg_temp.check((SELECT bags = 40 AND pieces_per_bag = 1152 AND pieces = 46080 FROM preform_issues WHERE id = pg_temp.id('issue1')),
                        'issue keeps bags, factor and pieces');
END $$;

-- @@ Test 3 (acceptance 2): only the receiving operator accepts; opening + accepted = available
DO $$
DECLARE e text; s jsonb;
BEGIN
  PERFORM pg_temp.as_user('4');
  e := pg_temp.err(format('SELECT public.respond_preform_issue(%L, true)', pg_temp.id('issue1')));
  PERFORM pg_temp.check(e LIKE '%Only the receiving operator%', 'another operator cannot accept it');
  PERFORM pg_temp.as_user('3');
  PERFORM public.respond_preform_issue(pg_temp.id('issue1'), true);
  e := pg_temp.err(format('SELECT public.respond_preform_issue(%L, true)', pg_temp.id('issue1')));
  PERFORM pg_temp.check(e LIKE '%already been accepted%', 'cannot accept twice');
  PERFORM pg_temp.check(pg_temp.holding('3') = 46080, 'holding = 46080');
  s := public.preform_day_summary('a1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', public._pf_today());
  PERFORM pg_temp.check((s->>'opening')::numeric = 0 AND (s->>'received')::numeric = 46080 AND (s->>'held_now')::numeric = 46080,
                        'opening 0 + received 46080 = 46080 available: ' || s::text);
END $$;

-- @@ Test 4 (acceptance 3-4): day shift -- usage counted once, expected remaining, over-use refused
DO $$
DECLARE v jsonb; e text; r preform_shift_records%ROWTYPE;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err($q$SELECT public.save_preform_shift(jsonb_build_object('operator_id','a1000000-0000-0000-0000-000000000004',
        'material_id','d1000000-0000-0000-0000-000000000001','production_date', public._pf_today(),'shift','day','good_bottles',1))$q$);
  PERFORM pg_temp.check(e LIKE '%only record your own%', 'operator cannot record for someone else');
  e := pg_temp.err($q$SELECT public.save_preform_shift(jsonb_build_object('material_id','d1000000-0000-0000-0000-000000000001',
        'production_date', public._pf_today() + 1,'shift','day','good_bottles',1))$q$);
  PERFORM pg_temp.check(e LIKE '%not in the future%', 'future date refused');

  -- Too much: 50,000 good from 46,080 held.
  v := public.save_preform_shift(jsonb_build_object('material_id', 'd1000000-0000-0000-0000-000000000001',
         'production_date', public._pf_today(), 'shift', 'day', 'good_bottles', 50000, 'damaged_bottles', 0));
  INSERT INTO ids VALUES ('day', (v->>'id')::uuid);
  e := pg_temp.err(format('SELECT public.submit_preform_shift(%L)', pg_temp.id('day')));
  PERFORM pg_temp.check(e LIKE '%Short by 3920 pieces%', 'over-use refused with the exact shortage: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check(pg_temp.holding('3') = 46080, 'refused submit moved nothing');

  -- Correct the draft: 40,000 good, 100 damaged preforms, 300 damaged bottles.
  PERFORM public.save_preform_shift(jsonb_build_object('id', pg_temp.id('day'), 'material_id', 'd1000000-0000-0000-0000-000000000001',
         'production_date', public._pf_today(), 'shift', 'day', 'machine', 'Blower 1',
         'good_bottles', 40000, 'damaged_preforms', 100, 'damaged_bottles', 300));
  -- A second day-shift record for the same operator/preform/date is refused.
  e := pg_temp.err($q$SELECT public.save_preform_shift(jsonb_build_object('material_id','d1000000-0000-0000-0000-000000000001',
        'production_date', public._pf_today(),'shift','day','good_bottles',1))$q$);
  PERFORM pg_temp.check(e LIKE '%already a day shift record%', 'one record per shift: ' || COALESCE(e, 'no error'));

  v := public.submit_preform_shift(pg_temp.id('day'));
  SELECT * INTO r FROM preform_shift_records WHERE id = pg_temp.id('day');
  PERFORM pg_temp.check(r.status = 'awaiting_inspection', 'awaiting inspection');
  PERFORM pg_temp.check(r.opening_qty = 0 AND r.issued_qty = 46080 AND r.available_qty = 46080, 'snapshot opening/issued/available');
  PERFORM pg_temp.check(r.usage_qty = 40400, 'usage = 40000 + 100 + 300 (no double count)');
  PERFORM pg_temp.check(r.expected_remaining = 5680, 'expected remaining = 46080 - 40400');
  PERFORM pg_temp.check(pg_temp.holding('3') = 5680, 'holding = 5680');
  PERFORM pg_temp.check((SELECT shift_record_id FROM preform_issues WHERE id = pg_temp.id('issue1')) = pg_temp.id('day'), 'issue attached to the shift');
  e := pg_temp.err(format('SELECT public.save_preform_shift(jsonb_build_object(%L, %L, %L, %L, %L, %L, %L, %L, %L, 1))',
        'id', pg_temp.id('day'), 'material_id', 'd1000000-0000-0000-0000-000000000001', 'production_date', public._pf_today(), 'shift', 'day', 'good_bottles'));
  PERFORM pg_temp.check(e LIKE '%Only a draft can be edited%', 'submitted record cannot be edited');
  -- Not stockable before QC.
  e := pg_temp.err(format('SELECT public.send_preform_stocking(%L, 100)', pg_temp.id('day')));
  PERFORM pg_temp.check(e LIKE '%only after QC approves%', 'no stocking before QC');
END $$;

-- @@ Test 5: QC -- not by the operator; good + rejected must equal reported good
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format('SELECT public.inspect_preform_shift(%L, %L, 40000, 0)', pg_temp.id('day'), 'approved'));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%' OR e LIKE '%someone other than the operator%', 'operator cannot QC own shift');
  PERFORM pg_temp.as_user('5');
  e := pg_temp.err(format('SELECT public.inspect_preform_shift(%L, %L, 39000, 100, %L)', pg_temp.id('day'), 'approved', 'thin walls'));
  PERFORM pg_temp.check(e LIKE '%must equal the 40000 good bottles%', 'counts must add up: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format('SELECT public.inspect_preform_shift(%L, %L, 39900, 100)', pg_temp.id('day'), 'approved'));
  PERFORM pg_temp.check(e LIKE '%reason for the rejected%', 'rejections need a reason');
  PERFORM public.inspect_preform_shift(pg_temp.id('day'), 'approved', 39900, 100, 'thin walls', 'Scrapped');
  PERFORM pg_temp.check((SELECT status = 'awaiting_stocking' AND qc_good = 39900 AND qc_rejected = 100
                           FROM preform_shift_records WHERE id = pg_temp.id('day')), 'QC approved 39900');
  PERFORM pg_temp.check(pg_temp.holding('3') = 5680, 'QC rejection does not touch the holding again (no double deduction)');
END $$;

-- @@ Test 6 (acceptance 5-8): stocking -- QC cap, Warehouse count, mismatch exception, damaged never stocked
DO $$
DECLARE v jsonb; e text; r record;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format('SELECT public.send_preform_stocking(%L, 40000)', pg_temp.id('day')));
  PERFORM pg_temp.check(e LIKE '%only 39900 QC-approved bottles remain%', 'cannot stock more than QC approved: ' || COALESCE(e, 'no error'));
  v := public.send_preform_stocking(pg_temp.id('day'), 39900, 'Pallets 1-12');
  INSERT INTO ids VALUES ('stock1', (v->>'id')::uuid);
  PERFORM pg_temp.check(pg_temp.bottles() = 0, 'sending does not raise stock');
  e := pg_temp.err(format('SELECT public.send_preform_stocking(%L, 1)', pg_temp.id('day')));
  PERFORM pg_temp.check(e LIKE '%only 0 QC-approved%', 'pending stocking counts toward what is left');

  -- Warehouse: not the sender; cannot accept more than sent; short needs a note.
  e := pg_temp.err(format('SELECT public.accept_preform_stocking(%L, 39900)', pg_temp.id('stock1')));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'operator cannot accept their own stocking');
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format('SELECT public.accept_preform_stocking(%L, 40000)', pg_temp.id('stock1')));
  PERFORM pg_temp.check(e LIKE '%only 39900 were sent%', 'cannot accept more than sent');
  e := pg_temp.err(format('SELECT public.accept_preform_stocking(%L, 39850)', pg_temp.id('stock1')));
  PERFORM pg_temp.check(e LIKE '%Add a note%', 'short acceptance needs a note');
  v := public.accept_preform_stocking(pg_temp.id('stock1'), 39850, 'Two pallets short by 50');
  INSERT INTO ids VALUES ('exc1', (v->>'exception_id')::uuid);
  PERFORM pg_temp.check(pg_temp.bottles() = 39850, 'Warehouse stock = what it counted (39850), never the 400 damaged');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM inventory_movements WHERE product_id = 'e1000000-0000-0000-0000-000000000001'
                           AND movement_type = 'produced' AND quantity = 39850) = 1, 'one ledger movement for the stocking');
  e := pg_temp.err(format('SELECT public.accept_preform_stocking(%L, 39850, %L)', pg_temp.id('stock1'), 'again'));
  PERFORM pg_temp.check(e LIKE '%already been accepted%', 'no double posting');
  SELECT * INTO r FROM preform_exceptions WHERE id = pg_temp.id('exc1');
  PERFORM pg_temp.check(r.kind = 'count_mismatch' AND r.difference_qty = 50 AND r.status = 'open', 'count mismatch of 50 open');
  PERFORM pg_temp.check((SELECT status FROM preform_shift_records WHERE id = pg_temp.id('day')) = 'awaiting_stocking',
                        'record not completed while an exception is open');
  PERFORM pg_temp.check(public._pf_remaining_to_stock(pg_temp.id('day')) = 0, 'nothing more to stock (difference held by the exception)');
END $$;

-- @@ Test 7 (acceptance 7, 13): a variance is never forced to zero; resolver must not be the raiser
DO $$
DECLARE e text; r record;
BEGIN
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format('SELECT public.resolve_preform_exception(%L, %L, %L)', pg_temp.id('exc1'), 'written_off', 'ok'));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'warehouse officer cannot resolve');
  PERFORM pg_temp.as_user('7');
  e := pg_temp.err(format('SELECT public.resolve_preform_exception(%L, %L, %L)', pg_temp.id('exc1'), 'returned_to_stock', 'found'));
  PERFORM pg_temp.check(e LIKE '%Only a transfer shortfall%', 'stocking difference cannot be pushed into stock');
  PERFORM public.resolve_preform_exception(pg_temp.id('exc1'), 'written_off', 'Breakage while moving pallets; driver statement filed');
  PERFORM pg_temp.check((SELECT status FROM preform_shift_records WHERE id = pg_temp.id('day')) = 'completed', 'record completed once resolved');
  PERFORM pg_temp.check(pg_temp.bottles() = 39850, 'resolution did not change stock');
  SELECT * INTO r FROM public.preform_shift_report('f1000000-0000-0000-0000-000000000001', public._pf_today(), public._pf_today())
   WHERE id = pg_temp.id('day');
  PERFORM pg_temp.check(r.variance = 50 AND r.stocked = 39850 AND r.qc_good = 39900, 'report keeps the 50 variance visible');
END $$;

-- @@ Test 8 (acceptance 11): night shift inherits the remaining stock; daily report shows opening once
DO $$
DECLARE v jsonb; r preform_shift_records%ROWTYPE; d record;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := public.issue_preforms(jsonb_build_object('material_id', 'd1000000-0000-0000-0000-000000000001',
         'operator_id', 'a1000000-0000-0000-0000-000000000003', 'bags', 5));
  INSERT INTO ids VALUES ('issue2', (v->>'id')::uuid);
  PERFORM pg_temp.as_user('3');
  PERFORM public.respond_preform_issue(pg_temp.id('issue2'), true);
  v := public.save_preform_shift(jsonb_build_object('material_id', 'd1000000-0000-0000-0000-000000000001',
         'production_date', public._pf_today(), 'shift', 'night', 'good_bottles', 11000));
  INSERT INTO ids VALUES ('night', (v->>'id')::uuid);
  PERFORM public.submit_preform_shift(pg_temp.id('night'));
  SELECT * INTO r FROM preform_shift_records WHERE id = pg_temp.id('night');
  PERFORM pg_temp.check(r.opening_qty = 5680, 'night opening = day remaining (5680), not the day opening: ' || r.opening_qty);
  PERFORM pg_temp.check(r.issued_qty = 5760 AND r.available_qty = 11440 AND r.expected_remaining = 440, 'night: 5680 + 5760 - 11000 = 440');
  PERFORM pg_temp.check(pg_temp.holding('3') = 440, 'holding 440');

  SELECT * INTO d FROM public.preform_daily_report('f1000000-0000-0000-0000-000000000001', public._pf_today(), public._pf_today(),
                                                   'a1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(d.opening = 0, 'daily opening shown once (0), not 0 + 5680');
  PERFORM pg_temp.check(d.received = 51840, 'received 46080 + 5760');
  PERFORM pg_temp.check(d.good_bottles = 51000 AND d.damaged_preforms = 100 AND d.damaged_bottles = 300, 'usage by category');
  PERFORM pg_temp.check(d.usage = 51400 AND d.closing = 440, 'usage 51400, closing 440');
  PERFORM pg_temp.check(d.opening + d.received - d.usage = d.closing, 'opening + received - usage = closing');
  PERFORM pg_temp.check(d.shifts = 2 AND d.pending_shifts = 1, 'two shifts, one still pending');
END $$;

-- @@ Test 9 (acceptance 9-10): transfer to PM -- source down, destination up once; shortfall exception
DO $$
DECLARE v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('6');
  e := pg_temp.err($q$SELECT public.dispatch_bottle_transfer('{"product_id":"e1000000-0000-0000-0000-000000000001","quantity":10,"to_department":"PM"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'PM cannot dispatch from the Warehouse');
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT public.dispatch_bottle_transfer('{"product_id":"e1000000-0000-0000-0000-000000000001","quantity":50000,"to_department":"PM"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Not enough%', 'cannot dispatch more than in stock');
  v := public.dispatch_bottle_transfer('{"product_id":"e1000000-0000-0000-0000-000000000001","quantity":30000,"to_department":"PM","client_ref":"c1000000-0000-0000-0000-000000000002"}');
  INSERT INTO ids VALUES ('tr1', (v->>'id')::uuid);
  PERFORM public.dispatch_bottle_transfer('{"product_id":"e1000000-0000-0000-0000-000000000001","quantity":30000,"to_department":"PM","client_ref":"c1000000-0000-0000-0000-000000000002"}');
  PERFORM pg_temp.check(pg_temp.bottles() = 9850, 'Warehouse down 30000 once (39850 -> 9850)');
  e := pg_temp.err(format('SELECT public.receive_bottle_transfer(%L, 30000)', pg_temp.id('tr1')));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%' OR e LIKE '%someone other than%', 'dispatcher cannot receive');
  PERFORM pg_temp.as_user('6');
  e := pg_temp.err(format('SELECT public.receive_bottle_transfer(%L, 30001)', pg_temp.id('tr1')));
  PERFORM pg_temp.check(e LIKE '%cannot be more than was dispatched%', 'cannot receive more than sent');
  v := public.receive_bottle_transfer(pg_temp.id('tr1'), 29990, '10 crushed on the forklift');
  INSERT INTO ids VALUES ('exc2', (v->>'exception_id')::uuid);
  PERFORM pg_temp.check(v->>'status' = 'discrepancy', 'discrepancy status');
  PERFORM pg_temp.check((SELECT quantity FROM department_stock WHERE department = 'PM'
                           AND product_id = 'e1000000-0000-0000-0000-000000000001') = 29990, 'PM holds 29990');
  PERFORM pg_temp.check((SELECT quantity_sent FROM bottle_transfers WHERE id = pg_temp.id('tr1')) = 30000, 'dispatched quantity never changed');
  e := pg_temp.err(format('SELECT public.receive_bottle_transfer(%L, 29990, %L)', pg_temp.id('tr1'), 'x'));
  PERFORM pg_temp.check(e LIKE '%already been%', 'cannot receive twice');
  -- Manager: 10 found at the Warehouse after all.
  PERFORM pg_temp.as_user('7');
  PERFORM public.resolve_preform_exception(pg_temp.id('exc2'), 'returned_to_stock', 'Found 10 behind the racks');
  PERFORM pg_temp.check(pg_temp.bottles() = 9860, 'found bottles back in Warehouse stock');
END $$;

-- @@ Test 10: a dispatched transfer not received can be cancelled; stock returns
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := public.dispatch_bottle_transfer('{"product_id":"e1000000-0000-0000-0000-000000000001","quantity":1000,"to_department":"PM"}');
  PERFORM pg_temp.check(pg_temp.bottles() = 8860, 'dispatched');
  PERFORM public.cancel_bottle_transfer((v->>'id')::uuid, 'Wrong pallet');
  PERFORM pg_temp.check(pg_temp.bottles() = 9860, 'cancelled transfer returns stock');
END $$;

-- @@ Test 11 (acceptance 15): reversals keep the original and refuse when stock has moved on
DO $$
DECLARE v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('7');
  -- The day stocking's bottles were transferred to PM: the Warehouse holds 9860 < 39850.
  e := pg_temp.err(format('SELECT public.reverse_preform_stocking(%L, %L)', pg_temp.id('stock1'), 'test'));
  PERFORM pg_temp.check(e LIKE '%Not enough%', 'cannot reverse a stocking whose bottles left the Warehouse: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format('SELECT public.reverse_preform_shift(%L, %L)', pg_temp.id('day'), 'test'));
  PERFORM pg_temp.check(e LIKE '%Withdraw or reverse those stockings first%', 'cannot reverse a shift with stocked bottles');
  e := pg_temp.err(format('SELECT public.reverse_preform_issue(%L, %L)', pg_temp.id('issue1'), 'test'));
  PERFORM pg_temp.check(e LIKE '%Reverse that shift record first%', 'cannot reverse an issue a shift used');

  -- Reverse the night shift (awaiting QC): holding restored, its issue freed.
  PERFORM public.reverse_preform_shift(pg_temp.id('night'), 'Recorded against the wrong blower');
  PERFORM pg_temp.check(pg_temp.holding('3') = 11440, 'night usage back in the holding');
  PERFORM pg_temp.check((SELECT status FROM preform_shift_records WHERE id = pg_temp.id('night')) = 'reversed', 'kept as reversed');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM preform_movements WHERE shift_record_id = pg_temp.id('night') AND movement_type = 'usage_reversed'
                                  AND quantity = 11000), 'reversal is its own ledger entry');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM preform_movements WHERE shift_record_id = pg_temp.id('night') AND movement_type = 'good_bottles'
                                  AND quantity = -11000), 'original entry kept');
  -- The freed issue can now be reversed back to the store.
  PERFORM public.reverse_preform_issue(pg_temp.id('issue2'), 'Over-issued');
  PERFORM pg_temp.check(pg_temp.holding('3') = 5680, 'holding back to the day remainder');
  PERFORM pg_temp.check(pg_temp.store() = 100000 - 46080, 'store got the 5760 back');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'reverse_preform_issue' AND entity_id = pg_temp.id('issue2')::text),
                        'reversal audited');
END $$;

-- @@ Test 12: QC can return a shift; its usage is undone and the operator corrects it
DO $$
DECLARE v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('3');
  v := public.save_preform_shift(jsonb_build_object('material_id', 'd1000000-0000-0000-0000-000000000001',
         'production_date', public._pf_today() - 1, 'shift', 'night', 'good_bottles', 5000, 'other_losses', 80,
         'other_loss_reason', 'Power cut purge'));
  INSERT INTO ids VALUES ('n2', (v->>'id')::uuid);
  PERFORM public.submit_preform_shift(pg_temp.id('n2'));
  PERFORM pg_temp.check(pg_temp.holding('3') = 600, '5680 - 5080');
  PERFORM pg_temp.as_user('5');
  e := pg_temp.err(format('SELECT public.inspect_preform_shift(%L, %L, 0, 0)', pg_temp.id('n2'), 'returned'));
  PERFORM pg_temp.check(e LIKE '%Say what the operator must correct%', 'return needs a note');
  PERFORM public.inspect_preform_shift(pg_temp.id('n2'), 'returned', 0, 0, NULL, NULL, 'Count the purge separately');
  PERFORM pg_temp.check((SELECT status FROM preform_shift_records WHERE id = pg_temp.id('n2')) = 'draft', 'back to draft');
  PERFORM pg_temp.check(pg_temp.holding('3') = 5680, 'usage undone');
END $$;

-- @@ Test 13 (acceptance 12): bags + loose pieces; a later factor change leaves history alone
DO $$
DECLARE v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := public.issue_preforms(jsonb_build_object('material_id', 'd1000000-0000-0000-0000-000000000001',
         'operator_id', 'a1000000-0000-0000-0000-000000000004', 'bags', 2, 'loose_pieces', 7));
  PERFORM pg_temp.check((v->>'pieces')::numeric = 2311, '2 bags x 1152 + 7 loose = 2311 (remainder kept)');
  e := pg_temp.err($q$SELECT public.issue_preforms('{"material_id":"d1000000-0000-0000-0000-000000000001","operator_id":"a1000000-0000-0000-0000-000000000004","bags":1.5}')$q$);
  PERFORM pg_temp.check(e LIKE '%whole numbers%', 'half bags refused');
  PERFORM pg_temp.as_user('7');
  e := pg_temp.err($q$SELECT public.preform_setup_material('d1000000-0000-0000-0000-000000000001', 1000, 'e1000000-0000-0000-0000-000000000001')$q$);
  PERFORM pg_temp.check(e LIKE '%reason%', 'changing the factor needs a reason');
  PERFORM public.preform_setup_material('d1000000-0000-0000-0000-000000000001', 1000, 'e1000000-0000-0000-0000-000000000001', 'New supplier bag size');
  PERFORM pg_temp.check((SELECT pieces_per_bag FROM preform_issues WHERE id = pg_temp.id('issue1')) = 1152, 'old issue keeps 1152');
  PERFORM pg_temp.check((SELECT pieces FROM preform_issues WHERE id = pg_temp.id('issue1')) = 46080, 'old issue keeps 46080 pieces');
END $$;

-- @@ Test 14 (acceptance 13-14): no direct writes; no access without the module; auditor read-only
DO $$
DECLARE e text; n int;
  v_issue1 uuid := pg_temp.id('issue1');
  v_day uuid := pg_temp.id('day');
BEGIN
  -- The test helpers live in this session's temp schema; let the client role call them.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated', pg_my_temp_schema()::regnamespace);
  PERFORM pg_temp.as_user('3');
  SET LOCAL ROLE authenticated;
  e := pg_temp.err(format('UPDATE preform_issues SET pieces = 1 WHERE id = %L', v_issue1));
  PERFORM pg_temp.check(e LIKE '%permission denied%', 'posted issue cannot be edited directly: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format('DELETE FROM preform_shift_records WHERE id = %L', v_day));
  PERFORM pg_temp.check(e LIKE '%permission denied%', 'shift record cannot be deleted');
  e := pg_temp.err('UPDATE preform_holdings SET quantity = 999999');
  PERFORM pg_temp.check(e LIKE '%permission denied%', 'holding cannot be edited');
  e := pg_temp.err('UPDATE products SET current_stock = 0');
  PERFORM pg_temp.check(e IS NOT NULL OR (SELECT current_stock FROM products WHERE id = 'e1000000-0000-0000-0000-000000000001') > 0,
                        'warehouse stock not writable by an operator');
  e := pg_temp.err($q$SELECT public._pf_move('f1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000003','d1000000-0000-0000-0000-000000000001','issue_in',100,current_date,null,null,null,null)$q$);
  PERFORM pg_temp.check(e LIKE '%permission denied%', 'ledger helper not callable by clients');
  SELECT COUNT(*) INTO n FROM preform_issues;
  PERFORM pg_temp.check(n >= 3, 'operator can read issues');
  RESET ROLE;

  PERFORM pg_temp.as_user('8');
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO n FROM preform_issues;
  PERFORM pg_temp.check(n = 0, 'no module, no rows');
  e := pg_temp.err($q$SELECT public.preform_day_summary('a1000000-0000-0000-0000-000000000003','d1000000-0000-0000-0000-000000000001',current_date)$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'no module, no summary');
  RESET ROLE;

  PERFORM pg_temp.as_user('9');
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO n FROM preform_shift_records;
  PERFORM pg_temp.check(n >= 3, 'auditor can read');
  e := pg_temp.err(format('SELECT public.reverse_preform_shift(%L, %L)', v_day, 'x'));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'auditor cannot reverse');
  RESET ROLE;
END $$;

-- @@ Test 15 (acceptance 16): the ledger always matches the holdings and stays non-negative
DO $$
BEGIN
  PERFORM pg_temp.check(NOT EXISTS (
    SELECT 1 FROM preform_holdings h
     WHERE h.quantity <> COALESCE((SELECT SUM(m.quantity) FROM preform_movements m
                                    WHERE m.operator_id = h.operator_id AND m.material_id = h.material_id), 0)),
    'every holding = sum of its ledger');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM preform_movements WHERE quantity_after < 0), 'no negative balance ever');
  PERFORM pg_temp.check(NOT EXISTS (
    SELECT 1 FROM preform_movements m
     WHERE m.quantity_before + m.quantity <> m.quantity_after), 'every movement before + qty = after');
  PERFORM pg_temp.check((SELECT quantity FROM department_stock WHERE department = 'PM') =
                        (SELECT SUM(quantity) FROM department_stock_movements WHERE department = 'PM'), 'PM stock = its ledger');
END $$;

-- @@ Test 16: bottles found after a shortfall go through a new stocking and a new Warehouse count
DO $$
DECLARE v jsonb; v_rec uuid; v_exc uuid; e text;
BEGIN
  -- Operator 2: issue, accept, 1,000 good, QC all good.
  PERFORM pg_temp.as_user('7');
  PERFORM public.preform_setup_material('d1000000-0000-0000-0000-000000000001', 1000, 'e1000000-0000-0000-0000-000000000001', 'reset');
  PERFORM pg_temp.as_user('4');
  PERFORM public.respond_preform_issue((SELECT id FROM preform_issues WHERE operator_id = 'a1000000-0000-0000-0000-000000000004' AND status = 'issued' LIMIT 1), true);
  v := public.save_preform_shift(jsonb_build_object('material_id', 'd1000000-0000-0000-0000-000000000001',
         'production_date', public._pf_today(), 'shift', 'day', 'good_bottles', 1000));
  v_rec := (v->>'id')::uuid;
  PERFORM public.submit_preform_shift(v_rec);
  PERFORM pg_temp.as_user('5');
  PERFORM public.inspect_preform_shift(v_rec, 'approved', 1000, 0);
  -- Operator stocks 900 and reports the other 100 as a shortfall.
  PERFORM pg_temp.as_user('4');
  v := public.send_preform_stocking(v_rec, 900);
  PERFORM pg_temp.as_user('a');
  PERFORM public.accept_preform_stocking((v->>'id')::uuid, 900);
  PERFORM pg_temp.as_user('4');
  v := public.report_preform_shortfall(v_rec, '100 missing after shift change');
  v_exc := (v->>'id')::uuid;
  PERFORM pg_temp.check((v->>'shortfall')::numeric = 100, 'shortfall of 100');
  e := pg_temp.err(format('SELECT public.send_preform_stocking(%L, 100)', v_rec));
  PERFORM pg_temp.check(e LIKE '%only 0 QC-approved%', 'cannot stock while the shortfall is open');
  -- Found: the manager reopens; the 100 must be sent and counted again.
  PERFORM pg_temp.as_user('7');
  PERFORM public.resolve_preform_exception(v_exc, 'reopened', 'Found on the night trolley');
  PERFORM pg_temp.check((SELECT status FROM preform_exceptions WHERE id = v_exc) = 'voided', 'exception voided with a note');
  PERFORM pg_temp.check(public._pf_remaining_to_stock(v_rec) = 100, '100 back to be stocked');
  PERFORM pg_temp.check((SELECT status FROM preform_shift_records WHERE id = v_rec) = 'awaiting_stocking', 'still awaiting stocking');
  PERFORM pg_temp.as_user('4');
  v := public.send_preform_stocking(v_rec, 100);
  PERFORM pg_temp.as_user('a');
  PERFORM public.accept_preform_stocking((v->>'id')::uuid, 100);
  PERFORM pg_temp.check((SELECT status FROM preform_shift_records WHERE id = v_rec) = 'completed', 'completed once all 1000 are stocked');
END $$;

-- @@ Test 17: the Store sets pieces per bag from the material form (20261020140000)
DO $$
DECLARE e text; v jsonb;
BEGIN
  PERFORM pg_temp.as_user('8');
  e := pg_temp.err($q$SELECT public.set_material_pieces_per_bag('d1000000-0000-0000-0000-000000000002', 1152)$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'no rights, no change');
  PERFORM pg_temp.as_user('7');
  v := public.set_material_pieces_per_bag('d1000000-0000-0000-0000-000000000002', 1152);
  PERFORM pg_temp.check((v->>'changed')::boolean AND (SELECT pieces_per_bag FROM raw_materials WHERE id = 'd1000000-0000-0000-0000-000000000002') = 1152,
                        'first bag size set without a reason');
  e := pg_temp.err($q$SELECT public.set_material_pieces_per_bag('d1000000-0000-0000-0000-000000000002', 1200)$q$);
  PERFORM pg_temp.check(e LIKE '%reason%', 'changing it needs a reason');
  e := pg_temp.err($q$SELECT public.set_material_pieces_per_bag('d1000000-0000-0000-0000-000000000002', 10.5, 'x')$q$);
  PERFORM pg_temp.check(e LIKE '%whole number%', 'whole bags only');
  PERFORM public.set_material_pieces_per_bag('d1000000-0000-0000-0000-000000000002', 1200, 'Supplier changed bag size');
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = 'd1000000-0000-0000-0000-000000000002') = 5000,
                        'stock (pieces) unchanged by a new bag size');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'set_material_pieces_per_bag'
                                  AND entity_id = 'd1000000-0000-0000-0000-000000000002'), 'audited');
END $$;

-- @@ Test 18: Store / QC add a supplier from the form (20261020150000)
DO $$
DECLARE e text; v jsonb; v2 jsonb;
BEGIN
  PERFORM pg_temp.as_user('8');
  e := pg_temp.err($q$SELECT public.quick_add_supplier('f1000000-0000-0000-0000-000000000001', 'Nobody Ltd')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'no material rights, no supplier');
  PERFORM pg_temp.as_user('5'); -- QC: goods-receiving submit, no suppliers:write
  v := public.quick_add_supplier('f1000000-0000-0000-0000-000000000001', '  Sunrise   Preforms Ltd ');
  PERFORM pg_temp.check(NOT (v->>'existing')::boolean AND v->>'name' = 'Sunrise Preforms Ltd', 'QC added a supplier (name tidied)');
  v2 := public.quick_add_supplier('f1000000-0000-0000-0000-000000000001', 'sunrise preforms LTD');
  PERFORM pg_temp.check((v2->>'existing')::boolean AND v2->>'id' = v->>'id', 'same name reused, no duplicate');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM suppliers WHERE factory_id = 'f1000000-0000-0000-0000-000000000001') = 1, 'one supplier row');
  e := pg_temp.err($q$SELECT public.quick_add_supplier('f1000000-0000-0000-0000-000000000001', ' ')$q$);
  PERFORM pg_temp.check(e LIKE '%Enter the supplier name%', 'blank name refused');
END $$;

-- @@ Test 19: Store issues to the production manager or QC (20261020160000)
DO $$
DECLARE e text; n int; r record;
BEGIN
  -- Approved staff accounts (the list leaves out pending / deactivated ones).
  PERFORM pg_temp.as_user('1');
  UPDATE profiles SET status = 'active' WHERE id::text LIKE 'a1000000-%';
  SELECT COUNT(*) INTO n FROM public.issue_recipients('f1000000-0000-0000-0000-000000000001')
   WHERE (department = 'quality_control' AND id = 'a1000000-0000-0000-0000-000000000005')
      OR (department = 'production' AND id = 'a1000000-0000-0000-0000-000000000003');
  PERFORM pg_temp.check(n = 2, 'QC officer listed under QC, operator under Production');
  -- QC person must be in QC.
  e := pg_temp.err($q$SELECT public.issue_raw_material('{"material_id":"d1000000-0000-0000-0000-000000000002","quantity":10,"purpose":"general","issued_to_department":"quality_control","issued_to_user":"a1000000-0000-0000-0000-000000000003"}')$q$);
  PERFORM pg_temp.check(e LIKE '%not in Quality Control%', 'cannot issue to QC in the name of a non-QC user');
  PERFORM public.issue_raw_material('{"material_id":"d1000000-0000-0000-0000-000000000002","quantity":10,"purpose":"general","issued_to_department":"quality_control","issued_to_user":"a1000000-0000-0000-0000-000000000005","reason":"Burst test"}');
  SELECT * INTO r FROM raw_material_movements WHERE material_id = 'd1000000-0000-0000-0000-000000000002' ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check(r.issued_to_department = 'quality_control' AND r.issued_to_user = 'a1000000-0000-0000-0000-000000000005'
                        AND r.reason = 'Issued to Quality Control — qc: Burst test' AND r.movement_type = 'issued', 'recipient recorded: ' || r.reason);
  PERFORM public.issue_raw_material('{"material_id":"d1000000-0000-0000-0000-000000000002","quantity":5,"issued_to_department":"production"}');
  SELECT * INTO r FROM raw_material_movements WHERE material_id = 'd1000000-0000-0000-0000-000000000002' ORDER BY created_at DESC, quantity LIMIT 1;
  PERFORM pg_temp.check(r.issued_to_department = 'production' AND r.reason = 'Issued to Production Manager', 'department-only issue: ' || r.reason);
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = 'd1000000-0000-0000-0000-000000000002') = 4985, 'stock down 15');
END $$;

-- @@ Test 20: QC may set a preform's first bag size at receiving, not change it (20261020170000)
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('1');
  INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost)
  VALUES ('d1000000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000001', 'Test Preform (35cl)', 'Piece', 0, 0, 0);
  PERFORM pg_temp.as_user('5'); -- QC: goods-receiving submit only
  PERFORM public.set_material_pieces_per_bag('d1000000-0000-0000-0000-000000000003', 1500);
  PERFORM pg_temp.check((SELECT pieces_per_bag FROM raw_materials WHERE id = 'd1000000-0000-0000-0000-000000000003') = 1500,
                        'QC set the first bag size');
  e := pg_temp.err($q$SELECT public.set_material_pieces_per_bag('d1000000-0000-0000-0000-000000000003', 1600, 'recount')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'QC cannot change an existing bag size');
  PERFORM pg_temp.as_user('7');
  PERFORM public.set_material_pieces_per_bag('d1000000-0000-0000-0000-000000000003', 1600, 'Supplier confirmed 1,600 per bag');
  PERFORM pg_temp.check((SELECT pieces_per_bag FROM raw_materials WHERE id = 'd1000000-0000-0000-0000-000000000003') = 1600,
                        'a manager can change it with a reason');
END $$;
