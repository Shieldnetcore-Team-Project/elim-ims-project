-- ============================================================================
-- Acceptance tests: the Warehouse corrects a marketer's / the shop's return
-- (20261103100000_correct_rep_return.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The Warehouse posts 10 dispensers to a
-- marketer; 4 are entered as returned yesterday but it was 3.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3500000-0000-0000-0000-000000000001', 'crrfac', 'Correct Return Factory');
INSERT INTO auth.users(id, email) VALUES ('a3500000-0000-0000-0000-000000000001', 'admin@crr');
INSERT INTO user_roles(user_id, role) VALUES ('a3500000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e3500000-0000-0000-0000-000000000001', 'f3500000-0000-0000-0000-000000000001', 'CRR Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3500000-0000-0000-0000-000000000001', 'f3500000-0000-0000-0000-000000000001', 'CRR Dispenser Water', 'Piece', 1200, 100, 'finished');
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
CREATE OR REPLACE FUNCTION pg_temp.held() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c3500000-0000-0000-0000-000000000001'
                     AND product_id = 'b3500000-0000-0000-0000-000000000001'), 0)
$$;
CREATE OR REPLACE FUNCTION pg_temp.wh() RETURNS numeric LANGUAGE sql AS $$
  SELECT current_stock FROM products WHERE id = 'b3500000-0000-0000-0000-000000000001'
$$;
CREATE OR REPLACE FUNCTION pg_temp.jugs() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(balance), 0) FROM container_balances
   WHERE holder_type = 'sales_rep' AND holder_id = 'c3500000-0000-0000-0000-000000000001'
$$;
-- What the marketer's stock moves add up to on a day.
CREATE OR REPLACE FUNCTION pg_temp.day_net(d date) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(quantity), 0) FROM rep_stock_movements
   WHERE sales_rep_id = 'c3500000-0000-0000-0000-000000000001' AND public._jug_day(created_at) = d
$$;
CREATE TEMP TABLE t_state(k text PRIMARY KEY, val text);
GRANT ALL ON t_state TO PUBLIC;

-- @@ Test 1: 4 entered for yesterday, corrected to 3 -- stock, jugs and yesterday all add up to 3
DO $$
DECLARE v jsonb; c jsonb; y date := public._lagos_today() - 1;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f3500000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3500000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000001', 'quantity', 10))));
  v := public.create_rep_return(jsonb_build_object('factory_id', 'f3500000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3500000-0000-0000-0000-000000000001', 'return_date', y,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000001', 'quantity_returned', 4))));
  PERFORM pg_temp.check(pg_temp.held() = 6 AND pg_temp.wh() = 94 AND pg_temp.jugs() = 6, 'after the wrong entry');

  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.correct_rep_return(%L, %L)', v->>'id',
    jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000001',
      'quantity_returned', 3))))) LIKE '%Say why%', 'reason required');

  c := public.correct_rep_return((v->>'id')::uuid, jsonb_build_object('reason', 'Counted 3, not 4',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000001', 'quantity_returned', 3))));
  INSERT INTO t_state VALUES ('new', c->>'id');
  PERFORM pg_temp.check(c->>'cancelled' = v->>'return_number' AND c->>'return_number' IS NOT NULL, 'result: ' || c::text);
  PERFORM pg_temp.check((SELECT status FROM rep_returns WHERE id = (v->>'id')::uuid) = 'cancelled', 'old return cancelled');
  PERFORM pg_temp.check((SELECT return_date FROM rep_returns WHERE id = (c->>'id')::uuid) = y, 'the new one keeps yesterday');
  PERFORM pg_temp.check(pg_temp.held() = 7 AND pg_temp.wh() = 93 AND pg_temp.jugs() = 7,
                        'marketer 7, Warehouse 93, jugs 7: ' || pg_temp.held() || ' / ' || pg_temp.wh() || ' / ' || pg_temp.jugs());
  PERFORM pg_temp.check(pg_temp.day_net(y) = -3, 'yesterday shows 3 back: ' || pg_temp.day_net(y));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'correct_rep_return' AND entity_id = v->>'id'
                          AND new_value->>'reason' = 'Counted 3, not 4'), 'audited');
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.correct_rep_return(%L, %L)', v->>'id',
    jsonb_build_object('reason', 'again', 'items', '[]'::jsonb))) LIKE '%Only a completed return%', 'a cancelled one is not corrected twice');
END $$;

-- @@ Test 2: more than they hold is refused; nothing moves
DO $$
DECLARE e text;
BEGIN
  e := pg_temp.err(format('SELECT public.correct_rep_return(%L, %L)', (SELECT val FROM t_state WHERE k = 'new'),
    jsonb_build_object('reason', 'typo', 'items', jsonb_build_array(jsonb_build_object(
      'product_id', 'b3500000-0000-0000-0000-000000000001', 'quantity_returned', 30)))));
  PERFORM pg_temp.check(e LIKE '%isn''t possible%', 'refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check(pg_temp.held() = 7 AND pg_temp.wh() = 93, 'unchanged');
END $$;

-- @@ Test 3: a return entered by mistake is removed -- no lines
DO $$
DECLARE c jsonb;
BEGIN
  c := public.correct_rep_return((SELECT val FROM t_state WHERE k = 'new')::uuid,
         jsonb_build_object('reason', 'Entered on the wrong marketer', 'items', '[]'::jsonb));
  PERFORM pg_temp.check(c->>'return_number' IS NULL, 'no replacement');
  PERFORM pg_temp.check(pg_temp.held() = 10 AND pg_temp.wh() = 90 AND pg_temp.jugs() = 10, 'all back with the marketer');
  PERFORM pg_temp.check(pg_temp.day_net(public._lagos_today() - 1) = 0, 'yesterday nets to nothing');
END $$;
