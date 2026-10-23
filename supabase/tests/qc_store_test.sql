-- ============================================================================
-- Acceptance tests: Quality Control's store (20261023160000_qc_store.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test. Uses its own factory, users and material.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('ff000000-0000-0000-0000-000000000001', 'qcstest', 'QC Store Factory');
INSERT INTO auth.users(id, email) VALUES
  ('af000000-0000-0000-0000-000000000001', 'store@qcs'),
  ('af000000-0000-0000-0000-000000000002', 'joy@qcs');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'af000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE 'af000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('af000000-0000-0000-0000-000000000001', 'store_keeper', 'ff000000-0000-0000-0000-000000000001'),
  ('af000000-0000-0000-0000-000000000002', 'qc_officer', 'ff000000-0000-0000-0000-000000000001');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag) VALUES
  ('cf000000-0000-0000-0000-000000000001', 'ff000000-0000-0000-0000-000000000001', 'QCS Preform', 'Piece', 14280, 14280, 1, 1428);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'af000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.receipt() RETURNS uuid LANGUAGE sql AS
  $$ SELECT id FROM qc_store_receipts WHERE material_id = 'cf000000-0000-0000-0000-000000000001' ORDER BY issued_at LIMIT 1 $$;

-- @@ Test 1: an issue to Quality Control waits for QC; one to Production does not
DO $$
DECLARE r record;
BEGIN
  PERFORM pg_temp.as_user('1');
  PERFORM public.issue_raw_material('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":2856,"purpose":"general","issued_to_department":"quality_control","issued_to_user":"af000000-0000-0000-0000-000000000002","reason":"For testing"}');
  PERFORM public.issue_raw_material('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":1428,"purpose":"production","issued_to_department":"production"}');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM qc_store_receipts WHERE material_id = 'cf000000-0000-0000-0000-000000000001') = 1,
                        'only the QC issue is listed for QC');
  SELECT * INTO r FROM qc_store_receipts WHERE id = pg_temp.receipt();
  PERFORM pg_temp.check(r.status = 'pending' AND r.quantity = 2856 AND r.issued_to_user = 'af000000-0000-0000-0000-000000000002'
                        AND r.issued_by = 'af000000-0000-0000-0000-000000000001', 'pending, 2856 pieces, to Joy, by the Store');
END $$;

-- @@ Test 2: nothing can be used before it is confirmed; only QC confirms
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":1,"reason":"Test"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Only 0%available%', 'nothing available before confirming: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('1');
  e := pg_temp.err(format('SELECT public.qc_confirm_store_receipt(%L)', pg_temp.receipt()));
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'the Store cannot confirm for QC: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('2');
  PERFORM public.qc_confirm_store_receipt(pg_temp.receipt());
  PERFORM pg_temp.check((SELECT status = 'confirmed' AND confirmed_by = 'af000000-0000-0000-0000-000000000002'
                           FROM qc_store_receipts WHERE id = pg_temp.receipt()), 'confirmed by Joy');
END $$;

-- @@ Test 3: QC uses up to what it has, once per click
DO $$
DECLARE e text; v jsonb;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":1428,"reason":"Burst test","client_ref":"d0000000-0000-0000-0000-0000000000f1"}');
  PERFORM pg_temp.check((v->>'available')::numeric = 1428, 'one bag left: ' || v::text);
  v := public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":1428,"reason":"Burst test","client_ref":"d0000000-0000-0000-0000-0000000000f1"}');
  PERFORM pg_temp.check((v->>'duplicate')::boolean, 'a double click records once');
  e := pg_temp.err($q$SELECT public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":1429,"reason":"Too much"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Only 1428%', 'over-use refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":1,"reason":" "}')$q$);
  PERFORM pg_temp.check(e LIKE '%used for%', 'a reason is required: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM qc_store_usage WHERE material_id = 'cf000000-0000-0000-0000-000000000001') = 1428,
                        'out = 1428');
END $$;

-- @@ Test 4: QC issues stock to Production from what it has (20261023170000)
INSERT INTO auth.users(id, email) VALUES ('af000000-0000-0000-0000-000000000003', 'pm@qcs');
INSERT INTO profiles(id, email, full_name)
SELECT 'af000000-0000-0000-0000-000000000003', 'pm@qcs', 'Ade PM'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = 'af000000-0000-0000-0000-000000000003');
UPDATE profiles SET full_name = 'Ade PM' WHERE id = 'af000000-0000-0000-0000-000000000003';
DELETE FROM user_roles WHERE user_id = 'af000000-0000-0000-0000-000000000003';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('af000000-0000-0000-0000-000000000003', 'production', 'ff000000-0000-0000-0000-000000000001');
DO $$
DECLARE e text; v jsonb; r record;
BEGIN
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":10,"issued_to_department":"production","issued_to_user":"af000000-0000-0000-0000-000000000001"}')$q$);
  PERFORM pg_temp.check(e LIKE '%not in Production%', 'only a Production person: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":10,"issued_to_department":"warehouse"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Production only%', 'Production only: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":1429,"issued_to_department":"production"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Only 1428%', 'not more than QC has: ' || COALESCE(e, 'no error'));
  v := public.qc_record_store_usage('{"material_id":"cf000000-0000-0000-0000-000000000001","quantity":428,"issued_to_department":"production","issued_to_user":"af000000-0000-0000-0000-000000000003","reason":"Line 2"}');
  PERFORM pg_temp.check((v->>'available')::numeric = 1000, 'QC has 1000 left: ' || v::text);
  SELECT * INTO r FROM qc_store_usage WHERE id = (v->>'id')::uuid;
  PERFORM pg_temp.check(r.issued_to_department = 'production' AND r.issued_to_user = 'af000000-0000-0000-0000-000000000003'
                        AND r.reason = 'Issued to Production — Ade PM: Line 2', 'recorded to Ade: ' || r.reason);
END $$;
