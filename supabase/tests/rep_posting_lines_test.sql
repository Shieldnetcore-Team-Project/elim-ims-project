-- ============================================================================
-- Acceptance tests: rep_posting_lines (20261030220000_rep_posting_lines.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A posting of two products to a marketer
-- and a return: an accountant (who can't read products directly) sees each
-- one's products, quantities, prices and amounts; someone without rights
-- is refused.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'acct@rpl'),
  ('b1000000-0000-0000-0000-000000000002', 'nobody@rpl');
DELETE FROM user_roles WHERE user_id IN ('b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'b1000000-0000-0000-0000-000000000001', 'accountant', id FROM factories WHERE code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT x.id::uuid, f.id, x.name, 'Pack', 'finished', true, 0, x.price
  FROM factories f, (VALUES ('b1000000-0000-0000-0000-0000000000a1', 'RPL 75cl', 1700),
                            ('b1000000-0000-0000-0000-0000000000a2', 'RPL 50cl', 2650)) AS x(id, name, price)
 WHERE f.code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'b1000000-0000-0000-0000-0000000000b1', id, 'RPL Marketer', 'active', 'rep' FROM factories WHERE code = 'water';
INSERT INTO stock_dispatches(id, factory_id, dispatch_number, sales_rep_id, status)
SELECT 'b1000000-0000-0000-0000-0000000000c1', id, 'DSP-RPL-1', 'b1000000-0000-0000-0000-0000000000b1', 'posted'
  FROM factories WHERE code = 'water';
INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value) VALUES
  ('b1000000-0000-0000-0000-0000000000c1', 'b1000000-0000-0000-0000-0000000000a1', 30, 1700, 51000),
  ('b1000000-0000-0000-0000-0000000000c1', 'b1000000-0000-0000-0000-0000000000a2', 20, 2650, 53000);
INSERT INTO rep_returns(id, factory_id, return_number, sales_rep_id, received_by, status)
SELECT 'b1000000-0000-0000-0000-0000000000d1', id, 'RRT-RPL-1', 'b1000000-0000-0000-0000-0000000000b1',
       'b1000000-0000-0000-0000-000000000001', 'completed' FROM factories WHERE code = 'water';
INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price, accepted_quantity, damaged_quantity)
VALUES ('b1000000-0000-0000-0000-0000000000d1', 'b1000000-0000-0000-0000-0000000000a1', 5, 1700, 4, 1);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: an accountant sees the posting's and the return's products; no rights is refused
DO $$
DECLARE got text; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
  got := (SELECT string_agg(concat_ws('/', product_name, quantity::int, unit_price::int, line_total::int), ' ')
            FROM public.rep_posting_lines('dispatch', 'b1000000-0000-0000-0000-0000000000c1'));
  PERFORM pg_temp.check(got = 'RPL 50cl/20/2650/53000 RPL 75cl/30/1700/51000', 'posting: ' || COALESCE(got, 'null'));
  got := (SELECT concat_ws('/', product_name, quantity::int, line_total::int, note)
            FROM public.rep_posting_lines('return', 'b1000000-0000-0000-0000-0000000000d1'));
  PERFORM pg_temp.check(got = 'RPL 75cl/5/8500/accepted 4, damaged 1', 'return: ' || COALESCE(got, 'null'));

  PERFORM set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
  BEGIN
    PERFORM * FROM public.rep_posting_lines('dispatch', 'b1000000-0000-0000-0000-0000000000c1');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM pg_temp.check(ok, 'no rights refused');
END $$;
