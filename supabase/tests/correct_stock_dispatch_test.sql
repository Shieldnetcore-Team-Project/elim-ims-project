-- ============================================================================
-- Acceptance tests: correcting a posting to a marketer, and the return /
-- add-products cycle (20261027200000_correct_stock_dispatch.sql).
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Uses its own factory, products and
-- marketer.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f1000000-0000-0000-0000-000000000001', 'corrdsp', 'Correct Dispatch Factory');
INSERT INTO auth.users(id, email) VALUES ('a1000000-0000-0000-0000-000000000001', 'admin@corrdsp');
DELETE FROM user_roles WHERE user_id = 'a1000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a1000000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'Corr 50cl', 'Pack', 1000, 500),
  ('b1000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'Corr 75cl', 'Pack', 800, 500);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'Corr Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a1000000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.wh(p text) RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM products WHERE id = ('b1000000-0000-0000-0000-00000000000' || p)::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.rep(p text) RETURNS numeric LANGUAGE sql AS
  $$ SELECT COALESCE((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c1000000-0000-0000-0000-000000000001'
                      AND product_id = ('b1000000-0000-0000-0000-00000000000' || p)::uuid), 0) $$;

-- @@ Test 1: wrong figure and product corrected
DO $$
DECLARE v jsonb; c jsonb;
  f uuid := 'f1000000-0000-0000-0000-000000000001'; r uuid := 'c1000000-0000-0000-0000-000000000001';
  p50 uuid := 'b1000000-0000-0000-0000-000000000001'; p75 uuid := 'b1000000-0000-0000-0000-000000000002';
BEGIN
  -- Posted 100 of 50cl yesterday; it should have been 60 of 50cl and 30 of 75cl.
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
         'dispatch_date', CURRENT_DATE - 1,
         'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 100))));
  c := public.correct_stock_dispatch((v->>'id')::uuid, jsonb_build_object(
         'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 60),
                                    jsonb_build_object('product_id', p75, 'quantity', 30))));
  PERFORM pg_temp.check((SELECT status FROM stock_dispatches WHERE id = (v->>'id')::uuid) = 'reversed', 'old reversed');
  PERFORM pg_temp.check((SELECT dispatch_date FROM stock_dispatches WHERE id = (c->>'id')::uuid) = CURRENT_DATE - 1,
                        'new keeps the date');
  PERFORM pg_temp.check((SELECT total_value FROM stock_dispatches WHERE id = (c->>'id')::uuid) = 60*1000 + 30*800,
                        'new total');
  PERFORM pg_temp.check(pg_temp.wh('1') = 440 AND pg_temp.wh('2') = 470, 'warehouse 440 / 470');
  PERFORM pg_temp.check(pg_temp.rep('1') = 60 AND pg_temp.rep('2') = 30, 'marketer 60 / 30');
END $$;

-- @@ Test 2: can't take off more than the marketer still holds
DO $$
DECLARE d uuid; ok boolean := false;
  r uuid := 'c1000000-0000-0000-0000-000000000001'; p50 uuid := 'b1000000-0000-0000-0000-000000000001';
BEGIN
  SELECT id INTO d FROM stock_dispatches WHERE sales_rep_id = r AND status = 'posted';
  -- 50 of the 60 come back as a return, so only 10 are left on the marketer.
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', 'f1000000-0000-0000-0000-000000000001',
            'sales_rep_id', r, 'return_date', CURRENT_DATE - 1,
            'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity_returned', 50))));
  BEGIN
    PERFORM public.correct_stock_dispatch(d, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 5))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already sold or returned%';
  END;
  PERFORM pg_temp.check(ok, 'refused');
  PERFORM pg_temp.check((SELECT status FROM stock_dispatches WHERE id = d) = 'posted', 'posting unchanged');
  PERFORM pg_temp.check(pg_temp.rep('1') = 10 AND pg_temp.wh('1') = 490, 'stock unchanged after refusal');
END $$;

-- @@ Test 3: return carried into a new posting, then that posting corrected
DO $$
DECLARE ret uuid; v jsonb; c jsonb;
  f uuid := 'f1000000-0000-0000-0000-000000000001'; r uuid := 'c1000000-0000-0000-0000-000000000001';
  p50 uuid := 'b1000000-0000-0000-0000-000000000001'; p75 uuid := 'b1000000-0000-0000-0000-000000000002';
BEGIN
  SELECT id INTO ret FROM rep_returns WHERE sales_rep_id = r;
  -- Out again today: the 50 returned plus 20 more of 75cl.
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r, 'carry_return_id', ret,
         'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 50),
                                    jsonb_build_object('product_id', p75, 'quantity', 20))));
  PERFORM pg_temp.check(pg_temp.rep('1') = 60 AND pg_temp.rep('2') = 50, 'marketer 60 / 50 after add');
  -- The extra was really 25, not 20.
  c := public.correct_stock_dispatch((v->>'id')::uuid, jsonb_build_object(
         'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 50),
                                    jsonb_build_object('product_id', p75, 'quantity', 25))));
  PERFORM pg_temp.check(pg_temp.rep('2') = 55 AND pg_temp.wh('2') = 445, '75cl corrected');
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_returns WHERE id = ret) = (c->>'id')::uuid,
                        'return still carried, into the new posting');
END $$;
