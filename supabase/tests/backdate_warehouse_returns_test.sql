-- ============================================================================
-- Acceptance tests: back-dated Warehouse returns and correcting their date
-- (20261103090000_backdate_warehouse_returns.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Own factory: a marketer, the shop, a
-- distributor; dispensers carry a jug. Dates are Lagos days.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3400000-0000-0000-0000-000000000001', 'bdrfac', 'Backdate Factory');
INSERT INTO auth.users(id, email) VALUES ('a3400000-0000-0000-0000-000000000001', 'admin@bdr');
INSERT INTO user_roles(user_id, role) VALUES ('a3400000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e3400000-0000-0000-0000-000000000001', 'f3400000-0000-0000-0000-000000000001', 'BDR Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3400000-0000-0000-0000-000000000001', 'f3400000-0000-0000-0000-000000000001', 'BDR Dispenser Water', 'Piece', 1200, 100, 'finished'),
  ('b3400000-0000-0000-0000-000000000002', 'f3400000-0000-0000-0000-000000000001', 'BDR 75cl', 'Pack', 300, 100, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b3400000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000001', 1, 'with_water');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3400000-0000-0000-0000-000000000001', 'f3400000-0000-0000-0000-000000000001', 'BDR Marketer', 'active', 'rep'),
  ('c3400000-0000-0000-0000-000000000002', 'f3400000-0000-0000-0000-000000000001', 'BDR Shop', 'active', 'outlet');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d3400000-0000-0000-0000-000000000001', 'f3400000-0000-0000-0000-000000000001', 'BDR Distributor', true);
SELECT set_config('test.uid', 'a3400000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.today() RETURNS date LANGUAGE sql AS $$ SELECT public._lagos_today() $$;
-- Every ledger row of a marketer / shop return, on day d?
CREATE OR REPLACE FUNCTION pg_temp.rr_on(p_number text, d date) RETURNS boolean LANGUAGE sql AS $$
  SELECT (SELECT return_date FROM rep_returns WHERE return_number = p_number) = d
     AND public._jug_day((SELECT received_at FROM rep_returns WHERE return_number = p_number)) = d
     AND NOT EXISTS (SELECT 1 FROM rep_stock_movements WHERE reference = p_number AND public._jug_day(created_at) <> d)
     AND EXISTS (SELECT 1 FROM rep_stock_movements WHERE reference = p_number)
     AND NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reference = p_number AND public._jug_day(created_at) <> d)
     AND EXISTS (SELECT 1 FROM inventory_movements WHERE reference = p_number)
     AND NOT EXISTS (SELECT 1 FROM container_movements m JOIN rep_returns r ON r.id = m.rep_return_id
                      WHERE r.return_number = p_number AND public._jug_day(m.created_at) <> d)
$$;
CREATE TEMP TABLE t_state(k text PRIMARY KEY, val text);
GRANT ALL ON t_state TO PUBLIC;

-- @@ Test 1: post 10 to the marketer; a return keyed in today for yesterday lands on yesterday
DO $$
DECLARE v jsonb; y date := pg_temp.today() - 1;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f3400000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3400000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3400000-0000-0000-0000-000000000001', 'quantity', 10))));
  v := public.create_rep_return(jsonb_build_object('factory_id', 'f3400000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3400000-0000-0000-0000-000000000001', 'return_date', y,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3400000-0000-0000-0000-000000000001', 'quantity_returned', 3))));
  INSERT INTO t_state VALUES ('rr1', v->>'return_number');
  PERFORM pg_temp.check(pg_temp.rr_on(v->>'return_number', y), 'return, stock moves and jugs on yesterday');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM container_movements m WHERE m.rep_return_id = (v->>'id')::uuid),
                        'the jugs moved with it');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c3400000-0000-0000-0000-000000000001'
                           AND product_id = 'b3400000-0000-0000-0000-000000000001') = 7, 'marketer holds 7');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b3400000-0000-0000-0000-000000000001') = 93,
                        'Warehouse 100 - 10 + 3');
  -- Today's return stays at the real time.
  v := public.create_rep_return(jsonb_build_object('factory_id', 'f3400000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3400000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3400000-0000-0000-0000-000000000001', 'quantity_returned', 1))));
  PERFORM pg_temp.check(pg_temp.rr_on(v->>'return_number', pg_temp.today()), 'an undated return is today');
END $$;

