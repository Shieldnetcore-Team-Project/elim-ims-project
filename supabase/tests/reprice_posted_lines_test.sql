-- ============================================================================
-- Acceptance tests: reprice_posted_lines (20261103180000_reprice_posted_lines.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. As Abacha on 2 Nov: 33 Dispenser Water
-- posted while the price read N4,200, 32 at N1,200 (65 = N177,000); 3 came
-- back while the price read N4,200.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f4100000-0000-0000-0000-000000000001', 'rplfac', 'RPL Factory');
INSERT INTO auth.users(id, email) VALUES ('a4100000-0000-0000-0000-000000000001', 'admin@rpl');
INSERT INTO user_roles(user_id, role) VALUES ('a4100000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b4100000-0000-0000-0000-000000000001', 'f4100000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 4200, 200, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c4100000-0000-0000-0000-000000000001', 'f4100000-0000-0000-0000-000000000001', 'RPL Abacha', 'active', 'rep');
SELECT set_config('test.uid', 'a4100000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.posted() RETURNS numeric LANGUAGE sql AS $$
  SELECT SUM(i.line_value) FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
   WHERE d.sales_rep_id = 'c4100000-0000-0000-0000-000000000001'
$$;
CREATE OR REPLACE FUNCTION pg_temp.returned() RETURNS numeric LANGUAGE sql AS $$
  SELECT SUM(i.quantity_returned * i.unit_price) FROM rep_return_items i JOIN rep_returns r ON r.id = i.rep_return_id
   WHERE r.sales_rep_id = 'c4100000-0000-0000-0000-000000000001'
$$;

-- @@ Test 1: postings and returns at the wrong price are put right; the right ones are left alone
DO $$
DECLARE n int; f uuid := 'f4100000-0000-0000-0000-000000000001'; m uuid := 'c4100000-0000-0000-0000-000000000001';
  p uuid := 'b4100000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 33))));
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity_returned', 3))));
  UPDATE products SET unit_price = 1200 WHERE id = p;
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 32))));
  PERFORM pg_temp.check(pg_temp.posted() = 177000, 'as found: 177,000 posted: ' || pg_temp.posted());
  PERFORM pg_temp.check(pg_temp.returned() = 12600, 'as found: 12,600 credited');

  SELECT count(*) INTO n FROM public.reprice_posted_lines(p, NULL, true);
  PERFORM pg_temp.check(n = 2, 'dry run lists the wrong posting and the wrong return: ' || n);
  PERFORM pg_temp.check(pg_temp.posted() = 177000, 'a dry run changes nothing');

  PERFORM public.reprice_posted_lines(p, 'Each dispenser is N1,200');
  PERFORM pg_temp.check(pg_temp.posted() = 78000, '65 x 1,200 = 78,000: ' || pg_temp.posted());
  PERFORM pg_temp.check(pg_temp.returned() = 3600, '3 x 1,200 = 3,600 credited: ' || pg_temp.returned());
  PERFORM pg_temp.check((SELECT SUM(total_value) FROM stock_dispatches WHERE sales_rep_id = m) = 78000, 'posting totals follow');
  PERFORM pg_temp.check((SELECT count(*) FROM audit_logs WHERE action = 'reprice_posted_lines') = 2, 'audited');
  SELECT count(*) INTO n FROM public.reprice_posted_lines(p, NULL, true);
  PERFORM pg_temp.check(n = 0, 'nothing left to fix');
END $$;

-- @@ Test 2: a mistake fixed on Costing corrects only lines at the wrong price, since the day chosen (20261103190000)
DO $$
DECLARE n int; f uuid := 'f4100000-0000-0000-0000-000000000001'; m uuid := 'c4100000-0000-0000-0000-000000000001';
  p uuid := 'b4100000-0000-0000-0000-000000000001';
BEGIN
  -- A genuine price of 1,500 for a while (one posting), then a mistake: 3,000 (two postings).
  UPDATE products SET unit_price = 1500 WHERE id = p;
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 1))));
  UPDATE products SET unit_price = 3000 WHERE id = p;
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 2))));
  -- Put right on Costing: 1,500; correct what went out at 3,000 since today.
  UPDATE products SET unit_price = 1500 WHERE id = p;
  SELECT count(*) INTO n FROM public.reprice_posted_lines(p, NULL, true, public._lagos_today(), 3000);
  PERFORM pg_temp.check(n = 1, 'only the posting at 3,000: ' || n);
  PERFORM public.reprice_posted_lines(p, 'Price corrected on Costing', false, public._lagos_today(), 3000);
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM stock_dispatch_items WHERE product_id = p AND unit_price = 3000),
                        'nothing left at 3,000');
  PERFORM pg_temp.check((SELECT count(*) FROM stock_dispatch_items WHERE product_id = p AND unit_price = 1200) = 2,
                        'the earlier 1,200 postings untouched (old price filter)');
  PERFORM pg_temp.check((SELECT count(*) FROM stock_dispatch_items WHERE product_id = p AND unit_price = 1500) = 2,
                        'the genuine 1,500 posting and the corrected one');
END $$;
