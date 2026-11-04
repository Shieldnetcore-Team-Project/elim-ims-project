-- ============================================================================
-- Acceptance tests: the shop's end of day in one step; Accounts count goods
-- (20261103150000_shop_end_of_day.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. 20 packs posted to the shop; 5 sold for
-- cash; at close only the money is posted -- the shop no longer returns unsold
-- products (20261104130000), so the 15 left stay at the shop.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3900000-0000-0000-0000-000000000001', 'eodfac', 'EOD Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a3900000-0000-0000-0000-000000000001', 'admin@eod'),
  ('a3900000-0000-0000-0000-000000000002', 'cashier@eod'),
  ('a3900000-0000-0000-0000-000000000003', 'accountant@eod');
DELETE FROM user_roles WHERE user_id IN ('a3900000-0000-0000-0000-000000000001', 'a3900000-0000-0000-0000-000000000002',
                                         'a3900000-0000-0000-0000-000000000003');
INSERT INTO user_roles(user_id, role) VALUES ('a3900000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a3900000-0000-0000-0000-000000000002', 'sales', 'f3900000-0000-0000-0000-000000000001'),
  ('a3900000-0000-0000-0000-000000000003', 'accountant', 'f3900000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3900000-0000-0000-0000-000000000001', 'f3900000-0000-0000-0000-000000000001', 'EOD 75cl', 'Pack', 1700, 100, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3900000-0000-0000-0000-000000000001', 'f3900000-0000-0000-0000-000000000001', 'EOD Shop', 'active', 'outlet');
SELECT set_config('test.uid', 'a3900000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE TEMP TABLE t_state(k text PRIMARY KEY, val text);
GRANT ALL ON t_state TO PUBLIC;

-- @@ Test 1: the shop sells 5, then posts the day's money; unsold stay at the shop
DO $$
DECLARE v jsonb; o uuid := 'c3900000-0000-0000-0000-000000000001'; p uuid := 'b3900000-0000-0000-0000-000000000001';
  f uuid := 'f3900000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', o,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 20))));
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000002', false);
  PERFORM public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', o,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 5)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 8500, 'method', 'cash'))));

  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.close_shop_day(%L)', jsonb_build_object('outlet_id', o,
    'declared_cash', 8500, 'declared_other', 0,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'unsold', 12, 'damaged', 0))))) LIKE '%no longer returns%',
    'returning unsold is refused');

  v := public.close_shop_day(jsonb_build_object('outlet_id', o, 'declared_cash', 8500, 'declared_other', 0,
    'items', '[]'::jsonb));
  INSERT INTO t_state VALUES ('rec', v->>'reconciliation_id');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = o AND product_id = p) = 15, 'the 15 stay at the shop');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = p) = 100 - 20, 'nothing back to the Warehouse');
  PERFORM pg_temp.check((SELECT status FROM outlet_day_reconciliations WHERE id = (v->>'reconciliation_id')::uuid) = 'submitted',
                        'the day is with Accounts');
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.close_shop_day(%L)', jsonb_build_object('outlet_id', o,
    'declared_cash', 0, 'declared_other', 0, 'items', '[]'::jsonb))) LIKE '%already with Accounts%', 'closed once only');
END $$;

-- @@ Test 2: Accounts confirm the day's money
DO $$
DECLARE rid uuid := (SELECT val FROM t_state WHERE k = 'rec')::uuid;
BEGIN
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000003', false);
  PERFORM public.confirm_outlet_day_goods(rid, 8500, 0, '[]'::jsonb, NULL);
  PERFORM pg_temp.check((SELECT status FROM outlet_day_reconciliations WHERE id = rid) = 'confirmed', 'confirmed');
  PERFORM pg_temp.check((SELECT SUM(amount) FROM rep_remittances WHERE sales_rep_id = 'c3900000-0000-0000-0000-000000000001') = 8500,
                        'the money is recorded');
END $$;
