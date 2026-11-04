-- ============================================================================
-- Acceptance tests: per-officer carry of returned products + cancelling a
-- Warehouse posting (20261104110000_warehouse_cancel_posting_product_carry.sql)
--
-- "Kemi" handles bottle water, "Gideon" sachet. Marketer "WC Ola" returns a
-- mixed return (bottles + sachet, entered by an admin). Kemi's posting carries
-- only the bottles; the sachet waits for Gideon's posting.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9400000-0000-0000-0000-000000000001', 'wcfac', 'WC Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a9400000-0000-0000-0000-000000000001', 'admin@wc'),
  ('a9400000-0000-0000-0000-000000000002', 'kemi@wc'),
  ('a9400000-0000-0000-0000-000000000003', 'gideon@wc');
INSERT INTO user_roles(user_id, role) VALUES ('a9400000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO roles(slug, label, is_system) VALUES ('wc_wh_test', 'Warehouse (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'wc_wh_test', m::module_key, a::action_key
  FROM unnest(ARRAY['finished-goods', 'distribution', 'sales']) m,
       unnest(ARRAY['view', 'create', 'edit', 'submit', 'confirm']) a
ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id)
SELECT u::uuid, 'wc_wh_test', 'f9400000-0000-0000-0000-000000000001'
  FROM unnest(ARRAY['a9400000-0000-0000-0000-000000000002', 'a9400000-0000-0000-0000-000000000003']) u;
INSERT INTO user_product_rules(user_id, name_pattern, label) VALUES
  ('a9400000-0000-0000-0000-000000000002', 'bottle water', 'Bottle Water'),
  ('a9400000-0000-0000-0000-000000000003', 'sachet', 'Sachet');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b9400000-0000-0000-0000-000000000001', 'f9400000-0000-0000-0000-000000000001', 'WC 50cl Bottle Water', 'Pack', 1000, 500),
  ('b9400000-0000-0000-0000-000000000002', 'f9400000-0000-0000-0000-000000000001', 'WC Sachet Water', 'Bag', 300, 500);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c9400000-0000-0000-0000-000000000001', 'f9400000-0000-0000-0000-000000000001', 'WC Ola', 'active', 'rep');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.wh(p text) RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM products WHERE id = ('b9400000-0000-0000-0000-00000000000' || p)::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.rep(p text) RETURNS numeric LANGUAGE sql AS
  $$ SELECT COALESCE((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c9400000-0000-0000-0000-000000000001'
                      AND product_id = ('b9400000-0000-0000-0000-00000000000' || p)::uuid), 0) $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(n text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'a9400000-0000-0000-0000-00000000000' || n, false) $$;

-- @@ Test 1: Kemi carries only the bottles of a mixed return
DO $$
DECLARE v jsonb; ret uuid;
  f uuid := 'f9400000-0000-0000-0000-000000000001'; r uuid := 'c9400000-0000-0000-0000-000000000001';
  pb uuid := 'b9400000-0000-0000-0000-000000000001'; ps uuid := 'b9400000-0000-0000-0000-000000000002';
BEGIN
  PERFORM pg_temp.as_user('1');
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', pb, 'quantity', 100),
                               jsonb_build_object('product_id', ps, 'quantity', 50))));
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', pb, 'quantity_returned', 20),
                               jsonb_build_object('product_id', ps, 'quantity_returned', 10))));
  ret := (SELECT id FROM rep_returns WHERE sales_rep_id = r);
  PERFORM pg_temp.check((SELECT status FROM rep_returns WHERE id = ret) = 'completed', 'return completed');

  PERFORM pg_temp.as_user('2');
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'carry_return_ids', jsonb_build_array(ret),
    'items', jsonb_build_array(jsonb_build_object('product_id', pb, 'quantity', 20))));
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_return_items WHERE rep_return_id = ret AND product_id = pb)
                        = (v->>'id')::uuid, 'bottle line carried by Kemi');
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_return_items WHERE rep_return_id = ret AND product_id = ps)
                        IS NULL, 'sachet line still open');
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_returns WHERE id = ret) IS NULL, 'return not fully carried');
END $$;

-- @@ Test 2: Gideon carries the sachet; the return is then fully carried
DO $$
DECLARE v jsonb; ret uuid;
  f uuid := 'f9400000-0000-0000-0000-000000000001'; r uuid := 'c9400000-0000-0000-0000-000000000001';
  ps uuid := 'b9400000-0000-0000-0000-000000000002';
BEGIN
  ret := (SELECT id FROM rep_returns WHERE sales_rep_id = r);
  PERFORM pg_temp.as_user('3');
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'carry_return_ids', jsonb_build_array(ret),
    'items', jsonb_build_array(jsonb_build_object('product_id', ps, 'quantity', 10))));
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_returns WHERE id = ret) = (v->>'id')::uuid,
                        'return carried once every line is');
END $$;

-- @@ Test 3: Kemi is refused on the sachet posting; Gideon cancels it and the goods come back
DO $$
DECLARE ok boolean := false; d uuid; ret uuid; wh_before numeric; rep_before numeric;
  r uuid := 'c9400000-0000-0000-0000-000000000001'; ps uuid := 'b9400000-0000-0000-0000-000000000002';
BEGIN
  ret := (SELECT id FROM rep_returns WHERE sales_rep_id = r);
  d := (SELECT carried_dispatch_id FROM rep_returns WHERE id = ret);
  PERFORM pg_temp.as_user('2');
  BEGIN
    PERFORM public.cancel_warehouse_posting('dispatch', d, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%another Warehouse officer%';
  END;
  PERFORM pg_temp.check(ok, 'Kemi refused on a sachet posting');

  wh_before := pg_temp.wh('2'); rep_before := pg_temp.rep('2');
  PERFORM pg_temp.as_user('3');
  PERFORM public.cancel_warehouse_posting('dispatch', d, 'wrong marketer');
  PERFORM pg_temp.check((SELECT status FROM stock_dispatches WHERE id = d) = 'reversed', 'posting reversed');
  PERFORM pg_temp.check(pg_temp.wh('2') = wh_before + 10, 'sachet back in the Warehouse');
  PERFORM pg_temp.check(pg_temp.rep('2') = rep_before - 10, 'sachet off the marketer');
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_returns WHERE id = ret) IS NULL, 'return open again');
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_return_items WHERE rep_return_id = ret AND product_id = ps)
                        IS NULL, 'sachet line open again');

  ok := false;
  BEGIN
    PERFORM public.cancel_warehouse_posting('dispatch', d, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already reversed%';
  END;
  PERFORM pg_temp.check(ok, 'second cancel refused');
END $$;

-- @@ Test 4: a posting the marketer has partly sold can't be cancelled
DO $$
DECLARE ok boolean := false; v jsonb;
  f uuid := 'f9400000-0000-0000-0000-000000000001'; r uuid := 'c9400000-0000-0000-0000-000000000001';
  pb uuid := 'b9400000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.as_user('1');
  DELETE FROM rep_stock WHERE sales_rep_id = r AND product_id = pb;
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', pb, 'quantity', 10))));
  UPDATE rep_stock SET quantity = 4 WHERE sales_rep_id = r AND product_id = pb;
  PERFORM pg_temp.as_user('2');
  BEGIN
    PERFORM public.cancel_warehouse_posting('dispatch', (v->>'id')::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already sold or returned%';
  END;
  PERFORM pg_temp.check(ok, 'refused once sold');
END $$;
