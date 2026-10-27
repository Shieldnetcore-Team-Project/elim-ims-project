-- ============================================================================
-- Acceptance test: QC sends to PM by batch
-- (20261027120000_send_batches_to_pm.sql)
--
-- QC blows two batches; both are listed with their good bottles. Sending one
-- in full drops it from the list; part of the other leaves the rest; a batch
-- cannot be over-sent. Bottle stock no batch accounts for shows as earlier
-- stock. A cancelled transfer puts its batch back on the list.
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('1e000000-0000-0000-0000-000000000001', 'sbpm', 'Send Batches');
INSERT INTO auth.users(id, email) VALUES
  ('1b000000-0000-0000-0000-000000000001', 'store@sbpm'),
  ('1b000000-0000-0000-0000-000000000002', 'qc@sbpm');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '1b000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '1b000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('1b000000-0000-0000-0000-000000000001', 'store_keeper', '1e000000-0000-0000-0000-000000000001'),
  ('1b000000-0000-0000-0000-000000000002', 'qc_officer', '1e000000-0000-0000-0000-000000000001');
-- 200 bottles already in stock from before batches were tracked.
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('1e100000-0000-0000-0000-000000000001', '1e000000-0000-0000-0000-000000000001', '50cl Bottle', 'Piece', 0, 200, 'finished');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform,
                          grams_per_piece, output_product_id) VALUES
  ('1e200000-0000-0000-0000-000000000001', '1e000000-0000-0000-0000-000000000001', 'Prima', 'Piece', 16000, 16000, 1,
   1600, true, 14, '1e100000-0000-0000-0000-000000000001');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '1b000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.left_of(p_ref text) RETURNS numeric LANGUAGE sql AS $$
  SELECT to_send FROM public.pf_unsent_batches('1e000000-0000-0000-0000-000000000001') WHERE reference = p_ref
$$;
CREATE OR REPLACE FUNCTION pg_temp.send(p_ref text, p_qty numeric) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.dispatch_bottle_transfer(jsonb_build_object(
    'client_ref', gen_random_uuid(), 'product_id', '1e100000-0000-0000-0000-000000000001',
    'shift_record_id', (SELECT id FROM preform_shift_records WHERE reference = p_ref),
    'quantity', p_qty, 'to_department', 'PM', 'shift', 'day'))
$$;

-- @@ Test 1: two finished batches are listed; earlier stock shows apart
DO $$
DECLARE v jsonb; i int;
  m uuid := '1e200000-0000-0000-0000-000000000001'; qc uuid := '1b000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', m, 'operator_id', qc, 'bags', 2, 'loose_pieces', 0));
  PERFORM pg_temp.as_user('2');
  PERFORM public.respond_preform_issue((v->>'id')::uuid, true);
  FOR i IN 1..2 LOOP
    v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m, 'production_date', public._pf_today(),
           'shift', 'day', 'good_bottles', 1000 * i, 'damaged_bottles', 5, 'client_ref', gen_random_uuid()));
    PERFORM public.submit_preform_shift((v->>'id')::uuid);
    UPDATE preform_shift_records SET reference = 'BATCH-' || i WHERE id = (v->>'id')::uuid;
  END LOOP;

  PERFORM pg_temp.check(pg_temp.left_of('BATCH-1') = 1000, 'batch 1: 1000 to send');
  PERFORM pg_temp.check(pg_temp.left_of('BATCH-2') = 2000, 'batch 2: 2000 to send');
  PERFORM pg_temp.check((SELECT to_send FROM public.pf_unsent_batches('1e000000-0000-0000-0000-000000000001')
                          WHERE shift_record_id IS NULL) = 200, 'earlier stock 200');
  PERFORM pg_temp.check((SELECT preform FROM public.pf_unsent_batches('1e000000-0000-0000-0000-000000000001')
                          WHERE reference = 'BATCH-1') = 'Prima 14g', 'preform named with grams');
END $$;

-- @@ Test 2: sending drops a batch; part leaves the rest; no over-sending; cancel puts it back
DO $$
DECLARE v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := pg_temp.send('BATCH-1', 1000);
  PERFORM pg_temp.check(pg_temp.left_of('BATCH-1') IS NULL, 'batch 1 gone from the list');
  PERFORM pg_temp.check((SELECT production_reference FROM bottle_transfers WHERE id = (v->>'id')::uuid) = 'BATCH-1',
                        'the transfer carries the batch reference');

  PERFORM pg_temp.send('BATCH-2', 1500);
  PERFORM pg_temp.check(pg_temp.left_of('BATCH-2') = 500, 'batch 2: 500 left');
  e := pg_temp.err($q$SELECT pg_temp.send('BATCH-2', 501)$q$);
  PERFORM pg_temp.check(e LIKE '%only 500 bottles left%', 'over-sending refused: ' || COALESCE(e, 'no error'));

  PERFORM public.cancel_bottle_transfer((v->>'id')::uuid, 'wrong day');
  PERFORM pg_temp.check(pg_temp.left_of('BATCH-1') = 1000, 'cancelled: batch 1 back');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = '1e100000-0000-0000-0000-000000000001') = 1700,
                        'stock: 200 + 3000 - 1500');
END $$;
