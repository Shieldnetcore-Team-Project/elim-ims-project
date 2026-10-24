-- ============================================================================
-- Acceptance test: QC sets a preform's bottle the first time
-- (20261023235000_qc_first_bottle_setup.sql)
--
-- Replays the failure: QC enters blowing for a preform with no bottle set;
-- the submit stops and leaves a draft. She picks the bottle (once), the draft
-- is completed and the good bottles are stocked. Changing the bottle later
-- needs a manager.
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('4f000000-0000-0000-0000-000000000001', 'qcbt', 'QC Bottle Factory');
INSERT INTO auth.users(id, email) VALUES
  ('4a000000-0000-0000-0000-000000000001', 'store@qcbt'),
  ('4a000000-0000-0000-0000-000000000002', 'qc@qcbt');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '4a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '4a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('4a000000-0000-0000-0000-000000000001', 'store_keeper', '4f000000-0000-0000-0000-000000000001'),
  ('4a000000-0000-0000-0000-000000000002', 'qc_officer', '4f000000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('4d000000-0000-0000-0000-000000000001', '4f000000-0000-0000-0000-000000000001', '75cl bottles', 'Piece', 0, 0, 'finished'),
  ('4d000000-0000-0000-0000-000000000002', '4f000000-0000-0000-0000-000000000001', '50cl bottles', 'Piece', 0, 0, 'finished');
-- An old-system preform: bag size set, no bottle.
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform) VALUES
  ('4c000000-0000-0000-0000-000000000001', '4f000000-0000-0000-0000-000000000001', 'YUNO MOLD', 'Piece', 16000, 16000, 1, 1600, true);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '4a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: no bottle -> stops with a draft; QC sets the bottle once; the draft completes
DO $$
DECLARE v jsonb; e text; draft uuid; s jsonb;
  m uuid := '4c000000-0000-0000-0000-000000000001';
  qc uuid := '4a000000-0000-0000-0000-000000000002';
  b75 uuid := '4d000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', m, 'operator_id', qc, 'bags', 2, 'loose_pieces', 0));
  PERFORM pg_temp.as_user('2');
  PERFORM public.respond_preform_issue((v->>'id')::uuid, true);

  -- What happened: saved, then submit refused for want of a bottle.
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m, 'production_date', public._pf_today(),
         'shift', 'day', 'good_bottles', 1500, 'damaged_bottles', 20));
  draft := (v->>'id')::uuid;
  e := pg_temp.err(format('SELECT public.submit_preform_shift(%L)', draft));
  PERFORM pg_temp.check(e LIKE '%no bottle product%', 'the original message: ' || COALESCE(e, 'no error'));

  -- The fix: QC picks the bottle once, the leftover draft is completed.
  PERFORM public.set_preform_bottle_product(m, b75);
  v := public.save_preform_shift(jsonb_build_object('id', draft, 'operator_id', qc, 'material_id', m,
         'production_date', public._pf_today(), 'shift', 'day', 'good_bottles', 1500, 'damaged_bottles', 20));
  s := public.submit_preform_shift(draft);
  PERFORM pg_temp.check(s->>'status' = 'completed', 'completed: ' || s::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b75) = 1500, '1500 good bottles stocked');

  -- Changing it afterwards is a manager's job.
  e := pg_temp.err(format('SELECT public.set_preform_bottle_product(%L, %L)', m, '4d000000-0000-0000-0000-000000000002'));
  PERFORM pg_temp.check(e LIKE '%a manager changes it%', 'QC cannot change it: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 2: correct the bottle from the edit -- the stocked good bottles move across (20261023235500)
DO $$
DECLARE e text; v jsonb;
  m uuid := '4c000000-0000-0000-0000-000000000001';
  b75 uuid := '4d000000-0000-0000-0000-000000000001';
  b50 uuid := '4d000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format('SELECT public.correct_preform_bottle(%L, %L, %L)', m, b50, ''));
  PERFORM pg_temp.check(e LIKE '%Say why%', 'a reason is required: ' || COALESCE(e, 'no error'));
  v := public.correct_preform_bottle(m, b50, 'YUNO MOLD 12.5g blows 50cl, not 75cl');
  PERFORM pg_temp.check((v->>'moved')::numeric = 1500, 'moved 1500: ' || v::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b75) = 0
                        AND (SELECT current_stock FROM products WHERE id = b50) = 1500, 'stock balanced across the two bottles');
  PERFORM pg_temp.check((SELECT output_product_id FROM raw_materials WHERE id = m) = b50, 'preform now makes 50cl');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM preform_stockings s JOIN preform_shift_records r ON r.id = s.shift_record_id
                                     WHERE r.material_id = m AND s.product_id = b75), 'stockings re-pointed');
  PERFORM pg_temp.check((SELECT quantity_in FROM public.qc_bottle_report('4f000000-0000-0000-0000-000000000001',
                           public._pf_today(), public._pf_today()) WHERE product_id = b50) = 1500, 'Bottles report shows 50cl');

  -- Bottles that already left the old bottle's stock block the move.
  UPDATE products SET current_stock = 100 WHERE id = b50;
  e := pg_temp.err(format('SELECT public.correct_preform_bottle(%L, %L, %L)', m, b75, 'back to 75cl'));
  PERFORM pg_temp.check(e LIKE '%only 100 are still in its stock%', 'shortfall named: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 3: the bottle type is chosen per entry; expected bottles = blown - damages go into it (20261023235800)
DO $$
DECLARE v jsonb; s jsonb; e text;
  m uuid := '4c000000-0000-0000-0000-000000000001';
  qc uuid := '4a000000-0000-0000-0000-000000000002';
  b75 uuid := '4d000000-0000-0000-0000-000000000001';
  b50 uuid := '4d000000-0000-0000-0000-000000000002';
BEGIN
  UPDATE products SET current_stock = 0 WHERE id IN (b75, b50);
  PERFORM pg_temp.as_user('2');
  -- The preform usually makes 50cl; this night entry was 75cl: blown 900, damages 30.
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m, 'production_date', public._pf_today(),
         'shift', 'night', 'good_bottles', 870, 'damaged_bottles', 30));
  PERFORM public.set_shift_bottle((v->>'id')::uuid, b75);
  s := public.submit_preform_shift((v->>'id')::uuid);
  PERFORM pg_temp.check(s->>'status' = 'completed', 'completed: ' || s::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b75) = 870
                        AND (SELECT current_stock FROM products WHERE id = b50) = 0, '870 expected bottles into 75cl only');
  PERFORM pg_temp.check((SELECT output_product_id FROM raw_materials WHERE id = m) = b50, 'the usual bottle is unchanged');
  e := pg_temp.err(format('SELECT public.set_shift_bottle(%L, %L)', (v->>'id')::uuid, b50));
  PERFORM pg_temp.check(e LIKE '%already been submitted%', 'cannot change after submit: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 4: a preform is not tied to a bottle -- the entry's bottle is not saved on the preform (20261023235900)
DO $$
DECLARE v jsonb; s jsonb;
  m uuid := '4c000000-0000-0000-0000-000000000001';
  qc uuid := '4a000000-0000-0000-0000-000000000002';
  b75 uuid := '4d000000-0000-0000-0000-000000000001';
BEGIN
  UPDATE raw_materials SET output_product_id = NULL WHERE id = m;
  UPDATE products SET current_stock = 0 WHERE id = b75;
  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', m, 'operator_id', qc, 'bags', 1, 'loose_pieces', 0));
  PERFORM pg_temp.as_user('2');
  PERFORM public.respond_preform_issue((v->>'id')::uuid, true);
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m,
         'production_date', public._pf_today() - 1, 'shift', 'day', 'good_bottles', 100, 'damaged_bottles', 5));
  PERFORM public.set_shift_bottle((v->>'id')::uuid, b75);
  s := public.submit_preform_shift((v->>'id')::uuid);
  PERFORM pg_temp.check(s->>'status' = 'completed', 'completed: ' || s::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = b75) = 100, '100 into 75cl');
  PERFORM pg_temp.check((SELECT output_product_id FROM raw_materials WHERE id = m) IS NULL, 'preform still not tied to a bottle');