-- @@ Test 2: never a future date
DO $$
DECLARE e text;
BEGIN
  e := pg_temp.err(format($q$SELECT public.create_rep_return(jsonb_build_object('factory_id', 'f3400000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3400000-0000-0000-0000-000000000001', 'return_date', %L,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3400000-0000-0000-0000-000000000001', 'quantity_returned', 1))))$q$,
    pg_temp.today() + 1));
  PERFORM pg_temp.check(e LIKE '%future%', 'future refused: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 3: a wrong date is corrected -- everything moves, a reason is required, the audit keeps both dates
DO $$
DECLARE v jsonb; e text; n text := (SELECT val FROM t_state WHERE k = 'rr1'); d2 date := pg_temp.today() - 2;
BEGIN
  e := pg_temp.err(format('SELECT public.correct_return_date(%L, %L, %L, %L)', 'rep', n, d2, ' '));
  PERFORM pg_temp.check(e LIKE '%Say why%', 'reason required: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format('SELECT public.correct_return_date(%L, %L, %L, %L)', 'rep', n, pg_temp.today() + 1, 'x'));
  PERFORM pg_temp.check(e LIKE '%future%', 'no future correction');
  v := public.correct_return_date('rep', n, d2, 'Typed the wrong day');
  PERFORM pg_temp.check((v->>'old_date')::date = pg_temp.today() - 1 AND (v->>'return_date')::date = d2, 'result: ' || v::text);
  PERFORM pg_temp.check(pg_temp.rr_on(n, d2), 'return, stock moves and jugs moved to the corrected day');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'correct_return_date' AND entity_id = n
                          AND (old_value->>'return_date')::date = pg_temp.today() - 1
                          AND new_value->>'reason' = 'Typed the wrong day'), 'audited');
  e := pg_temp.err(format('SELECT public.correct_return_date(%L, %L, %L, %L)', 'rep', n, d2, 'again'));
  PERFORM pg_temp.check(e LIKE '%already dated%', 'same date refused');
  -- Quantities are untouched.
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c3400000-0000-0000-0000-000000000001'
                           AND product_id = 'b3400000-0000-0000-0000-000000000001') = 6, 'marketer holds 6 (10 - 3 - 1)');
END $$;

-- @@ Test 4: the jug ledger is still append-only outside a re-date
DO $$
DECLARE e text;
BEGIN
  e := pg_temp.err($q$UPDATE container_movements SET created_at = now() - interval '9 days'
                      WHERE factory_id = 'f3400000-0000-0000-0000-000000000001'$q$);
  PERFORM pg_temp.check(e LIKE '%append-only%', 'a plain update is refused: ' || COALESCE(e, 'no error'));
  PERFORM set_config('elim.redating', 'on', true);
  e := pg_temp.err($q$UPDATE container_movements SET quantity = quantity + 1
                      WHERE factory_id = 'f3400000-0000-0000-0000-000000000001'$q$);
  PERFORM set_config('elim.redating', 'off', true);
  PERFORM pg_temp.check(e LIKE '%append-only%', 'even while re-dating, only the time may change: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 5: the shop -- back-dated return to the Warehouse; a day closed with Accounts is refused both ways
DO $$
DECLARE v jsonb; e text; y date := pg_temp.today() - 1; d3 date := pg_temp.today() - 3;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f3400000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3400000-0000-0000-0000-000000000002',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3400000-0000-0000-0000-000000000002', 'quantity', 20))));
  v := public.return_shop_stock_to_warehouse(jsonb_build_object('outlet_id', 'c3400000-0000-0000-0000-000000000002',
    'return_date', y, 'items', jsonb_build_array(jsonb_build_object('product_id', 'b3400000-0000-0000-0000-000000000002', 'quantity', 5))));
  PERFORM pg_temp.check(pg_temp.rr_on(v->>'return_number', y), 'shop return on yesterday');

  INSERT INTO outlet_day_reconciliations(factory_id, sales_rep_id, close_date, status, figures)
  VALUES ('f3400000-0000-0000-0000-000000000001', 'c3400000-0000-0000-0000-000000000002', d3, 'submitted', '{}'::jsonb);
  e := pg_temp.err(format($q$SELECT public.create_rep_return(jsonb_build_object('factory_id', 'f3400000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3400000-0000-0000-0000-000000000002', 'return_date', %L,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3400000-0000-0000-0000-000000000002', 'quantity_returned', 1))))$q$, d3));
  PERFORM pg_temp.check(e LIKE '%already closed%', 'no return into a closed shop day: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format('SELECT public.correct_return_date(%L, %L, %L, %L)', 'rep', v->>'return_number', d3, 'x'));
  PERFORM pg_temp.check(e LIKE '%already closed%', 'no correction into a closed shop day: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 6: a distributor's return dated yesterday, then corrected -- every line and its stock move follow
DO $$
DECLARE v jsonb; y date := pg_temp.today() - 1; d4 date := pg_temp.today() - 4; n text;
BEGIN
  v := public.warehouse_receive_customer_return(jsonb_build_object(
         'customer_id', 'd3400000-0000-0000-0000-000000000001', 'all_products', true, 'return_date', y,
         'items', jsonb_build_array(jsonb_build_object('product_id', 'b3400000-0000-0000-0000-000000000002', 'quantity', 4))));
  n := v->>'return_number';
  PERFORM pg_temp.check((SELECT bool_and(return_date = y) AND count(*) > 0 FROM sales_returns WHERE return_number LIKE n || '-%'),
                        'return lines on yesterday');
  PERFORM pg_temp.check((SELECT bool_and(public._jug_day(created_at) = y) AND count(*) > 0
                           FROM inventory_movements WHERE reference LIKE n || '-%'), 'Warehouse stock move on yesterday');
  v := public.correct_return_date('customer', n || '-1', d4, 'Distributor brought them on Friday');
  PERFORM pg_temp.check(v->>'reference' = n, 'a line number corrects its whole return');
  PERFORM pg_temp.check((SELECT bool_and(return_date = d4) FROM sales_returns WHERE return_number LIKE n || '-%')
                    AND (SELECT bool_and(public._jug_day(created_at) = d4) FROM inventory_movements WHERE reference LIKE n || '-%'),
                        'all moved to the corrected day');
END $$;
