-- ============================================================================
-- Acceptance tests: retail_return_to_warehouse
-- (20261102140000_retail_return_to_warehouse.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Own factory and shop. The shop holds 20
-- packs, returns 15 unsold at close; the next posting carries them back out.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fb000000-0000-0000-0000-000000000001', 'rrtest', 'RR Test Factory');
INSERT INTO auth.users(id, email) VALUES ('ab000000-0000-0000-0000-000000000001', 'admin@rr'),
                                         ('ab000000-0000-0000-0000-000000000002', 'nobody@rr');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('ab000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('ab000000-0000-0000-0000-000000000002', 'production', 'fb000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;
INSERT INTO sales_reps(id, factory_id, code, full_name, status, kind) VALUES
  ('eb000000-0000-0000-0000-000000000001', 'fb000000-0000-0000-0000-000000000001', 'RR-SHOP', 'RR Shop', 'active', 'outlet');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('db000000-0000-0000-0000-000000000001', 'fb000000-0000-0000-0000-000000000001', 'RR 75cl', 'Pack', 300, 100, 'finished');
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity) VALUES
  ('eb000000-0000-0000-0000-000000000001', 'db000000-0000-0000-0000-000000000001', 'fb000000-0000-0000-0000-000000000001', 20);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: the shop no longer returns unsold products (20261104130000)
DO $$
DECLARE e text;
BEGIN
  PERFORM set_config('test.uid', 'ab000000-0000-0000-0000-000000000001', false);
  e := pg_temp.err($q$SELECT public.return_shop_stock_to_warehouse(jsonb_build_object(
         'outlet_id', 'eb000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'db000000-0000-0000-0000-000000000001', 'quantity', 15))))$q$);
  PERFORM pg_temp.check(e LIKE '%no longer returns%', 'refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'eb000000-0000-0000-0000-000000000001') = 20, 'shop keeps its 20');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'db000000-0000-0000-0000-000000000001') = 100, 'Warehouse unchanged');
END $$;

-- @@ Test 2: more than held, a closed day, a marketer id and no rights are refused
DO $$
BEGIN
  PERFORM set_config('test.uid', 'ab000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.return_shop_stock_to_warehouse(jsonb_build_object(
         'outlet_id', 'eb000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'db000000-0000-0000-0000-000000000001', 'quantity', 31))))$q$)
         LIKE '%has only%', 'more than held');
  INSERT INTO outlet_day_reconciliations(factory_id, sales_rep_id, close_date, status, figures)
  VALUES ('fb000000-0000-0000-0000-000000000001', 'eb000000-0000-0000-0000-000000000001', CURRENT_DATE, 'submitted', '{}'::jsonb);
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.return_shop_stock_to_warehouse(jsonb_build_object(
         'outlet_id', 'eb000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'db000000-0000-0000-0000-000000000001', 'quantity', 1))))$q$)
         LIKE '%already closed%', 'closed day');
  PERFORM set_config('test.uid', 'ab000000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.return_shop_stock_to_warehouse(jsonb_build_object(
         'outlet_id', 'eb000000-0000-0000-0000-000000000001', 'items', '[]'::jsonb))$q$) LIKE '%Insufficient%', 'no rights');
END $$;
