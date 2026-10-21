-- ============================================================================
-- Acceptance tests: Warehouse Manager role (20261021110000_warehouse_manager_role.sql)
--
-- Same harness as preform_inventory_test.sql (supabase/tests/pglite/README.md).
-- Uses its own factory, users, marketer and product; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9000000-0000-0000-0000-000000000001', 'wmtest', 'Warehouse Manager Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a9000000-0000-0000-0000-000000000001', 'gideon.wm@test'),
  ('a9000000-0000-0000-0000-000000000002', 'twin.a@test'),
  ('a9000000-0000-0000-0000-000000000003', 'twin.b@test');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'a9000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
UPDATE profiles SET full_name = 'Gideon Test' WHERE id = 'a9000000-0000-0000-0000-000000000001';
UPDATE profiles SET full_name = 'Twin Sam' WHERE id IN ('a9000000-0000-0000-0000-000000000002', 'a9000000-0000-0000-0000-000000000003');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a9000000-0000-0000-0000-000000000001', 'store_officer', 'f9000000-0000-0000-0000-000000000001'),
  ('a9000000-0000-0000-0000-000000000001', 'sales', 'f9000000-0000-0000-0000-000000000001');
INSERT INTO permission_overrides(user_id, module, action, granted)
VALUES ('a9000000-0000-0000-0000-000000000001', 'expenses', 'view', true);
INSERT INTO sales_reps(id, factory_id, code, full_name, status, kind) VALUES
  ('e9000000-0000-0000-0000-000000000001', 'f9000000-0000-0000-0000-000000000001', 'WM-01', 'Test Marketer', 'active', 'rep');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('d9000000-0000-0000-0000-000000000001', 'f9000000-0000-0000-0000-000000000001', 'Test Sachet', 'Bag', 300, 50, 'finished');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: Gideon becomes Warehouse Manager only -- Warehouse stock and Distribution, nothing else
DO $$
DECLARE g uuid := 'a9000000-0000-0000-0000-000000000001'; r text;
BEGIN
  -- Ambiguous names are never guessed.
  r := public._assign_warehouse_manager('twin');
  PERFORM pg_temp.check(r LIKE 'Skipped: 2 accounts%', 'two matches skipped: ' || r);
  r := public._assign_warehouse_manager('nobody-by-this-name');
  PERFORM pg_temp.check(r LIKE 'Skipped: 0 accounts%', 'no match skipped: ' || r);

  r := public._assign_warehouse_manager('gideon');
  PERFORM pg_temp.check(r LIKE '%is now Warehouse Manager only', r);
  PERFORM pg_temp.check((SELECT array_agg(role) FROM user_roles WHERE user_id = g) = ARRAY['warehouse_manager'],
                        'only the Warehouse Manager role is left');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM permission_overrides WHERE user_id = g), 'extra overrides removed');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'assign_role' AND entity_id = g::text
                                   AND jsonb_array_length(old_value->'roles') = 2), 'previous roles kept in the audit log');

  -- Can: Warehouse stock, Distribution, post a dispatch.
  PERFORM pg_temp.check(public.has_permission(g, 'finished-goods'::module_key, 'view'::action_key), 'sees Warehouse stock');
  PERFORM pg_temp.check(public.has_permission(g, 'finished-goods'::module_key, 'read'::access_level), 'can read products');
  PERFORM pg_temp.check(public.has_permission(g, 'distribution'::module_key, 'create'::action_key), 'can post dispatches');
  -- Cannot: anything else.
  PERFORM pg_temp.check(NOT public.has_permission(g, 'distribution'::module_key, 'reverse'::action_key), 'cannot reverse a dispatch');
  PERFORM pg_temp.check(NOT public.has_permission(g, 'distribution'::module_key, 'cancel'::action_key), 'cannot cancel a dispatch');
  PERFORM pg_temp.check(NOT public.has_permission(g, 'finished-goods'::module_key, 'edit'::action_key), 'cannot edit products');
  PERFORM pg_temp.check(NOT public.has_permission(g, 'sales'::module_key, 'view'::action_key), 'no Sales');
  PERFORM pg_temp.check(NOT public.has_permission(g, 'production'::module_key, 'view'::action_key), 'no Production');
  PERFORM pg_temp.check(NOT public.has_permission(g, 'raw-materials'::module_key, 'view'::action_key), 'no Store');
  PERFORM pg_temp.check(NOT public.has_permission(g, 'expenses'::module_key, 'view'::action_key), 'no Expenses (override gone)');
  PERFORM pg_temp.check(NOT public.has_permission(g, 'goods-receiving'::module_key, 'view'::action_key), 'no Quality Control');

  PERFORM set_config('test.uid', g::text, false);
  PERFORM public.create_stock_dispatch(jsonb_build_object(
    'factory_id', 'f9000000-0000-0000-0000-000000000001', 'sales_rep_id', 'e9000000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'd9000000-0000-0000-0000-000000000001', 'quantity', 10))));
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'd9000000-0000-0000-0000-000000000001') = 40,
                        'Gideon posted 10 to the marketer; Warehouse stock 50 -> 40');
END $$;
