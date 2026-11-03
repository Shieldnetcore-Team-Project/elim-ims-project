-- ============================================================================
-- Acceptance tests: the Warehouse edits a marketer's / the shop's return in
-- place (20261103100000_correct_rep_return.sql,
-- 20261103120000_edit_rep_return_in_place.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The Warehouse posts 10 dispensers and 10
-- packs to a marketer; 4 dispensers are entered as returned yesterday but it
-- was 3 (and 2 packs came back too).
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3500000-0000-0000-0000-000000000001', 'crrfac', 'Correct Return Factory');
INSERT INTO auth.users(id, email) VALUES ('a3500000-0000-0000-0000-000000000001', 'admin@crr');
INSERT INTO user_roles(user_id, role) VALUES ('a3500000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e3500000-0000-0000-0000-000000000001', 'f3500000-0000-0000-0000-000000000001', 'CRR Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3500000-0000-0000-0000-000000000001', 'f3500000-0000-0000-0000-000000000001', 'CRR Dispenser Water', 'Piece', 1200, 100, 'finished'),
  ('b3500000-0000-0000-0000-000000000002', 'f3500000-0000-0000-0000-000000000001', 'CRR 75cl', 'Pack', 300, 100, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b3500000-0000-0000-0000-000000000001', 'e3500000-0000-0000-0000-000000000001', 1, 'with_water');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3500000-0000-0000-0000-000000000001', 'f3500000-0000-0000-0000-000000000001', 'CRR Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a3500000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.held(p uuid) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c3500000-0000-0000-0000-000000000001'
                     AND product_id = p), 0)
$$;
CREATE OR REPLACE FUNCTION pg_temp.wh(p uuid) RETURNS numeric LANGUAGE sql AS $$
  SELECT current_stock FROM products WHERE id = p
$$;
CREATE OR REPLACE FUNCTION pg_temp.jugs() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(balance), 0) FROM container_balances
   WHERE holder_type = 'sales_rep' AND holder_id = 'c3500000-0000-0000-0000-000000000001'
$$;
-- What the marketer's stock moves of one product add up to on a day.
CREATE OR REPLACE FUNCTION pg_temp.day_net(p uuid, d date) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(quantity), 0) FROM rep_stock_movements
   WHERE sales_rep_id = 'c3500000-0000-0000-0000-000000000001' AND product_id = p AND public._jug_day(created_at) = d
     AND movement_type <> 'dispatch_in'
$$;
CREATE TEMP TABLE t_state(k text PRIMARY KEY, val text);
GRANT ALL ON t_state TO PUBLIC;

-- @@ Test 1: 4 entered for yesterday, edited to 3 (and 2 packs added) -- same return, no reason, everything follows
DO $$
DECLARE v jsonb; c jsonb; y date := public._lagos_today() - 1;
  disp uuid := 'b3500000-0000-0000-0000-000000000001'; pack uuid := 'b3500000-0000-0000-0000-000000000002';
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f3500000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3500000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', disp, 'quantity', 10),
                               jsonb_build_object('product_id', pack, 'quantity', 10))));
  v := public.create_rep_return(jsonb_build_object('factory_id', 'f3500000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3500000-0000-0000-0000-000000000001', 'return_date', y,
    'items', jsonb_build_array(jsonb_build_object('product_id', disp, 'quantity_returned', 4))));
  INSERT INTO t_state VALUES ('rr', v->>'id'), ('no', v->>'return_number');
  PERFORM pg_temp.check(pg_temp.held(disp) = 6 AND pg_temp.wh(disp) = 94 AND pg_temp.jugs() = 6, 'after the wrong entry');

  c := public.correct_rep_return((v->>'id')::uuid, jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object('product_id', disp, 'quantity_returned', 3),
                               jsonb_build_object('product_id', pack, 'quantity_returned', 2))));
  PERFORM pg_temp.check(c->>'return_number' = v->>'return_number' AND NOT (c->>'removed')::boolean, 'same return: ' || c::text);
  PERFORM pg_temp.check((SELECT count(*) FROM rep_returns WHERE sales_rep_id = 'c3500000-0000-0000-0000-000000000001') = 1,
                        'no second return record');
  PERFORM pg_temp.check((SELECT status FROM rep_returns WHERE id = (v->>'id')::uuid) = 'completed', 'still completed');
  PERFORM pg_temp.check((SELECT quantity_returned FROM rep_return_items WHERE rep_return_id = (v->>'id')::uuid AND product_id = disp) = 3
                    AND (SELECT quantity_returned FROM rep_return_items WHERE rep_return_id = (v->>'id')::uuid AND product_id = pack) = 2,
                        'lines edited');
  PERFORM pg_temp.check(pg_temp.held(disp) = 7 AND pg_temp.wh(disp) = 93 AND pg_temp.jugs() = 7,
                        'dispensers: marketer 7, Warehouse 93, jugs 7: ' || pg_temp.held(disp) || ' / ' || pg_temp.wh(disp) || ' / ' || pg_temp.jugs());
  PERFORM pg_temp.check(pg_temp.held(pack) = 8 AND pg_temp.wh(pack) = 92, 'packs: marketer 8, Warehouse 92');
  PERFORM pg_temp.check(pg_temp.day_net(disp, y) = -3 AND pg_temp.day_net(pack, y) = -2,
                        'yesterday shows 3 and 2 back: ' || pg_temp.day_net(disp, y) || ', ' || pg_temp.day_net(pack, y));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'edit_rep_return' AND entity_id = v->>'id'
                          AND old_value->'items' @> jsonb_build_array(jsonb_build_object('product_id', disp, 'quantity_returned', 4))),
                        'the audit log keeps the old figures');
