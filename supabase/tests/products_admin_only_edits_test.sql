-- ============================================================================
-- Acceptance tests: only an administrator edits products
-- (20261101110000_products_admin_only_edits.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A Warehouse user with finished-goods
-- rights can no longer rename or reprice a product; the admin can; stock
-- still moves for the Warehouse user.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3900000-0000-0000-0000-000000000001', 'pafac', 'PA Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a3900000-0000-0000-0000-000000000001', 'admin@pa'),
  ('a3900000-0000-0000-0000-000000000002', 'wh@pa');
INSERT INTO roles(slug, label, is_system) VALUES ('pa_wh_test', 'Warehouse (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'pa_wh_test', m::module_key, a::action_key
  FROM unnest(ARRAY['finished-goods', 'costing', 'distribution']) m, unnest(ARRAY['view', 'create', 'edit', 'delete']) a
ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id IN ('a3900000-0000-0000-0000-000000000001', 'a3900000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a3900000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('a3900000-0000-0000-0000-000000000002', 'pa_wh_test', 'f3900000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, cost_price, current_stock, product_type) VALUES
  ('b3900000-0000-0000-0000-000000000001', 'f3900000-0000-0000-0000-000000000001', 'PA Water', 'Pack', 1000, 600, 50, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3900000-0000-0000-0000-000000000001', 'f3900000-0000-0000-0000-000000000001', 'PA Rep', 'active', 'rep');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: the Warehouse user can't rename, reprice or change the cost
DO $$
DECLARE e text; p uuid := 'b3900000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000002', false);
  e := pg_temp.err(format($q$UPDATE products SET name = 'Renamed' WHERE id = '%s'$q$, p));
  PERFORM pg_temp.check(e LIKE '%Only an administrator%', 'rename refused: ' || COALESCE(e, 'none'));
  e := pg_temp.err(format($q$SELECT public.set_product_prices('[{"id":"%s","unit_price":1200}]')$q$, p));
  PERFORM pg_temp.check(e LIKE '%Only an administrator%', 'price refused: ' || COALESCE(e, 'none'));
  e := pg_temp.err(format($q$SELECT public.set_product_cost_price('%s', 700)$q$, p));
  PERFORM pg_temp.check(e LIKE '%Only an administrator%', 'cost refused: ' || COALESCE(e, 'none'));
  PERFORM pg_temp.check((SELECT name = 'PA Water' AND unit_price = 1000 AND cost_price = 600 FROM products WHERE id = p),
                        'unchanged');
END $$;

-- @@ Test 2: stock still moves for the Warehouse user (a posting)
DO $$
BEGIN
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000002', false);
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f3900000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3900000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3900000-0000-0000-0000-000000000001', 'quantity', 5))));
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b3900000-0000-0000-0000-000000000001') = 45,
                        'stock 50 - 5');
END $$;

-- @@ Test 3: the admin renames and reprices; every reader sees it
DO $$
DECLARE p uuid := 'b3900000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000001', false);
  UPDATE products SET name = 'PA Table Water', unit = 'Carton' WHERE id = p;
  PERFORM public.set_product_prices(jsonb_build_array(jsonb_build_object('id', p, 'unit_price', 1200)));
  PERFORM public.set_product_cost_price(p, 700);
  PERFORM pg_temp.check((SELECT name = 'PA Table Water' AND unit = 'Carton' AND unit_price = 1200 AND cost_price = 700
                           FROM products WHERE id = p), 'admin changes saved');
END $$;
