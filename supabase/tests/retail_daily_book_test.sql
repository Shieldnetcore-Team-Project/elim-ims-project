-- ============================================================================
-- Acceptance tests: retail_daily_book (20261103140000_retail_daily_book.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The Warehouse posts 20 packs and 5
-- dispensers to the shop; it sells 6 packs and sends 2 back.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3800000-0000-0000-0000-000000000001', 'rdbfac', 'RDB Factory');
INSERT INTO auth.users(id, email) VALUES ('a3800000-0000-0000-0000-000000000001', 'admin@rdb');
INSERT INTO user_roles(user_id, role) VALUES ('a3800000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3800000-0000-0000-0000-000000000001', 'f3800000-0000-0000-0000-000000000001', 'RDB 75cl', 'Pack', 1700, 500, 'finished'),
  ('b3800000-0000-0000-0000-000000000002', 'f3800000-0000-0000-0000-000000000001', 'RDB Sachet', 'Bag', 450, 500, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3800000-0000-0000-0000-000000000001', 'f3800000-0000-0000-0000-000000000001', 'RDB Shop', 'active', 'outlet');
SELECT set_config('test.uid', 'a3800000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the day shows what was posted and sold (the shop no longer sends back, 20261104130000)
DO $$
DECLARE f uuid := 'f3800000-0000-0000-0000-000000000001'; o uuid := 'c3800000-0000-0000-0000-000000000001';
  pk uuid := 'b3800000-0000-0000-0000-000000000001'; sc uuid := 'b3800000-0000-0000-0000-000000000002';
  t date := CURRENT_DATE;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', o,
    'items', jsonb_build_array(jsonb_build_object('product_id', pk, 'quantity', 20),
                               jsonb_build_object('product_id', sc, 'quantity', 5))));
  PERFORM public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', o,
    'items', jsonb_build_array(jsonb_build_object('product_id', pk, 'quantity', 6)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 10200, 'method', 'cash'))));

  PERFORM pg_temp.check((SELECT SUM(quantity) FROM public.retail_daily_book(o, t, t)
                          WHERE kind = 'posting' AND product_name = 'RDB 75cl') = 20, 'posted 20 packs');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM public.retail_daily_book(o, t, t)
                          WHERE kind = 'posting' AND product_name = 'RDB Sachet') = 5, 'posted 5 sachets');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM public.retail_daily_book(o, t, t) WHERE kind = 'sale') = 6
                    AND (SELECT SUM(line_total) FROM public.retail_daily_book(o, t, t) WHERE kind = 'sale') = 10200,
                        'sold 6 for 10,200');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.retail_daily_book(o, t, t) WHERE kind = 'return'), 'nothing sent back');
  PERFORM pg_temp.check((SELECT count(*) FROM public.retail_daily_book(o, t - 3, t - 1)) = 0, 'nothing on other days');
END $$;
