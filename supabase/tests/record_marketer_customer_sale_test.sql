-- ============================================================================
-- Acceptance tests: record_marketer_customer_sale
-- (20261029260000_record_marketer_customer_sale.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Marketer "RMS Sunday" has 50 packs of
-- 75cl on his van. The accountant records that his customer Mama Joy took 20
-- packs at 1,700 with 100 off per pack (32,000) and paid 12,000 there; she
-- then pays the rest in two goes.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('ce100000-0000-0000-0000-000000000001', 'acct@rms'),
  ('ce100000-0000-0000-0000-000000000002', 'prod@rms');
DELETE FROM user_roles WHERE user_id IN ('ce100000-0000-0000-0000-000000000001', 'ce100000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT v.u::uuid, v.r, f.id FROM factories f,
  (VALUES ('ce100000-0000-0000-0000-000000000001', 'accountant'),
          ('ce100000-0000-0000-0000-000000000002', 'production')) v(u, r)
 WHERE f.code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT 'cf100000-0000-0000-0000-000000000001', id, 'RMS 75cl Bottle Water', 'Pack', 'finished', true, 0, 1700
  FROM factories WHERE code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'cf100000-0000-0000-0000-000000000002', id, 'RMS Sunday', 'active', 'rep' FROM factories WHERE code = 'water';
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
SELECT 'cf100000-0000-0000-0000-000000000002', 'cf100000-0000-0000-0000-000000000001', id, 50 FROM factories WHERE code = 'water';
INSERT INTO customers(id, factory_id, name, registered, sales_rep_id)
SELECT 'cf100000-0000-0000-0000-000000000003', id, 'RMS Mama Joy', true, 'cf100000-0000-0000-0000-000000000002'
  FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.try_sale(p_items jsonb, p_like text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.record_marketer_customer_sale(jsonb_build_object(
    'sales_rep_id', 'cf100000-0000-0000-0000-000000000002',
    'customer_id', 'cf100000-0000-0000-0000-000000000003', 'items', p_items));
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE p_like THEN RAISE NOTICE 'unexpected error: %', SQLERRM; RETURN false; END IF;
  RETURN true;
END;
$$;

-- @@ Test 1: the sale posts at once -- van stock out, payment receipted, the rest owed
DO $$
DECLARE r jsonb; s record; i record; d record;
BEGIN
  PERFORM set_config('test.uid', 'ce100000-0000-0000-0000-000000000001', false);
  r := public.record_marketer_customer_sale(jsonb_build_object(
    'sales_rep_id', 'cf100000-0000-0000-0000-000000000002',
    'customer_id', 'cf100000-0000-0000-0000-000000000003',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'cf100000-0000-0000-0000-000000000001',
                                                  'quantity', 20, 'discount', 100)),
    'payment', jsonb_build_object('amount', 12000, 'method', 'cash')));
  SELECT * INTO s FROM sales WHERE id = (r->>'sale_id')::uuid;
  PERFORM pg_temp.check(s.status = 'posted' AND s.grand_total = 32000 AND s.amount_paid = 12000 AND s.balance = 20000
                        AND s.sales_rep_id = 'cf100000-0000-0000-0000-000000000002'
                        AND s.account_rep_id = 'cf100000-0000-0000-0000-000000000002', 'sale: ' || row_to_json(s)::text);
  SELECT * INTO i FROM sale_items WHERE sale_id = s.id;
  PERFORM pg_temp.check(i.unit_price = 1700 AND i.unit_discount = 100 AND i.discount = 2000 AND i.line_total = 32000,
                        'line: ' || row_to_json(i)::text);
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'cf100000-0000-0000-0000-000000000002') = 30,
                        'van stock 50 -> 30');
  PERFORM pg_temp.check((SELECT sum(amount) FROM payments_received WHERE sale_id = s.id AND at_point_of_sale) = 12000,
                        'payment at the sale');
  SELECT * INTO d FROM debts WHERE sale_id = s.id;
  PERFORM pg_temp.check(d.outstanding = 20000, 'debt 20,000');
END $$;

-- @@ Test 2: she pays the rest in two goes until the account is settled
DO $$
DECLARE d record; f uuid := (SELECT id FROM factories WHERE code = 'water');
BEGIN
  PERFORM set_config('test.uid', 'ce100000-0000-0000-0000-000000000001', false);
  PERFORM public.record_payment(jsonb_build_object('factory_id', f,
    'customer_id', 'cf100000-0000-0000-0000-000000000003', 'amount', 15000, 'payment_method', 'cash',
    'collected_by_rep', 'cf100000-0000-0000-0000-000000000002'));
  PERFORM public.record_payment(jsonb_build_object('factory_id', f,
    'customer_id', 'cf100000-0000-0000-0000-000000000003', 'amount', 5000, 'payment_method', 'transfer',
    'collected_by_rep', 'cf100000-0000-0000-0000-000000000002'));
  SELECT * INTO d FROM debts WHERE customer_id = 'cf100000-0000-0000-0000-000000000003';
  PERFORM pg_temp.check(d.outstanding = 0 AND d.status = 'paid', 'settled: ' || row_to_json(d)::text);
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'cf100000-0000-0000-0000-000000000003') = 0,
                        'customer owes nothing');
  PERFORM pg_temp.check((SELECT count(*) FROM payments_received WHERE customer_id = 'cf100000-0000-0000-0000-000000000003') = 3,
                        'three receipts on record');
END $$;

-- @@ Test 3: more than the van holds, a discount above the price, and no rights are refused
DO $$
DECLARE p text := 'cf100000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', 'ce100000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(pg_temp.try_sale(jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 31)), '%has only%'),
                        'over van stock refused');
  PERFORM pg_temp.check(pg_temp.try_sale(jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 1, 'discount', 2000)),
                                         '%more than its price%'), 'discount over price refused');
  PERFORM set_config('test.uid', 'ce100000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.try_sale(jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 1)),
                                         '%Insufficient permissions%'), 'production refused');
END $$;
