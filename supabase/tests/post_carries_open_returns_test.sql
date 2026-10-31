-- ============================================================================
-- Acceptance tests: a posting carries the marketer's open returns
-- (20261031150000_post_carries_open_returns.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Marketer "PCR Ada" gets 100 of 50cl and
-- 40 of 75cl, then returns 30 of 50cl and, later, 10 of 75cl. The next
-- posting carries both returns plus 5 more 50cl.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3100000-0000-0000-0000-000000000001', 'pcrfac', 'PCR Factory');
INSERT INTO auth.users(id, email) VALUES ('a3100000-0000-0000-0000-000000000001', 'admin@pcr');
DELETE FROM user_roles WHERE user_id = 'a3100000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a3100000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b3100000-0000-0000-0000-000000000001', 'f3100000-0000-0000-0000-000000000001', 'PCR 50cl', 'Pack', 1000, 500),
  ('b3100000-0000-0000-0000-000000000002', 'f3100000-0000-0000-0000-000000000001', 'PCR 75cl', 'Pack', 800, 500);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3100000-0000-0000-0000-000000000001', 'f3100000-0000-0000-0000-000000000001', 'PCR Ada', 'active', 'rep');
SELECT set_config('test.uid', 'a3100000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.wh(p text) RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM products WHERE id = ('b3100000-0000-0000-0000-00000000000' || p)::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.rep(p text) RETURNS numeric LANGUAGE sql AS
  $$ SELECT COALESCE((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c3100000-0000-0000-0000-000000000001'
                      AND product_id = ('b3100000-0000-0000-0000-00000000000' || p)::uuid), 0) $$;

-- @@ Test 1: two open returns carried by one posting, plus extra
DO $$
DECLARE v jsonb; n int;
  f uuid := 'f3100000-0000-0000-0000-000000000001'; r uuid := 'c3100000-0000-0000-0000-000000000001';
  p50 uuid := 'b3100000-0000-0000-0000-000000000001'; p75 uuid := 'b3100000-0000-0000-0000-000000000002';
  ids uuid[];
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 100),
                               jsonb_build_object('product_id', p75, 'quantity', 40))));
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity_returned', 30))));
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', p75, 'quantity_returned', 10))));
  ids := ARRAY(SELECT id FROM rep_returns WHERE sales_rep_id = r AND status = 'completed');
  PERFORM pg_temp.check(cardinality(ids) = 2, 'two completed returns: ' || cardinality(ids));
  PERFORM pg_temp.check(pg_temp.rep('1') = 70 AND pg_temp.rep('2') = 30, 'van after returns');
  PERFORM pg_temp.check(pg_temp.wh('1') = 430 AND pg_temp.wh('2') = 470, 'warehouse after returns');

  -- What the form sends: the returns' products merged with the extra 5.
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'carry_return_ids', to_jsonb(ids),
    'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 35),
                               jsonb_build_object('product_id', p75, 'quantity', 10))));
  n := (SELECT count(*) FROM rep_returns WHERE id = ANY (ids) AND carried_dispatch_id = (v->>'id')::uuid);
  PERFORM pg_temp.check(n = 2, 'both returns carried: ' || n);
  PERFORM pg_temp.check(pg_temp.rep('1') = 105 AND pg_temp.rep('2') = 40, 'van back to supplies + 5');
  PERFORM pg_temp.check(pg_temp.wh('1') = 395 AND pg_temp.wh('2') = 460, 'warehouse after posting');
END $$;

-- @@ Test 2: a carried return can't be carried again; the single-return form still works
DO $$
DECLARE ok boolean := false; ret uuid; v jsonb;
  f uuid := 'f3100000-0000-0000-0000-000000000001'; r uuid := 'c3100000-0000-0000-0000-000000000001';
  p50 uuid := 'b3100000-0000-0000-0000-000000000001';
BEGIN
  ret := (SELECT id FROM rep_returns WHERE sales_rep_id = r ORDER BY created_at LIMIT 1);
  BEGIN
    PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
      'carry_return_ids', jsonb_build_array(ret),
      'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 1))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already been added to a dispatch%';
  END;
  PERFORM pg_temp.check(ok, 'second carry refused');

  PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity_returned', 5))));
  ret := (SELECT id FROM rep_returns WHERE sales_rep_id = r AND carried_dispatch_id IS NULL);
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r, 'carry_return_id', ret,
    'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 5))));
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_returns WHERE id = ret) = (v->>'id')::uuid,
                        'carry_return_id still links');
END $$;