END $$;

-- @@ Test 2: more than they hold is refused; nothing moves
DO $$
DECLARE e text; disp uuid := 'b3500000-0000-0000-0000-000000000001';
BEGIN
  e := pg_temp.err(format('SELECT public.correct_rep_return(%L, %L)', (SELECT val FROM t_state WHERE k = 'rr'),
    jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', disp, 'quantity_returned', 30)))));
  PERFORM pg_temp.check(e LIKE '%isn''t possible%', 'refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check(pg_temp.held(disp) = 7 AND pg_temp.wh(disp) = 93, 'unchanged');
END $$;

-- @@ Test 3: the date moves with an edit; then every line at 0 removes it
DO $$
DECLARE c jsonb; d2 date := public._lagos_today() - 2; y date := public._lagos_today() - 1;
  disp uuid := 'b3500000-0000-0000-0000-000000000001'; pack uuid := 'b3500000-0000-0000-0000-000000000002';
  rid uuid := (SELECT val FROM t_state WHERE k = 'rr')::uuid;
BEGIN
  c := public.correct_rep_return(rid, jsonb_build_object('return_date', d2,
    'items', jsonb_build_array(jsonb_build_object('product_id', disp, 'quantity_returned', 3),
                               jsonb_build_object('product_id', pack, 'quantity_returned', 2))));
  PERFORM pg_temp.check((SELECT return_date FROM rep_returns WHERE id = rid) = d2, 'moved to the day before');
  PERFORM pg_temp.check(pg_temp.day_net(disp, d2) = -3 AND pg_temp.day_net(disp, y) = 0, 'its moves moved too');

  c := public.correct_rep_return(rid, jsonb_build_object('items', '[]'::jsonb));
  PERFORM pg_temp.check((c->>'removed')::boolean, 'removed');
  PERFORM pg_temp.check((SELECT status FROM rep_returns WHERE id = rid) = 'cancelled', 'cancelled, not shown');
  PERFORM pg_temp.check(pg_temp.held(disp) = 10 AND pg_temp.wh(disp) = 90 AND pg_temp.jugs() = 10
                    AND pg_temp.held(pack) = 10 AND pg_temp.wh(pack) = 90, 'everything back with the marketer');
  PERFORM pg_temp.check(pg_temp.day_net(disp, d2) = 0, 'that day nets to nothing');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'remove_rep_return' AND entity_id = rid::text), 'audited');
END $$;

-- @@ Test 4: correcting a date needs no reason either
DO $$
DECLARE v jsonb;
BEGIN
  v := public.create_rep_return(jsonb_build_object('factory_id', 'f3500000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3500000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000002', 'quantity_returned', 1))));
  PERFORM public.correct_return_date('rep', v->>'return_number', public._lagos_today() - 1, NULL);
  PERFORM pg_temp.check((SELECT return_date FROM rep_returns WHERE id = (v->>'id')::uuid) = public._lagos_today() - 1, 're-dated');
END $$;