END $$;

-- @@ Test 5: bottle type by name -- the existing bottle is used, a missing size is added (20261024000000)
DO $$
DECLARE v jsonb; s jsonb; x jsonb; n_before int;
  m uuid := '4c000000-0000-0000-0000-000000000001';
  qc uuid := '4a000000-0000-0000-0000-000000000002';
  f uuid := '4f000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.as_user('2');
  SELECT count(*) INTO n_before FROM products WHERE factory_id = f;
  -- "75cl Bottles" matches the existing "75cl bottles" (case and spacing ignored).
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m,
         'production_date', public._pf_today() - 2, 'shift', 'day', 'good_bottles', 10, 'damaged_bottles', 1));
  x := public.set_shift_bottle_by_name((v->>'id')::uuid, '  75cl   BOTTLES ');
  PERFORM pg_temp.check(NOT (x->>'created')::boolean AND (x->>'output_product_id')::uuid = '4d000000-0000-0000-0000-000000000001',
                        'existing 75cl used: ' || x::text);
  s := public.submit_preform_shift((v->>'id')::uuid);
  -- "35cl Bottle" does not exist yet: added once, then reused.
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m,
         'production_date', public._pf_today() - 2, 'shift', 'night', 'good_bottles', 20, 'damaged_bottles', 2));
  x := public.set_shift_bottle_by_name((v->>'id')::uuid, '35cl Bottle');
  PERFORM pg_temp.check((x->>'created')::boolean, '35cl added: ' || x::text);
  s := public.submit_preform_shift((v->>'id')::uuid);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE factory_id = f AND name = '35cl Bottle') = 20,
                        '20 good bottles into the new 35cl Bottle');
  PERFORM pg_temp.check((SELECT count(*) FROM products WHERE factory_id = f) = n_before + 1, 'only one product added');
END $$;
