-- ============================================================================
-- Tests: remove_customer / restore_customer / remove_marketer
-- (20261017180000_remove_customers_merge_marketers.sql). Same harness as
-- marketer_accountability_test.sql; never run against production.
-- ============================================================================
INSERT INTO factories(id, code, name) VALUES ('f2000000-0000-0000-0000-000000000001', 'rmtest', 'Removal Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'admin@rm'),
  ('a2000000-0000-0000-0000-000000000002', 'acct@rm');
INSERT INTO user_roles(user_id, role) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'super_admin'),
  ('a2000000-0000-0000-0000-000000000002', 'accountant');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b2000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'RM Bottle', 'pack', 1000, 1000);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Emma', 'active', 'rep'),
  ('c2000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'Emma (duplicate)', 'active', 'rep'),
  ('c2000000-0000-0000-0000-000000000003', 'f2000000-0000-0000-0000-000000000001', 'Typo Rep', 'active', 'rep');
INSERT INTO customers(id, factory_id, name, phone, registered) VALUES
  ('d2000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Never Bought', '08011110001', true),
  ('d2000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'Paid Up Shop', '08011110002', true),
  ('d2000000-0000-0000-0000-000000000003', 'f2000000-0000-0000-0000-000000000001', 'Owing Shop', '08011110003', true);
SELECT set_config('test.uid', 'a2000000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.sell(p_rep uuid, p_customer uuid, p_qty numeric, p_paid numeric) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := public.create_sale(jsonb_build_object('factory_id', 'f2000000-0000-0000-0000-000000000001',
    'customer_id', p_customer, 'sales_rep_id', p_rep,
    'payments', CASE WHEN p_paid > 0 THEN jsonb_build_array(jsonb_build_object('amount', p_paid, 'method', 'cash')) ELSE '[]'::jsonb END,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b2000000-0000-0000-0000-000000000001', 'quantity', p_qty, 'unit_price', 1000))));
  PERFORM public.approve_sale((v->>'sale_id')::uuid, NULL);
  RETURN (v->>'sale_id')::uuid;
END;
$$;

-- History for the paid-up and owing shops (warehouse sales).
SELECT pg_temp.sell(NULL, 'd2000000-0000-0000-0000-000000000002', 5, 5000);
SELECT pg_temp.sell(NULL, 'd2000000-0000-0000-0000-000000000003', 5, 2000);

-- @@ Customer with no history is deleted
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('test.uid', 'a2000000-0000-0000-0000-000000000002', false);  -- the accountant
  v := public.remove_customer('d2000000-0000-0000-0000-000000000001', 'Never traded with us');
  PERFORM pg_temp.check(v->>'result' = 'deleted', 'result ' || v::text);
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM customers WHERE id = 'd2000000-0000-0000-0000-000000000001'), 'row gone');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'delete_customer' AND entity_id = 'd2000000-0000-0000-0000-000000000001'), 'audited');
END $$;
SELECT 'ok' AS result;

-- @@ Customer who still owes is refused
DO $$
BEGIN
  BEGIN
    PERFORM public.remove_customer('d2000000-0000-0000-0000-000000000003', 'Stopped buying');
    RAISE EXCEPTION 'ASSERTION FAILED: removed a customer who owes';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF;
    PERFORM pg_temp.check(SQLERRM LIKE '%still owes%', 'message: ' || SQLERRM);
  END;
  BEGIN
    PERFORM public.remove_customer('d2000000-0000-0000-0000-000000000002', '');
    RAISE EXCEPTION 'ASSERTION FAILED: removed without a reason';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
END $$;
SELECT 'ok' AS result;

-- @@ Customer with history is removed, kept, blocked from sales, restorable
DO $$
DECLARE v jsonb; v_inv int;
BEGIN
  SELECT COUNT(*) INTO v_inv FROM sales WHERE customer_id = 'd2000000-0000-0000-0000-000000000002';
  v := public.remove_customer('d2000000-0000-0000-0000-000000000002', 'No longer patronises us');
  PERFORM pg_temp.check(v->>'result' = 'removed', 'result ' || v::text);
  PERFORM pg_temp.check((SELECT removed_at IS NOT NULL AND NOT registered FROM customers WHERE id = 'd2000000-0000-0000-0000-000000000002'), 'flagged');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM sales WHERE customer_id = 'd2000000-0000-0000-0000-000000000002') = v_inv, 'invoices kept');
  PERFORM pg_temp.check(public.customer_statement('d2000000-0000-0000-0000-000000000002')->'invoices' <> '[]'::jsonb, 'statement still works');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.distributor_accounts('f2000000-0000-0000-0000-000000000001') WHERE customer_id = 'd2000000-0000-0000-0000-000000000002'), 'off the distributor list');
  PERFORM set_config('test.uid', 'a2000000-0000-0000-0000-000000000001', false);
  BEGIN
    PERFORM pg_temp.sell(NULL, 'd2000000-0000-0000-0000-000000000002', 1, 1000);
    RAISE EXCEPTION 'ASSERTION FAILED: sold to a removed customer';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF;
    PERFORM pg_temp.check(SQLERRM LIKE '%was removed%', 'message: ' || SQLERRM);
  END;
  BEGIN
    PERFORM public.register_marketer_customer(jsonb_build_object('sales_rep_id', 'c2000000-0000-0000-0000-000000000001',
              'name', 'Paid Up Shop again', 'phone', '+2348011110002'));
    RAISE EXCEPTION 'ASSERTION FAILED: re-registered a removed customer''s phone';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  v := public.restore_customer('d2000000-0000-0000-0000-000000000002');
  PERFORM pg_temp.check((SELECT removed_at IS NULL AND registered FROM customers WHERE id = 'd2000000-0000-0000-0000-000000000002'), 'restored');
  PERFORM pg_temp.sell(NULL, 'd2000000-0000-0000-0000-000000000002', 1, 1000);
