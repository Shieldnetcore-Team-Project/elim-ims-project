-- ============================================================================
-- Acceptance tests: marketer customer accounts, debts, daily accountability,
-- statements (20261017150000_marketer_customer_accountability.sql).
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting (see the PGlite runner
-- used during development). Each block between "-- @@" markers is one test;
-- a failed assertion raises an exception naming what was wrong. Uses its own
-- factory, products, users and marketers; never run against production.
-- ============================================================================

-- Fixed ids so the tests can refer to them.
INSERT INTO factories(id, code, name) VALUES ('f0000000-0000-0000-0000-000000000001', 'acctest', 'Acceptance Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'admin@test'),
  ('a0000000-0000-0000-0000-000000000002', 'warehouse@test'),
  ('a0000000-0000-0000-0000-000000000003', 'auditor@test');
-- A Warehouse-style role: distribution view only (stock, no money).
INSERT INTO roles(slug, label, is_system) VALUES ('test_stock_only', 'Test stock only', false);
INSERT INTO role_permissions(role, module, action) VALUES ('test_stock_only', 'distribution', 'view');
INSERT INTO user_roles(user_id, role) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'super_admin'),
  ('a0000000-0000-0000-0000-000000000002', 'test_stock_only'),
  ('a0000000-0000-0000-0000-000000000003', 'auditor');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'Test Bottle 75cl', 'pack', 1000, 1000),
  ('b0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000001', 'Test Sachet', 'bag', 300, 1000);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind, user_id) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'Abacha', 'active', 'rep', NULL),
  ('c0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000001', 'Godwin', 'active', 'rep', NULL);
SELECT set_config('test.uid', 'a0000000-0000-0000-0000-000000000001', false);

-- Stock out to both marketers.
SELECT public.create_stock_dispatch(jsonb_build_object(
  'factory_id', 'f0000000-0000-0000-0000-000000000001', 'sales_rep_id', 'c0000000-0000-0000-0000-000000000001',
  'items', jsonb_build_array(jsonb_build_object('product_id', 'b0000000-0000-0000-0000-000000000001', 'quantity', 300))));
SELECT public.create_stock_dispatch(jsonb_build_object(
  'factory_id', 'f0000000-0000-0000-0000-000000000001', 'sales_rep_id', 'c0000000-0000-0000-0000-000000000002',
  'items', jsonb_build_array(jsonb_build_object('product_id', 'b0000000-0000-0000-0000-000000000001', 'quantity', 100))));

-- A van sale, approved. Returns the sale id.
CREATE OR REPLACE FUNCTION pg_temp.sell(p_rep uuid, p_customer uuid, p_qty numeric, p_price numeric, p_paid numeric,
                                        p_date date DEFAULT CURRENT_DATE)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := public.create_sale(jsonb_build_object(
    'factory_id', 'f0000000-0000-0000-0000-000000000001', 'sale_date', p_date,
    'customer_id', p_customer, 'sales_rep_id', p_rep,
    'payments', CASE WHEN p_paid > 0 THEN jsonb_build_array(jsonb_build_object('amount', p_paid, 'method', 'cash')) ELSE '[]'::jsonb END,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b0000000-0000-0000-0000-000000000001',
                                                  'quantity', p_qty, 'unit_price', p_price))));
  PERFORM public.approve_sale((v->>'sale_id')::uuid, NULL);
  RETURN (v->>'sale_id')::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);

