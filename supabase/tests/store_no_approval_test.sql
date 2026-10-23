-- ============================================================================
-- Acceptance tests: Store stock adjustments without approval
-- (20261023130000_store_stock_counts_no_approval.sql) and editing a
-- material's brand (20261023110000_store_materials_brands.sql).
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test. Uses its own factory, users, material and product.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fe000000-0000-0000-0000-000000000001', 'natest', 'No Approval Factory');
INSERT INTO auth.users(id, email) VALUES
  ('ae000000-0000-0000-0000-000000000001', 'inventory@na'),
  ('ae000000-0000-0000-0000-000000000002', 'chairman@na');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'ae000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE 'ae000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('ae000000-0000-0000-0000-000000000001', 'inventory_officer', 'fe000000-0000-0000-0000-000000000001'),
  ('ae000000-0000-0000-0000-000000000002', 'chairman', NULL);

INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost) VALUES
  ('ce000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'NA Caps', 'Piece', 100, 1000, 10);
INSERT INTO products(id, factory_id, name, sku, current_stock) VALUES
  ('ee000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'NA Water', 'NA-1', 50);
INSERT INTO brands(id, factory_id, name, category, grammage, pack_quantity) VALUES
  ('be000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'NA Brand', 'Carton', '29mm', 4800);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'ae000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: a raw-material adjustment (Store → Adjust Stock) is in stock at once
DO $$
DECLARE v jsonb; r record;
BEGIN
  PERFORM pg_temp.as_user('1');
  v := public.request_stock_adjustment('{"entity_type":"raw_material","material_id":"ce000000-0000-0000-0000-000000000001","quantity_delta":250,"reason":"Physical stock count correction"}');
  PERFORM pg_temp.check((v->>'posted')::boolean AND (v->>'current_stock')::numeric = 350, 'posted, stock 350: ' || v::text);
  SELECT * INTO r FROM stock_adjustment_requests WHERE id = (v->>'id')::uuid;
  PERFORM pg_temp.check(r.status = 'posted' AND r.reviewed_by = r.submitted_by, 'request posted by the person who made it');
  PERFORM pg_temp.check((SELECT current_value FROM raw_materials WHERE id = 'ce000000-0000-0000-0000-000000000001') = 3500,
                        'valued at the material cost');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM raw_material_movements WHERE reference = r.reference_number
                                  AND quantity_before = 100 AND quantity_after = 350), 'ledger line with before/after');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM notifications WHERE body LIKE r.reference_number || '%'),
                        'no awaiting-approval notification');
END $$;

-- @@ Test 2: stock cannot go below zero; reductions post at the average cost
DO $$
DECLARE e text; v jsonb;
BEGIN
  PERFORM pg_temp.as_user('1');
  e := pg_temp.err($q$SELECT public.request_stock_adjustment('{"entity_type":"raw_material","material_id":"ce000000-0000-0000-0000-000000000001","quantity_delta":-400,"reason":"Physical stock count correction"}')$q$);
  PERFORM pg_temp.check(e LIKE '%below zero%', 'below zero refused: ' || COALESCE(e, 'no error'));
  v := public.request_stock_adjustment('{"entity_type":"raw_material","material_id":"ce000000-0000-0000-0000-000000000001","quantity_delta":-50,"reason":"Physical stock count correction"}');
  PERFORM pg_temp.check((SELECT current_stock = 300 AND current_value = 3000 FROM raw_materials
                          WHERE id = 'ce000000-0000-0000-0000-000000000001'), 'reduced by 50 at 10 each');
END $$;

-- @@ Test 3: finished goods (Warehouse) adjustments still wait for approval
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := public.request_stock_adjustment('{"entity_type":"finished_good","product_id":"ee000000-0000-0000-0000-000000000001","quantity_delta":5,"reason":"Physical stock count correction"}');
  PERFORM pg_temp.check((SELECT status FROM stock_adjustment_requests WHERE id = (v->>'id')::uuid) = 'pending_approval',
                        'finished good adjustment pending');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'ee000000-0000-0000-0000-000000000001') = 50,
                        'product stock untouched');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM notifications WHERE body LIKE (v->>'reference_number') || '%' AND NOT read),
                        'approver notified');
END $$;

-- @@ Test 4: the Store's Edit form can set a material's brand
SELECT set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
SET ROLE authenticated;
UPDATE raw_materials SET brand_id = 'be000000-0000-0000-0000-000000000001'
 WHERE id = 'ce000000-0000-0000-0000-000000000001';
RESET ROLE;
DO $$
BEGIN
  PERFORM pg_temp.check((SELECT brand_id FROM raw_materials WHERE id = 'ce000000-0000-0000-0000-000000000001')
                          = 'be000000-0000-0000-0000-000000000001', 'brand set by the Store');
END $$;

-- @@ Test 5: anyone in the factory can mark a factory-wide notification read (20261023140000)
INSERT INTO notifications(id, factory_id, title, body) VALUES
  ('de000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'Deletion requested', 'Suppliers "X" — reason: test');
INSERT INTO notifications(id, user_id, factory_id, title, body) VALUES
  ('de000000-0000-0000-0000-000000000002', 'ae000000-0000-0000-0000-000000000002', 'fe000000-0000-0000-0000-000000000001', 'Account approved', 'For the chairman');
SELECT set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
SET ROLE authenticated;
UPDATE notifications SET read = true
 WHERE id IN ('de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-000000000002');
RESET ROLE;
DO $$
BEGIN
  PERFORM pg_temp.check((SELECT read FROM notifications WHERE id = 'de000000-0000-0000-0000-000000000001'),
                        'factory-wide notification marked read');
  PERFORM pg_temp.check(NOT (SELECT read FROM notifications WHERE id = 'de000000-0000-0000-0000-000000000002'),
                        'someone else''s personal notification untouched');
END $$;
