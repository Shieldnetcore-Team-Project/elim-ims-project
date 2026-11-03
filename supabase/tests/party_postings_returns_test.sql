-- ============================================================================
-- Acceptance tests: party_postings_and_returns
-- (20261103110000_party_postings_returns.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A marketer gets two postings and returns
-- some (one return corrected away); a distributor buys and returns.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3600000-0000-0000-0000-000000000001', 'pprfac', 'PPR Factory');
INSERT INTO auth.users(id, email) VALUES ('a3600000-0000-0000-0000-000000000001', 'admin@ppr');
INSERT INTO user_roles(user_id, role) VALUES ('a3600000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3600000-0000-0000-0000-000000000001', 'f3600000-0000-0000-0000-000000000001', 'PPR 75cl', 'Pack', 300, 500, 'finished'),
  ('b3600000-0000-0000-0000-000000000002', 'f3600000-0000-0000-0000-000000000001', 'PPR Sachet', 'Bag', 200, 500, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3600000-0000-0000-0000-000000000001', 'f3600000-0000-0000-0000-000000000001', 'PPR Marketer', 'active', 'rep');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d3600000-0000-0000-0000-000000000001', 'f3600000-0000-0000-0000-000000000001', 'PPR Distributor', true);
SELECT set_config('test.uid', 'a3600000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: a marketer -- every posting line, returns without the cancelled one
DO $$
DECLARE r1 jsonb; r2 jsonb; n int;
  f uuid := 'f3600000-0000-0000-0000-000000000001'; m uuid := 'c3600000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3600000-0000-0000-0000-000000000001', 'quantity', 30),
                               jsonb_build_object('product_id', 'b3600000-0000-0000-0000-000000000002', 'quantity', 10))));
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3600000-0000-0000-0000-000000000001', 'quantity', 20))));
  r1 := public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3600000-0000-0000-0000-000000000001', 'quantity_returned', 5))));
  r2 := public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3600000-0000-0000-0000-000000000002', 'quantity_returned', 2))));
  PERFORM public.correct_rep_return((r2->>'id')::uuid, jsonb_build_object('reason', 'mistake', 'items', '[]'::jsonb));

  SELECT count(*) INTO n FROM public.party_postings_and_returns(f, m, NULL) WHERE kind = 'posting';
  PERFORM pg_temp.check(n = 3, '3 posting lines: ' || n);
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM public.party_postings_and_returns(f, m, NULL)
                          WHERE kind = 'posting' AND product_name = 'PPR 75cl') = 50, '75cl posted 50');
  PERFORM pg_temp.check((SELECT count(*) FROM public.party_postings_and_returns(f, m, NULL) WHERE kind = 'return') = 1
                    AND (SELECT SUM(quantity) FROM public.party_postings_and_returns(f, m, NULL) WHERE kind = 'return') = 5,
                        'one live return of 5 (the removed one left out)');
END $$;

-- @@ Test 2: a distributor by name -- their supplies and returns
DO $$
DECLARE f uuid := 'f3600000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', 'd3600000-0000-0000-0000-000000000001',
    'customer_name', 'PPR Distributor',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3600000-0000-0000-0000-000000000001', 'quantity', 12))));
  UPDATE sales SET status = 'posted' WHERE customer_name = 'PPR Distributor';
  PERFORM public.warehouse_receive_customer_return(jsonb_build_object(
    'customer_id', 'd3600000-0000-0000-0000-000000000001', 'all_products', true,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3600000-0000-0000-0000-000000000001', 'quantity', 3))));
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM public.party_postings_and_returns(f, NULL, 'ppr distributor ')
                          WHERE kind = 'posting') = 12, 'supplied 12');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM public.party_postings_and_returns(f, NULL, 'PPR Distributor')
                          WHERE kind = 'return') = 3, 'returned 3');
END $$;