-- @@ Test 1: register Customer A under Abacha
DO $$
DECLARE v jsonb; v_id uuid;
BEGIN
  v := public.register_marketer_customer(jsonb_build_object('sales_rep_id', 'c0000000-0000-0000-0000-000000000001',
         'name', 'Customer A', 'phone', '0803 111 2222', 'address', 'Wuse Market'));
  v_id := (v->>'customer_id')::uuid;
  INSERT INTO ids VALUES ('A', v_id);
  PERFORM pg_temp.check((SELECT sales_rep_id FROM customers WHERE id = v_id) = 'c0000000-0000-0000-0000-000000000001', 'stored under Abacha');
  PERFORM pg_temp.check((SELECT registered AND status = 'active' FROM customers WHERE id = v_id), 'registered and active');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM customer_marketer_history WHERE customer_id = v_id AND to_rep_id = 'c0000000-0000-0000-0000-000000000001'), 'assignment history');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.marketer_customer_report('c0000000-0000-0000-0000-000000000001') WHERE customer_id = v_id AND assigned), 'listed under Abacha');
  -- Same phone written differently: refused.
  BEGIN
    PERFORM public.register_marketer_customer(jsonb_build_object('sales_rep_id', 'c0000000-0000-0000-0000-000000000002',
              'name', 'Customer A again', 'phone', '+234 803 111 2222'));
    RAISE EXCEPTION 'ASSERTION FAILED: duplicate phone accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF;
  END;
  v := public.register_marketer_customer(jsonb_build_object('sales_rep_id', 'c0000000-0000-0000-0000-000000000001', 'name', 'Customer B', 'phone', '08030000002'));
  INSERT INTO ids VALUES ('B', (v->>'customer_id')::uuid);
  v := public.register_marketer_customer(jsonb_build_object('sales_rep_id', 'c0000000-0000-0000-0000-000000000002', 'name', 'Customer D', 'phone', '08030000004'));
  INSERT INTO ids VALUES ('D', (v->>'customer_id')::uuid);
END $$;
SELECT 'ok' AS result;

-- @@ Test 2: full payment
DO $$
DECLARE v_sale uuid; r record;
BEGIN
  v_sale := pg_temp.sell('c0000000-0000-0000-0000-000000000001', (SELECT v FROM ids WHERE k = 'A'), 100, 1000, 100000);
  INSERT INTO ids VALUES ('A1', v_sale);
  SELECT * INTO r FROM public.marketer_invoices('c0000000-0000-0000-0000-000000000001') WHERE sale_id = v_sale;
  PERFORM pg_temp.check(r.grand_total = 100000 AND r.outstanding = 0 AND r.paid_at_sale = 100000 AND r.status = 'paid', 'invoice fully paid: ' || row_to_json(r)::text);
  PERFORM pg_temp.check(jsonb_array_length(public.customer_statement((SELECT v FROM ids WHERE k = 'A'))->'payments') = 1, 'payment in history');
END $$;
SELECT 'ok' AS result;

-- @@ Test 3: partial payment
DO $$
DECLARE v_sale uuid; r record; v_st jsonb;
BEGIN
  v_sale := pg_temp.sell('c0000000-0000-0000-0000-000000000001', (SELECT v FROM ids WHERE k = 'A'), 100, 1000, 60000);
  INSERT INTO ids VALUES ('A2', v_sale);
  SELECT * INTO r FROM public.marketer_invoices('c0000000-0000-0000-0000-000000000001') WHERE sale_id = v_sale;
  PERFORM pg_temp.check(r.outstanding = 40000 AND r.status = 'part_paid', 'invoice owes 40,000');
  SELECT * INTO r FROM public.marketer_customer_report('c0000000-0000-0000-0000-000000000001') WHERE customer_id = (SELECT v FROM ids WHERE k = 'A');
  PERFORM pg_temp.check(r.outstanding = 40000 AND r.total_purchases = 200000 AND r.total_paid = 160000, 'Abacha report row: ' || row_to_json(r)::text);
  v_st := public.customer_statement((SELECT v FROM ids WHERE k = 'A'));
  PERFORM pg_temp.check((v_st->'closing'->>'debt')::numeric = 40000, 'customer account closing debt 40,000');
  PERFORM pg_temp.check((public.marketer_statement('c0000000-0000-0000-0000-000000000001')->'cumulative'->'debt'->>'outstanding')::numeric = 40000, 'Abacha debt summary 40,000');
END $$;
SELECT 'ok' AS result;

