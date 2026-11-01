-- ============================================================================
-- Acceptance tests: Warehouse staff handle only their own products
-- (20261101140000_warehouse_product_assignments.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. "Kemi" handles bottle water; "Gideon"
-- dispensers and sachet; a third officer has no rule.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9200000-0000-0000-0000-000000000001', 'wpfac', 'WP Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a4200000-0000-0000-0000-000000000001', 'kemi@wp'),
  ('a4200000-0000-0000-0000-000000000002', 'gideon@wp'),
  ('a4200000-0000-0000-0000-000000000003', 'other@wp');
INSERT INTO roles(slug, label, is_system) VALUES ('wp_wh_test', 'Warehouse (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'wp_wh_test', m::module_key, a::action_key
  FROM unnest(ARRAY['finished-goods', 'distribution', 'sales']) m,
       unnest(ARRAY['view', 'create', 'edit', 'submit', 'confirm']) a
ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id::text LIKE 'a4200000-%';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT u::uuid, 'wp_wh_test', 'f9200000-0000-0000-0000-000000000001'
  FROM unnest(ARRAY['a4200000-0000-0000-0000-000000000001', 'a4200000-0000-0000-0000-000000000002',
                    'a4200000-0000-0000-0000-000000000003']) u;
INSERT INTO user_product_rules(user_id, name_pattern, label) VALUES
  ('a4200000-0000-0000-0000-000000000001', 'bottle water', 'Bottle Water'),
  ('a4200000-0000-0000-0000-000000000002', 'dispenser|jug water', 'Dispensers'),
  ('a4200000-0000-0000-0000-000000000002', 'sachet', 'Sachet');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b4200000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000001', 'WP 50cl Bottle Water', 'Pack', 100, 100, 'finished'),
  ('b4200000-0000-0000-0000-000000000002', 'f9200000-0000-0000-0000-000000000001', 'WP Dispenser/Jug Water (New Jug)', 'Piece', 100, 100, 'finished'),
  ('b4200000-0000-0000-0000-000000000003', 'f9200000-0000-0000-0000-000000000001', 'WP Sachet Water', 'Bag', 100, 100, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c4200000-0000-0000-0000-000000000001', 'f9200000-0000-0000-0000-000000000001', 'WP Rep', 'active', 'rep');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.post(p_user text, p_product text, p_qty int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('test.uid', 'a4200000-0000-0000-0000-00000000000' || p_user, false);
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f9200000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c4200000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b4200000-0000-0000-0000-00000000000' || p_product,
                                                  'quantity', p_qty))));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.back(p_user text, p_product text, p_qty int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('test.uid', 'a4200000-0000-0000-0000-00000000000' || p_user, false);
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', 'f9200000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c4200000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b4200000-0000-0000-0000-00000000000' || p_product,
                                                  'quantity_returned', p_qty))));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END;
$$;

-- @@ Test 1: postings -- each only their own; no rule, no limit
DO $$
DECLARE e text;
BEGIN
  e := pg_temp.post('1', '1', 10);
  PERFORM pg_temp.check(e IS NULL, 'Kemi posts bottles: ' || COALESCE(e, ''));
  e := pg_temp.post('1', '2', 5);
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Kemi cannot post dispensers: ' || COALESCE(e, 'posted'));
  e := pg_temp.post('1', '3', 5);
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Kemi cannot post sachet');
  PERFORM pg_temp.check(pg_temp.post('2', '2', 10) IS NULL AND pg_temp.post('2', '3', 10) IS NULL,
                        'Gideon posts dispensers and sachet');
  e := pg_temp.post('2', '1', 5);
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Gideon cannot post bottles');
  PERFORM pg_temp.check(pg_temp.post('3', '1', 1) IS NULL AND pg_temp.post('3', '2', 1) IS NULL, 'no rule: anything');
END $$;

-- @@ Test 2: unsold returns -- the same split
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.check(pg_temp.back('1', '1', 2) IS NULL, 'Kemi takes bottles back');
  e := pg_temp.back('1', '2', 2);
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Kemi cannot take dispensers back: ' || COALESCE(e, 'done'));
  PERFORM pg_temp.check(pg_temp.back('2', '2', 2) IS NULL, 'Gideon takes dispensers back');
  e := pg_temp.back('2', '1', 2);
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Gideon cannot take bottles back');
END $$;

-- @@ Test 3: each sees their own rules
DO $$
BEGIN
  PERFORM set_config('test.uid', 'a4200000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check((SELECT count(*) FROM public.my_product_rules()) = 2, 'Gideon has 2 rules');
  PERFORM set_config('test.uid', 'a4200000-0000-0000-0000-000000000003', false);
  PERFORM pg_temp.check((SELECT count(*) FROM public.my_product_rules()) = 0, 'no rules');
END $$;