END $$;
SELECT 'ok' AS result;

-- @@ Marketer: delete when clean, refuse when it has records
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('test.uid', 'a2000000-0000-0000-0000-000000000002', false);  -- accountant: not allowed
  BEGIN
    PERFORM public.remove_marketer('c2000000-0000-0000-0000-000000000003', 'Typo');
    RAISE EXCEPTION 'ASSERTION FAILED: accountant removed a marketer';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF; END;
  PERFORM set_config('test.uid', 'a2000000-0000-0000-0000-000000000001', false);
  v := public.remove_marketer('c2000000-0000-0000-0000-000000000003', 'Created by mistake');
  PERFORM pg_temp.check(v->>'result' = 'deleted' AND NOT EXISTS (SELECT 1 FROM sales_reps WHERE id = 'c2000000-0000-0000-0000-000000000003'), 'clean marketer deleted');
END $$;
SELECT 'ok' AS result;

-- @@ Duplicate marketer merged into the real one
DO $$
DECLARE v jsonb; v_before_sales numeric; v_cust uuid; v_st jsonb;
BEGIN
  -- Both "Emmas" got stock; the duplicate sold, collected and remitted.
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f2000000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c2000000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b2000000-0000-0000-0000-000000000001', 'quantity', 40))));
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f2000000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c2000000-0000-0000-0000-000000000002',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b2000000-0000-0000-0000-000000000001', 'quantity', 60))));
  v := public.register_marketer_customer(jsonb_build_object('sales_rep_id', 'c2000000-0000-0000-0000-000000000002',
         'name', 'Dup Emma Customer', 'phone', '08011110009'));
  v_cust := (v->>'customer_id')::uuid;
  PERFORM pg_temp.sell('c2000000-0000-0000-0000-000000000002', v_cust, 10, 6000);
  PERFORM public.record_rep_remittance(jsonb_build_object('factory_id', 'f2000000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c2000000-0000-0000-0000-000000000002', 'amount', 6000));

  BEGIN
    PERFORM public.remove_marketer('c2000000-0000-0000-0000-000000000002', 'Duplicate');
    RAISE EXCEPTION 'ASSERTION FAILED: deleted a marketer with records';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'ASSERTION%' THEN RAISE; END IF;
    PERFORM pg_temp.check(SQLERRM LIKE '%merge%', 'message: ' || SQLERRM);
  END;

  v := public.remove_marketer('c2000000-0000-0000-0000-000000000002', 'Same person entered twice',
                              'c2000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(v->>'result' = 'merged', 'result ' || v::text);
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM sales_reps WHERE id = 'c2000000-0000-0000-0000-000000000002'), 'duplicate deleted');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c2000000-0000-0000-0000-000000000001') = 90, 'stock 40 + 60 - 10 = 90');
  PERFORM pg_temp.check((SELECT sales_rep_id FROM customers WHERE id = v_cust) = 'c2000000-0000-0000-0000-000000000001', 'customer moved');
  v_st := public.marketer_statement('c2000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check((v_st->'cumulative'->'sales'->>'value')::numeric = 10000, 'sale moved: ' || (v_st->'cumulative'->'sales')::text);
  PERFORM pg_temp.check((v_st->'cumulative'->>'unremitted')::numeric = 0, 'collections and remittance moved together');
  PERFORM pg_temp.check((v_st->'cumulative'->'stock'->>'closing')::numeric = 90, 'stock trail adds up');
  PERFORM pg_temp.check(v_st->'reconciliation'->'stock_drift' = '[]'::jsonb, 'no stock drift');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'merge_marketer' AND entity_id = 'c2000000-0000-0000-0000-000000000002'), 'audited');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM customer_marketer_history WHERE customer_id = v_cust AND to_rep_id = 'c2000000-0000-0000-0000-000000000001'), 'assignment history kept');
END $$;
SELECT 'ok' AS result;
