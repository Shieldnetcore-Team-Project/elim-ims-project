-- ============================================================================
-- Acceptance tests: Store restock (20261022110000_store_restock.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test. Uses its own factory, users, supplier and material.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES
  ('f6000000-0000-0000-0000-000000000001', 'rstest', 'Restock Test Factory'),
  ('f6000000-0000-0000-0000-000000000002', 'rstest2', 'Other Restock Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a6000000-0000-0000-0000-000000000001', 'store@rs'),
  ('a6000000-0000-0000-0000-000000000002', 'qc@rs'),
  ('a6000000-0000-0000-0000-000000000003', 'otherstore@rs');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'a6000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);

INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a6000000-0000-0000-0000-000000000001', 'store_officer', 'f6000000-0000-0000-0000-000000000001'),
  ('a6000000-0000-0000-0000-000000000002', 'qc_officer', 'f6000000-0000-0000-0000-000000000001'),
  ('a6000000-0000-0000-0000-000000000003', 'store_officer', 'f6000000-0000-0000-0000-000000000002');

INSERT INTO suppliers(id, factory_id, name) VALUES
  ('b6000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', 'Test Cap Supplier');
-- 100 caps in stock worth 1,000 (10 each).
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost) VALUES
  ('c6000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', 'Test Caps', 'Piece', 100, 1000, 10);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'a6000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: the Store restocks a supplier delivery; stock, value and ledgers update at once
DO $$
DECLARE v jsonb; r record;
BEGIN
  PERFORM pg_temp.as_user('1');
  v := public.restock_raw_material('{"material_id":"c6000000-0000-0000-0000-000000000001","quantity":50,"damaged_quantity":5,"unit_cost":12,"supplier_id":"b6000000-0000-0000-0000-000000000001","delivery_reference":"WB-1","client_ref":"d6000000-0000-0000-0000-000000000001"}');
  SELECT * INTO r FROM raw_materials WHERE id = 'c6000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(r.current_stock = 145, 'stock 100 + 45 accepted = 145, got ' || r.current_stock);
  PERFORM pg_temp.check(r.current_value = 1540, 'value 1000 + 45 x 12 = 1540, got ' || r.current_value);
  PERFORM pg_temp.check(r.unit_cost = 12 AND r.supplier_id = 'b6000000-0000-0000-0000-000000000001', 'cost and supplier updated');
  SELECT * INTO r FROM goods_receipts WHERE id = (v->>'id')::uuid;
  PERFORM pg_temp.check(r.status = 'posted' AND r.restocked_directly AND r.confirmed_by = r.submitted_by, 'receipt posted directly');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM raw_material_movements WHERE reference = r.receipt_number
                           AND movement_type = 'received' AND quantity = 45) = 1, 'one received movement of 45');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM damage_records WHERE source_reference = r.receipt_number AND quantity = 5) = 1,
                        'the 5 damaged go to the damage ledger');
  -- A double click restocks once.
  v := public.restock_raw_material('{"material_id":"c6000000-0000-0000-0000-000000000001","quantity":50,"damaged_quantity":5,"unit_cost":12,"client_ref":"d6000000-0000-0000-0000-000000000001"}');
  PERFORM pg_temp.check((v->>'duplicate')::boolean, 'duplicate recognised');
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = 'c6000000-0000-0000-0000-000000000001') = 145,
                        'no double stock');
END $$;

-- @@ Test 2: bad quantities, other roles and other factories are refused
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('1');
  e := pg_temp.err($q$SELECT public.restock_raw_material('{"material_id":"c6000000-0000-0000-0000-000000000001","quantity":0}')$q$);
  PERFORM pg_temp.check(e LIKE '%must be > 0%', 'zero refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err($q$SELECT public.restock_raw_material('{"material_id":"c6000000-0000-0000-0000-000000000001","quantity":10,"damaged_quantity":11}')$q$);
  PERFORM pg_temp.check(e LIKE '%Damaged quantity%', 'damaged > supplied refused: ' || COALESCE(e, 'no error'));
  -- QC submits receipts for the Store to confirm; she cannot restock directly.
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT public.restock_raw_material('{"material_id":"c6000000-0000-0000-0000-000000000001","quantity":10}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'QC cannot restock: ' || COALESCE(e, 'no error'));
  -- A Store officer of another factory cannot restock this one.
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err($q$SELECT public.restock_raw_material('{"material_id":"c6000000-0000-0000-0000-000000000001","quantity":10}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'other factory refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = 'c6000000-0000-0000-0000-000000000001') = 145,
                        'nothing moved');
END $$;