-- @@ Test 4 + 8: historical purchases across dates, prices kept
DO $$
DECLARE v_b uuid := (SELECT v FROM ids WHERE k = 'B'); v_st jsonb; v_prices numeric[];
BEGIN
  PERFORM pg_temp.sell('c0000000-0000-0000-0000-000000000001', v_b, 10, 1000, 0, (CURRENT_DATE - 200));
  PERFORM pg_temp.sell('c0000000-0000-0000-0000-000000000001', v_b, 10, 1200, 0, (CURRENT_DATE - 20));
  -- the product's list price changes afterwards; history must not follow it
  UPDATE products SET unit_price = 1500 WHERE id = 'b0000000-0000-0000-0000-000000000001';
  v_st := public.customer_statement(v_b, CURRENT_DATE - 365, CURRENT_DATE);
  SELECT array_agg((i->'items'->0->>'unit_price')::numeric ORDER BY i->>'sale_date') INTO v_prices
    FROM jsonb_array_elements(v_st->'invoices') i;
  PERFORM pg_temp.check(v_prices = ARRAY[1000, 1200]::numeric[], 'original prices kept: ' || v_prices::text);
  PERFORM pg_temp.check(jsonb_array_length(v_st->'invoices') = 2, 'both purchases in the one-year statement');
  PERFORM pg_temp.check((v_st->'closing'->>'debt')::numeric = 22000, 'closing balance 22,000');
  PERFORM pg_temp.check((SELECT SUM((i->>'outstanding')::numeric) FROM jsonb_array_elements(v_st->'invoices') i) = 22000, 'invoice balances add to closing');
  -- The running balance is dated by when entries were posted (both were
  -- approved today), while each invoice keeps its own sale date; the older
  -- invoice is still owing, so a one-month statement lists it too.
  v_st := public.customer_statement(v_b, CURRENT_DATE - 30, CURRENT_DATE);
  PERFORM pg_temp.check((v_st->'opening'->>'debt')::numeric = 0 AND (v_st->'closing'->>'debt')::numeric = 22000, 'opening/closing from ledger');
  PERFORM pg_temp.check(jsonb_array_length(v_st->'invoices') = 2, 'owing older invoice carried into a short statement');
END $$;
SELECT 'ok' AS result;

-- @@ Test 5: marketer statement only has the marketer's own sales
DO $$
DECLARE v_st jsonb;
BEGIN
  PERFORM pg_temp.sell('c0000000-0000-0000-0000-000000000002', (SELECT v FROM ids WHERE k = 'D'), 50, 1000, 20000);
  v_st := public.marketer_statement('c0000000-0000-0000-0000-000000000001', date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE);
  PERFORM pg_temp.check((v_st->'period'->'sales'->>'value')::numeric =
    (SELECT SUM(grand_total) FROM sales WHERE sales_rep_id = 'c0000000-0000-0000-0000-000000000001'
        AND sale_date >= date_trunc('month', CURRENT_DATE)::date AND status = 'posted'), 'period = Abacha''s sales only');
  PERFORM pg_temp.check((v_st->'cumulative'->'sales'->>'value')::numeric = 222000, 'cumulative 222,000 (not Godwin''s 50,000)');
  v_st := public.marketer_statement('c0000000-0000-0000-0000-000000000002');
  PERFORM pg_temp.check((v_st->'cumulative'->'sales'->>'value')::numeric = 50000, 'Godwin 50,000');
END $$;
SELECT 'ok' AS result;

-- @@ Test 6: total debt = sum of customer balances, nothing twice
DO $$
DECLARE v_total numeric; v_rows numeric; v_dir numeric;
BEGIN
  v_total := (public.marketer_statement('c0000000-0000-0000-0000-000000000001')->'cumulative'->'debt'->>'outstanding')::numeric;
  SELECT SUM(outstanding) INTO v_rows FROM public.marketer_customer_report('c0000000-0000-0000-0000-000000000001');
  SELECT outstanding INTO v_dir FROM public.marketer_directory('f0000000-0000-0000-0000-000000000001') WHERE id = 'c0000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(v_total = 62000 AND v_rows = 62000 AND v_dir = 62000, format('total %s rows %s directory %s', v_total, v_rows, v_dir));
END $$;
SELECT 'ok' AS result;

