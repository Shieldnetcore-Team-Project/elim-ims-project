-- ============================================================================
-- Acceptance tests: Sales staff read the finished products
-- (20261101130000_sales_reads_finished_products.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A user whose only right is Sales
-- view (like the shop's staff) reads the products as the
-- app does, under row-level security.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('a4100000-0000-0000-0000-000000000001', 'shop@salesread');
INSERT INTO roles(slug, label, is_system) VALUES ('sales_viewer_test', 'Sales viewer (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action) VALUES ('sales_viewer_test', 'sales', 'view') ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id = 'a4100000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'a4100000-0000-0000-0000-000000000001', 'sales_viewer_test', id FROM factories WHERE code = 'water';
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type, active)
SELECT v.id::uuid, f.id, v.n, 'Piece', 0, 0, v.t, true FROM factories f,
  (VALUES ('b4100000-0000-0000-0000-000000000001', 'SR Dispenser/Jug Water (New Jug)', 'finished'),
          ('b4100000-0000-0000-0000-000000000002', 'SR Empty Bottle', 'semi_finished')) v(id, n, t)
 WHERE f.code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.check(boolean, text) TO authenticated;

-- @@ Test 1: the dispenser shows for Sales; a non-finished product stays hidden
SELECT set_config('test.uid', 'a4100000-0000-0000-0000-000000000001', false);
SET ROLE authenticated;
SELECT pg_temp.check((SELECT count(*) FROM products WHERE id = 'b4100000-0000-0000-0000-000000000001') = 1,
                     'finished dispenser visible');
SELECT pg_temp.check((SELECT count(*) FROM products WHERE id = 'b4100000-0000-0000-0000-000000000002') = 0,
                     'semi-finished not opened up');
RESET ROLE;

-- @@ Test 2: without Sales view, nothing extra is visible
SELECT set_config('test.uid', '', false);
DELETE FROM role_permissions WHERE role = 'sales_viewer_test';
SELECT set_config('test.uid', 'a4100000-0000-0000-0000-000000000001', false);
SET ROLE authenticated;
SELECT pg_temp.check((SELECT count(*) FROM products WHERE id = 'b4100000-0000-0000-0000-000000000001') = 0,
                     'hidden without Sales view');
RESET ROLE;
