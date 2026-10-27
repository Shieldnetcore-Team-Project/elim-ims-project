-- ============================================================================
-- Acceptance test: QC sees the bottles she sends to PM
-- (20261027090000_qc_reads_bottle_products.sql)
--
-- Replays the failure: QC (no finished-goods read) blows bottles into a
-- 'finished'-type bottle product; the Send-to-production box listed nothing
-- for her. Now pf_bottle_products lists it, she can read its name through
-- RLS, and she still cannot read the rest of the catalogue.
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('1f000000-0000-0000-0000-000000000001', 'qcbp', 'QC Bottle Products');
INSERT INTO auth.users(id, email) VALUES
  ('1a000000-0000-0000-0000-000000000001', 'store@qcbp'),
  ('1a000000-0000-0000-0000-000000000002', 'qc@qcbp');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '1a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '1a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('1a000000-0000-0000-0000-000000000001', 'store_keeper', '1f000000-0000-0000-0000-000000000001'),
  ('1a000000-0000-0000-0000-000000000002', 'qc_officer', '1f000000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('1d000000-0000-0000-0000-000000000001', '1f000000-0000-0000-0000-000000000001', '75cl bottles', 'Piece', 0, 0, 'finished'),
  ('1d000000-0000-0000-0000-000000000002', '1f000000-0000-0000-0000-000000000001', 'Table water 75cl', 'Piece', 0, 40, 'finished');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform,
                          output_product_id) VALUES
  ('1c000000-0000-0000-0000-000000000001', '1f000000-0000-0000-0000-000000000001', 'YUNO MOLD', 'Piece', 16000, 16000, 1,
   1600, true, '1d000000-0000-0000-0000-000000000001');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '1a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: QC blows into a finished-type bottle; it is listed for sending to PM
DO $$
DECLARE v jsonb; s jsonb;
  m uuid := '1c000000-0000-0000-0000-000000000001';
  qc uuid := '1a000000-0000-0000-0000-000000000002';
  b75 uuid := '1d000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', m, 'operator_id', qc, 'bags', 2, 'loose_pieces', 0));
  PERFORM pg_temp.as_user('2');
  PERFORM public.respond_preform_issue((v->>'id')::uuid, true);
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m, 'production_date', public._pf_today(),
         'shift', 'day', 'good_bottles', 1500, 'damaged_bottles', 20, 'client_ref', gen_random_uuid()));
  s := public.submit_preform_shift((v->>'id')::uuid);
  PERFORM pg_temp.check(s->>'status' = 'completed', 'completed: ' || s::text);

  PERFORM pg_temp.check(
    (SELECT current_stock FROM public.pf_bottle_products('1f000000-0000-0000-0000-000000000001') WHERE id = b75) = 1500,
    'the 1500 good bottles are in the Send-to-production list');
  PERFORM pg_temp.check(
    NOT EXISTS (SELECT 1 FROM public.pf_bottle_products('1f000000-0000-0000-0000-000000000001')
                 WHERE id = '1d000000-0000-0000-0000-000000000002'),
    'finished water is not a bottle');
END $$;

-- @@ Test 2: through RLS, QC reads the bottle product but not the rest of the catalogue
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.as_user('2');
  PERFORM pg_temp.check(
    (SELECT name FROM products WHERE id = '1d000000-0000-0000-0000-000000000001') = '75cl bottles',
    'QC reads the bottle name');
  PERFORM pg_temp.check(
    NOT EXISTS (SELECT 1 FROM products WHERE id = '1d000000-0000-0000-0000-000000000002'),
    'QC still cannot read other products');
END $$;
RESET ROLE;
