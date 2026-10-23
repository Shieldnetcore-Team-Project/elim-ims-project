-- ============================================================================
-- Acceptance tests: security review hardening
-- (20261023180000_security_review_hardening.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test. Two factories: A (the users' own) and B (someone else's).
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES
  ('9f000000-0000-0000-0000-00000000000a', 'secA', 'Security Factory A'),
  ('9f000000-0000-0000-0000-00000000000b', 'secB', 'Security Factory B');
INSERT INTO auth.users(id, email) VALUES
  ('9a000000-0000-0000-0000-000000000001', 'inventory@sec'),
  ('9a000000-0000-0000-0000-000000000002', 'qc@sec');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '9a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '9a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('9a000000-0000-0000-0000-000000000001', 'inventory_officer', '9f000000-0000-0000-0000-00000000000a'),
  ('9a000000-0000-0000-0000-000000000002', 'qc_officer', '9f000000-0000-0000-0000-00000000000a');

INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost) VALUES
  ('9c000000-0000-0000-0000-00000000000a', '9f000000-0000-0000-0000-00000000000a', 'Caps A', 'Piece', 100, 100, 1),
  ('9c000000-0000-0000-0000-00000000000b', '9f000000-0000-0000-0000-00000000000b', 'Caps B', 'Piece', 100, 100, 1);
INSERT INTO suppliers(id, factory_id, name) VALUES
  ('9d000000-0000-0000-0000-00000000000a', '9f000000-0000-0000-0000-00000000000a', 'Dealer A'),
  ('9d000000-0000-0000-0000-00000000000b', '9f000000-0000-0000-0000-00000000000b', 'Dealer B');
INSERT INTO brands(id, factory_id, name, category, supplier_id) VALUES
  ('9b000000-0000-0000-0000-00000000000a', '9f000000-0000-0000-0000-00000000000a', 'Brand A', 'Carton', '9d000000-0000-0000-0000-00000000000a'),
  ('9b000000-0000-0000-0000-00000000000b', '9f000000-0000-0000-0000-00000000000b', 'Brand B', 'Carton', '9d000000-0000-0000-0000-00000000000b');
INSERT INTO notifications(id, factory_id, title, body) VALUES
  ('9e000000-0000-0000-0000-00000000000a', '9f000000-0000-0000-0000-00000000000a', 'Deletion requested', 'Suppliers "X" — reason: a'),
  ('9e000000-0000-0000-0000-00000000000b', '9f000000-0000-0000-0000-00000000000b', 'Deletion requested', 'Suppliers "Y" — reason: b');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '9a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: stock of another factory cannot be adjusted or issued
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('1');
  e := pg_temp.err($q$SELECT public.request_stock_adjustment('{"entity_type":"raw_material","material_id":"9c000000-0000-0000-0000-00000000000b","quantity_delta":50,"reason":"Physical stock count correction"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'adjust B refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.issue_raw_material('{"material_id":"9c000000-0000-0000-0000-00000000000b","quantity":10,"purpose":"general"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'issue from B refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = '9c000000-0000-0000-0000-00000000000b') = 100,
                        'B untouched');
  -- Own factory still works.
  PERFORM public.request_stock_adjustment('{"entity_type":"raw_material","material_id":"9c000000-0000-0000-0000-00000000000a","quantity_delta":50,"reason":"Physical stock count correction"}');
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = '9c000000-0000-0000-0000-00000000000a') = 150,
                        'A adjusted');
END $$;

-- @@ Test 2: notifications -- only the read flag, only your factory's
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('1');
  SET LOCAL ROLE authenticated;
  e := pg_temp.err($q$UPDATE notifications SET body = 'changed' WHERE id = '9e000000-0000-0000-0000-00000000000a'$q$);
  UPDATE notifications SET read = true
   WHERE id IN ('9e000000-0000-0000-0000-00000000000a', '9e000000-0000-0000-0000-00000000000b');
  RESET ROLE;
  PERFORM pg_temp.check(e LIKE '%permission denied%', 'text cannot be edited: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((SELECT read FROM notifications WHERE id = '9e000000-0000-0000-0000-00000000000a'), 'own factory marked read');
  PERFORM pg_temp.check(NOT (SELECT read FROM notifications WHERE id = '9e000000-0000-0000-0000-00000000000b'),
                        'other factory untouched');
END $$;

-- @@ Test 3: brands stay inside their factory
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('1');
  SET LOCAL ROLE authenticated;
  e := pg_temp.err($q$INSERT INTO brands(factory_id, name, category) VALUES ('9f000000-0000-0000-0000-00000000000b', 'Sneaky', 'Bag')$q$);
  RESET ROLE;
  PERFORM pg_temp.check(e LIKE '%row-level security%', 'no brand in B: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$INSERT INTO brands(factory_id, name, category, supplier_id) VALUES ('9f000000-0000-0000-0000-00000000000a', 'Mixed', 'Bag', '9d000000-0000-0000-0000-00000000000b')$q$);
  PERFORM pg_temp.check(e LIKE '%same factory%', 'dealer of B refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$UPDATE raw_materials SET brand_id = '9b000000-0000-0000-0000-00000000000b' WHERE id = '9c000000-0000-0000-0000-00000000000a'$q$);
  PERFORM pg_temp.check(e LIKE '%same factory%', 'brand of B on a material of A refused: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 4: a brand in use cannot be deleted
DO $$
DECLARE e text;
BEGIN
  UPDATE raw_materials SET brand_id = '9b000000-0000-0000-0000-00000000000a' WHERE id = '9c000000-0000-0000-0000-00000000000a';
  e := pg_temp.err($q$DELETE FROM brands WHERE id = '9b000000-0000-0000-0000-00000000000a'$q$);
  PERFORM pg_temp.check(e LIKE '%foreign key%', 'in-use brand kept: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((SELECT brand_id FROM raw_materials WHERE id = '9c000000-0000-0000-0000-00000000000a')
                          = '9b000000-0000-0000-0000-00000000000a', 'material keeps its brand');
END $$;

-- @@ Test 5: whoever issued stock to QC cannot also confirm receiving it
DO $$
DECLARE e text; rid uuid;
BEGIN
  PERFORM pg_temp.as_user('1');
  PERFORM public.issue_raw_material('{"material_id":"9c000000-0000-0000-0000-00000000000a","quantity":10,"purpose":"general","issued_to_department":"quality_control"}');
  SELECT id INTO rid FROM qc_store_receipts WHERE material_id = '9c000000-0000-0000-0000-00000000000a';
  e := pg_temp.err(format('SELECT public.qc_confirm_store_receipt(%L)', rid));
  PERFORM pg_temp.check(e LIKE '%You issued this stock%', 'issuer cannot confirm: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('2');
  PERFORM public.qc_confirm_store_receipt(rid);
  PERFORM pg_temp.check((SELECT status FROM qc_store_receipts WHERE id = rid) = 'confirmed', 'QC confirms');
END $$;