-- @@ Test 7: settle an invoice, it stays on record
DO $$
DECLARE r record; v_st jsonb;
BEGIN
  PERFORM public.record_payment(jsonb_build_object('factory_id', 'f0000000-0000-0000-0000-000000000001',
    'customer_id', (SELECT v FROM ids WHERE k = 'A'), 'sale_id', (SELECT v FROM ids WHERE k = 'A2'),
    'amount', 40000, 'payment_method', 'transfer', 'collected_by_rep', 'c0000000-0000-0000-0000-000000000001',
    'idempotency_key', 'acc-test-7'));
  -- the same key again must not post twice
  PERFORM public.record_payment(jsonb_build_object('factory_id', 'f0000000-0000-0000-0000-000000000001',
    'customer_id', (SELECT v FROM ids WHERE k = 'A'), 'sale_id', (SELECT v FROM ids WHERE k = 'A2'),
    'amount', 40000, 'payment_method', 'transfer', 'collected_by_rep', 'c0000000-0000-0000-0000-000000000001',
    'idempotency_key', 'acc-test-7'));
  SELECT * INTO r FROM public.marketer_invoices('c0000000-0000-0000-0000-000000000001') WHERE sale_id = (SELECT v FROM ids WHERE k = 'A2');
  PERFORM pg_temp.check(r.outstanding = 0 AND r.status = 'paid' AND r.paid_later = 40000, 'A2 settled: ' || row_to_json(r)::text);
  v_st := public.customer_statement((SELECT v FROM ids WHERE k = 'A'));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM jsonb_array_elements(v_st->'invoices') i WHERE i->>'sale_id' = (SELECT v FROM ids WHERE k = 'A2')::text), 'settled invoice still listed');
  PERFORM pg_temp.check(jsonb_array_length(v_st->'payments') = 3, 'three receipts, no duplicate');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM jsonb_array_elements(v_st->'payments') p, jsonb_array_elements(p->'allocations') a
                                 WHERE (a->>'amount')::numeric = 40000), 'allocation history shows the 40,000');
  PERFORM pg_temp.check((public.marketer_statement('c0000000-0000-0000-0000-000000000001')->'cumulative'->'debt'->>'outstanding')::numeric = 22000, 'debt now 22,000');
END $$;
SELECT 'ok' AS result;

