-- ============================================================================
-- Acceptance tests: one filled dispenser product
-- (20261103160000_one_dispenser_water.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. As live: Dispenser Water N1,200 and
-- Dispenser Jug+Water N4,200; the Warehouse holds 50 / 40, the shop 61 / 260,
-- a marketer 0 / 10.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f4000000-0000-0000-0000-000000000001', 'odwfac', 'ODW Factory');
INSERT INTO auth.users(id, email) VALUES ('a4000000-0000-0000-0000-000000000001', 'admin@odw');
INSERT INTO user_roles(user_id, role) VALUES ('a4000000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 50, 'finished'),
  ('b4000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000001', 'Dispenser Jug+Water', 'Piece', 4200, 40, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'ODW Shop', 'active', 'outlet'),
  ('c4000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000001', 'ODW Marketer', 'active', 'rep');
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity) VALUES
  ('c4000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 61),
  ('c4000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000001', 260),
  ('c4000000-0000-0000-0000-000000000002', 'b4000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000001', 10);
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'ODW Distributor', true);
SELECT set_config('test.uid', 'a4000000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.held(r uuid, p uuid) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE((SELECT quantity FROM rep_stock WHERE sales_rep_id = r AND product_id = p), 0)
$$;

-- @@ Test 1: the switch-over: one stock everywhere, Jug+Water retired, the jug priced from the two prices
DO $$
DECLARE v jsonb; t uuid;
  w uuid := 'b4000000-0000-0000-0000-000000000001'; c uuid := 'b4000000-0000-0000-0000-000000000002';
  shop uuid := 'c4000000-0000-0000-0000-000000000001'; mkt uuid := 'c4000000-0000-0000-0000-000000000002';
BEGIN
  v := public.merge_dispenser_jug_water();
  PERFORM pg_temp.check(jsonb_array_length(v->'done') = 1, 'one factory switched: ' || v::text);
  PERFORM pg_temp.check(pg_temp.held(shop, w) = 321 AND pg_temp.held(shop, c) = 0, 'the shop: 321 Dispenser Water');
  PERFORM pg_temp.check(pg_temp.held(mkt, w) = 10 AND pg_temp.held(mkt, c) = 0, 'the marketer: 10 Dispenser Water');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = w) = 90
                    AND (SELECT current_stock FROM products WHERE id = c) = 0, 'Warehouse: 90');
  PERFORM pg_temp.check(NOT (SELECT active FROM products WHERE id = c), 'Jug+Water retired');
  t := (SELECT container_type_id FROM product_containers WHERE product_id = w);
  PERFORM pg_temp.check((SELECT jar_price FROM container_types WHERE id = t) = 3000
                    AND (SELECT with_jar_price FROM container_types WHERE id = t) = 4200, 'jug 3,000; water + jug 4,200');
  v := public.merge_dispenser_jug_water();
  PERFORM pg_temp.check(jsonb_array_length(v->'done') = 0 OR NOT EXISTS (SELECT 1 FROM rep_stock WHERE product_id = c AND quantity > 0),
                        'a second run moves nothing');
  PERFORM pg_temp.check(pg_temp.held(shop, w) = 321, 'still 321');
END $$;

-- @@ Test 2: at the shop: water + jug charges 4,200 (3,000 jug); water only 1,200
DO $$
DECLARE a jsonb; b jsonb; f uuid := 'f4000000-0000-0000-0000-000000000001';
  w uuid := 'b4000000-0000-0000-0000-000000000001'; shop uuid := 'c4000000-0000-0000-0000-000000000001';
BEGIN
  a := public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', shop,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 1, 'jar_mode', 'permanent'))));
  b := public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', shop,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 2, 'jar_mode', 'swap'))));
  PERFORM pg_temp.check((a->>'grand_total')::numeric = 4200, 'water + jug 4,200: ' || a::text);
  PERFORM pg_temp.check((SELECT jar_unit_price FROM sale_items WHERE sale_id = (a->>'sale_id')::uuid) = 3000, '3,000 is jug money');
  PERFORM pg_temp.check((b->>'grand_total')::numeric = 2400, 'water only 2 x 1,200');
  PERFORM pg_temp.check(pg_temp.held(shop, w) = 318, 'the shop: 321 - 3');
END $$;

-- @@ Test 3: a Warehouse posting to a distributor takes the jug choice too
DO $$
DECLARE a jsonb; f uuid := 'f4000000-0000-0000-0000-000000000001'; w uuid := 'b4000000-0000-0000-0000-000000000001';
BEGIN
  a := public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', 'd4000000-0000-0000-0000-000000000001',
    'customer_name', 'ODW Distributor',
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 3, 'jar_mode', 'permanent'))));
  PERFORM pg_temp.check((a->>'grand_total')::numeric = 12600, '3 x 4,200: ' || a::text);
END $$;

-- @@ Test 4: prices follow Costing: Dispenser Empty is the jug; a price change reaches the sale (20261103170000)
DO $$
DECLARE a jsonb; j record; f uuid := 'f4000000-0000-0000-0000-000000000001';
  w uuid := 'b4000000-0000-0000-0000-000000000001'; shop uuid := 'c4000000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type)
  VALUES ('b4000000-0000-0000-0000-000000000003', f, 'Dispenser Empty', 'pieces', 3000, 0, 'finished');
  PERFORM public._link_empty_jug_products();
  SELECT * INTO j FROM public.jug_products(f) WHERE product_id = w;
  PERFORM pg_temp.check(j.jar_price = 3000 AND j.with_jar_price = 4200 AND j.jar_product_name = 'Dispenser Empty',
                        'from Costing: ' || row_to_json(j)::text);
  -- Costing: Dispenser Water goes to 1,300.
  UPDATE products SET unit_price = 1300 WHERE id = w;
  SELECT * INTO j FROM public.jug_products(f) WHERE product_id = w;
  PERFORM pg_temp.check(j.with_jar_price = 4300, 'water + jug follows: ' || row_to_json(j)::text);
  PERFORM pg_temp.check((SELECT with_jar_price FROM container_types WHERE id = j.container_type_id) = 4300,
                        'the stored price follows too');
  a := public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', shop,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 1, 'jar_mode', 'permanent'))));
  PERFORM pg_temp.check((a->>'grand_total')::numeric = 4300
                    AND (SELECT jar_unit_price FROM sale_items WHERE sale_id = (a->>'sale_id')::uuid) = 3000,
                        'the sale: 4,300, of which 3,000 jug: ' || a::text);
END $$;
