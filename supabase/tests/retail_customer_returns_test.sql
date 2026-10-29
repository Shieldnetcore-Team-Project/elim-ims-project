-- ============================================================================
-- Acceptance tests: record_retail_return (20261029290000_retail_customer_returns.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The Retail Shop "RRT Shop" holds 20 packs.
--   * A walk-in buys 4 packs at 2,550 and pays 10,200 cash; brings 1 back
--     and is handed 2,550 cash: shop stock +1, the day's expected cash -2,550.
--   * Customer Mama Joy buys 6 packs (15,300), pays 5,000, owes 10,300;
--     returns 5 packs (12,750): 10,300 comes off her debt, 2,450 is kept as
--     her credit.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('aa100000-0000-0000-0000-000000000001', 'shop@rrt'),
  ('aa100000-0000-0000-0000-000000000002', 'prod@rrt');
DELETE FROM user_roles WHERE user_id IN ('aa100000-0000-0000-0000-000000000001', 'aa100000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('aa100000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'aa100000-0000-0000-0000-000000000002', 'production', id FROM factories WHERE code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT 'ab100000-0000-0000-0000-000000000001', id, 'RRT 35cl Bottle Water', 'Pack', 'finished', true, 0, 2550
  FROM factories WHERE code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'ab100000-0000-0000-0000-000000000002', id, 'RRT Shop', 'active', 'outlet' FROM factories WHERE code = 'water';
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
SELECT 'ab100000-0000-0000-0000-000000000002', 'ab100000-0000-0000-0000-000000000001', id, 20 FROM factories WHERE code = 'water';
INSERT INTO customers(id, factory_id, name, registered)
SELECT 'ab100000-0000-0000-0000-000000000003', id, 'RRT Mama Joy', true FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.ret(p_sale uuid, p_qty numeric, p_settle text, p_like text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.record_retail_return(jsonb_build_object('sale_id', p_sale, 'settle', p_settle,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'ab100000-0000-0000-0000-000000000001', 'quantity', p_qty))));
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE p_like THEN RAISE NOTICE 'unexpected error: %', SQLERRM; RETURN false; END IF;
  RETURN true;
END;
$$;

-- @@ Test 1: a walk-in returns 1 of 4 paid packs for cash -- shop stock back, the cash-up takes the refund off
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r jsonb; s record; before jsonb; after jsonb;
        sale uuid;
BEGIN
  PERFORM set_config('test.uid', 'aa100000-0000-0000-0000-000000000001', false);
  r := public.create_sale(jsonb_build_object('factory_id', f,
    'sales_rep_id', 'ab100000-0000-0000-0000-000000000002',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'ab100000-0000-0000-0000-000000000001', 'quantity', 4)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 10200, 'method', 'cash'))));
  sale := (r->>'sale_id')::uuid;
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'ab100000-0000-0000-0000-000000000002') = 16,
                        'sold 4 of 20');
  before := public._outlet_day_figures('ab100000-0000-0000-0000-000000000002', CURRENT_DATE);

  r := public.record_retail_return(jsonb_build_object('sale_id', sale, 'settle', 'refund', 'refund_method', 'cash',
    'reason', 'Not needed',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'ab100000-0000-0000-0000-000000000001', 'quantity', 1))));
  PERFORM pg_temp.check((r->>'value')::numeric = 2550 AND (r->>'refund')::numeric = 2550 AND (r->>'debt_reduced')::numeric = 0,
                        'refund 2,550: ' || r::text);
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'ab100000-0000-0000-0000-000000000002') = 17,
                        'shop stock back to 17');
  SELECT * INTO s FROM sales WHERE id = sale;
  PERFORM pg_temp.check(s.grand_total = 7650 AND s.amount_paid = 7650 AND s.balance = 0, 'sale now 7,650 paid: ' || row_to_json(s)::text);
  after := public._outlet_day_figures('ab100000-0000-0000-0000-000000000002', CURRENT_DATE);
  PERFORM pg_temp.check((after->'money'->>'cash_expected')::numeric = (before->'money'->>'cash_expected')::numeric - 2550,
                        'cash expected down 2,550: ' || (after->'money')::text);
  PERFORM pg_temp.check((SELECT status FROM sales_returns WHERE sale_id = sale) = 'completed', 'posted at once');
  -- a walk-in can't keep credit
  PERFORM pg_temp.check(pg_temp.ret(sale, 1, 'credit', '%walk-in has no account%'), 'walk-in credit refused');
  PERFORM pg_temp.check(pg_temp.ret(sale, 4, 'refund', '%Only 3%'), 'more than is left refused');
END $$;

-- @@ Test 2: a customer returns 5 of 6 packs -- debt first, the rest kept as credit
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r jsonb; c record; d record; sale uuid;
BEGIN
  PERFORM set_config('test.uid', 'aa100000-0000-0000-0000-000000000001', false);
  r := public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', 'ab100000-0000-0000-0000-000000000003',
    'customer_name', 'RRT Mama Joy', 'sales_rep_id', 'ab100000-0000-0000-0000-000000000002',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'ab100000-0000-0000-0000-000000000001', 'quantity', 6)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 5000, 'method', 'cash'))));
  sale := (r->>'sale_id')::uuid;
  r := public.record_retail_return(jsonb_build_object('sale_id', sale, 'settle', 'credit',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'ab100000-0000-0000-0000-000000000001', 'quantity', 5))));
  PERFORM pg_temp.check((r->>'value')::numeric = 12750 AND (r->>'debt_reduced')::numeric = 10300
                        AND (r->>'credit_added')::numeric = 2450, 'split: ' || r::text);
  SELECT * INTO c FROM customers WHERE id = 'ab100000-0000-0000-0000-000000000003';
  PERFORM pg_temp.check(c.outstanding_balance = 0 AND c.credit_balance = 2450, 'customer: ' || row_to_json(c)::text);
  SELECT * INTO d FROM debts WHERE sale_id = sale;
  PERFORM pg_temp.check(d.outstanding = 0 AND d.status = 'paid', 'debt cleared: ' || row_to_json(d)::text);
  PERFORM pg_temp.check((SELECT credit_after FROM customer_account_transactions
                          WHERE customer_id = 'ab100000-0000-0000-0000-000000000003' ORDER BY seq DESC LIMIT 1) = 2450,
                        'ledger credit 2,450');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'ab100000-0000-0000-0000-000000000002') = 16,
                        'shop stock 17 - 6 + 5 = 16');
END $$;

-- @@ Test 3: no rights is refused
DO $$
BEGIN
  PERFORM set_config('test.uid', 'aa100000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.ret((SELECT id FROM sales WHERE customer_id IS NULL AND sales_rep_id = 'ab100000-0000-0000-0000-000000000002' LIMIT 1),
                                    1, 'refund', '%Insufficient permissions%'), 'production refused');
END $$;