-- @@ Test 9: access control
DO $$
BEGIN
  -- Warehouse user: stock accountability yes, money no.
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-000000000002', false);
  PERFORM public.marketer_stock_accountability('c0000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM public.marketer_daily_accountability('c0000000-0000-0000-0000-000000000001', CURRENT_DATE, CURRENT_DATE) WHERE sales_value IS NULL AND issued_qty = 300) = 1, 'daily stock shown, money hidden');
  PERFORM pg_temp.check((SELECT bool_and(sales_value IS NULL AND outstanding IS NULL) FROM public.marketer_directory('f0000000-0000-0000-0000-000000000001')), 'directory money hidden');
  BEGIN
    PERFORM public.marketer_statement('c0000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'ASSERTION FAILED: warehouse user read a statement';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.customer_statement((SELECT v FROM ids WHERE k = 'A'));
    RAISE EXCEPTION 'ASSERTION FAILED: warehouse user read a customer account';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.marketer_customer_report('c0000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'ASSERTION FAILED: warehouse user read a customer list';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.register_marketer_customer(jsonb_build_object('sales_rep_id', 'c0000000-0000-0000-0000-000000000001', 'name', 'Sneaky'));
    RAISE EXCEPTION 'ASSERTION FAILED: warehouse user registered a customer';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  -- Signed out: nothing.
  PERFORM set_config('test.uid', '', false);
  BEGIN
    PERFORM public.marketer_directory('f0000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'ASSERTION FAILED: signed-out caller read the directory';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;

  -- Auditor: reads everything, changes nothing.
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-000000000003', false);
  PERFORM public.marketer_statement('c0000000-0000-0000-0000-000000000001');
  BEGIN
    PERFORM public.close_marketer_day('c0000000-0000-0000-0000-000000000001', CURRENT_DATE, 'x');
    RAISE EXCEPTION 'ASSERTION FAILED: auditor closed a day';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-000000000001', false);
END $$;
-- Posted transactions cannot be edited directly by a signed-in user.
SELECT set_config('test.uid', 'a0000000-0000-0000-0000-000000000003', false);
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    UPDATE sales SET grand_total = 1 WHERE id = (SELECT v FROM ids WHERE k = 'A1');
    RAISE EXCEPTION 'ASSERTION FAILED: posted sale edited';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE payments_received SET amount = 1 WHERE sale_id = (SELECT v FROM ids WHERE k = 'A1');
    IF FOUND THEN RAISE EXCEPTION 'ASSERTION FAILED: posted payment edited'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM customer_account_transactions;
    IF FOUND THEN RAISE EXCEPTION 'ASSERTION FAILED: ledger deleted'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT set_config('test.uid', 'a0000000-0000-0000-0000-000000000001', false);
SELECT 'ok' AS result;

-- @@ Test 10: daily reconciliation, stock and money kept apart
DO $$
DECLARE r record; v_close jsonb;
BEGIN
  PERFORM public.record_rep_remittance(jsonb_build_object('factory_id', 'f0000000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c0000000-0000-0000-0000-000000000001', 'amount', 100000, 'payment_method', 'cash'));
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', 'f0000000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c0000000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b0000000-0000-0000-0000-000000000001', 'quantity_returned', 50))));
  SELECT * INTO r FROM public.marketer_daily_accountability('c0000000-0000-0000-0000-000000000001', CURRENT_DATE, CURRENT_DATE);
  -- Stock: 300 issued, 220 sold (incl. the two backdated credit sales recorded today), 50 back, 30 left.
  PERFORM pg_temp.check(r.issued_qty = 300 AND r.sold_qty = 220 AND r.returned_qty = 50 AND r.closing_qty = 30,
                        'stock: ' || row_to_json(r)::text);
  PERFORM pg_temp.check(r.closing_qty = (SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c0000000-0000-0000-0000-000000000001'), 'matches van stock');
  -- Money: 160,000 taken at van sales, 100,000 handed in -> 60,000 unremitted.
  -- The 40,000 transfer was recorded by Finance (with the factory), so it is not unremitted.
  PERFORM pg_temp.check(r.held_by_marketer = 160000 AND r.remitted = 100000 AND r.unremitted = 60000, 'money: ' || row_to_json(r)::text);
  PERFORM pg_temp.check(r.credit_sales = 40000 AND r.debt_outstanding = 22000, 'credit today 40,000; debt at day end 22,000');
  PERFORM pg_temp.check('Collections not yet remitted' = ANY (r.variances), 'flags unremitted cash');
  -- Credit sales count as sold stock, not unsold.
  PERFORM pg_temp.check((public.marketer_statement('c0000000-0000-0000-0000-000000000001')->'cumulative'->'stock'->>'sold')::numeric = 220, 'credit sales are sold stock');
  BEGIN
    PERFORM public.close_marketer_day('c0000000-0000-0000-0000-000000000001', CURRENT_DATE, NULL);
    RAISE EXCEPTION 'ASSERTION FAILED: day with variances closed without a note';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  v_close := public.close_marketer_day('c0000000-0000-0000-0000-000000000001', CURRENT_DATE, 'Abacha brings the 60,000 tomorrow');
  PERFORM pg_temp.check((SELECT (figures->>'unremitted')::numeric FROM marketer_day_closes WHERE id = (v_close->>'id')::uuid) = 60000, 'snapshot kept');
  BEGIN
    PERFORM public.close_marketer_day('c0000000-0000-0000-0000-000000000001', CURRENT_DATE, 'again');
    RAISE EXCEPTION 'ASSERTION FAILED: day closed twice';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
END $$;
SELECT 'ok' AS result;

-- @@ Reassignment keeps history with the original marketer
DO $$
DECLARE v_a uuid := (SELECT v FROM ids WHERE k = 'A');
BEGIN
  BEGIN
    PERFORM public.reassign_customer_marketer(v_a, 'c0000000-0000-0000-0000-000000000002', '');
    RAISE EXCEPTION 'ASSERTION FAILED: reassigned without a reason';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  PERFORM public.reassign_customer_marketer(v_a, 'c0000000-0000-0000-0000-000000000002', 'Moved to Godwin''s route');
  PERFORM pg_temp.check((public.marketer_statement('c0000000-0000-0000-0000-000000000001')->'cumulative'->'sales'->>'value')::numeric = 222000, 'Abacha keeps his sales');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM customer_marketer_history WHERE customer_id = v_a) = 2, 'history has both');
  PERFORM pg_temp.check((SELECT reason FROM customer_marketer_history WHERE customer_id = v_a ORDER BY changed_at DESC, id LIMIT 1) IS NOT NULL, 'reason stored');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'reassign_customer_marketer' AND entity_id = v_a::text), 'audit logged');
END $$;
SELECT 'ok' AS result;
