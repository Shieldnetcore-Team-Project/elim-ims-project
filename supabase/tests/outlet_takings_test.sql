-- ============================================================================
-- Acceptance tests: outlet_takings (20261103200000_outlet_takings.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The shop sells 3 packs: 2 paid cash, 1 by
-- POS.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f4200000-0000-0000-0000-000000000001', 'otkfac', 'OTK Factory');
INSERT INTO auth.users(id, email) VALUES ('a4200000-0000-0000-0000-000000000001', 'admin@otk');
INSERT INTO user_roles(user_id, role) VALUES ('a4200000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b4200000-0000-0000-0000-000000000001', 'f4200000-0000-0000-0000-000000000001', 'OTK 75cl', 'Pack', 1700, 100, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c4200000-0000-0000-0000-000000000001', 'f4200000-0000-0000-0000-000000000001', 'OTK Shop', 'active', 'outlet');
SELECT set_config('test.uid', 'a4200000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: cash and POS apart
DO $$
DECLARE f uuid := 'f4200000-0000-0000-0000-000000000001'; o uuid := 'c4200000-0000-0000-0000-000000000001';
  p uuid := 'b4200000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', o,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 10))));
  PERFORM public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', o,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 2)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 3400, 'method', 'cash'))));
  PERFORM public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', o,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 1)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 1700, 'method', 'pos'))));
  PERFORM pg_temp.check((SELECT amount FROM public.outlet_takings(o, CURRENT_DATE, CURRENT_DATE) WHERE payment_method = 'cash') = 3400,
                        'cash 3,400');
  PERFORM pg_temp.check((SELECT amount FROM public.outlet_takings(o, CURRENT_DATE, CURRENT_DATE) WHERE payment_method = 'pos') = 1700,
                        'POS 1,700');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.outlet_takings(o, CURRENT_DATE - 3, CURRENT_DATE - 1)), 'nothing on other days');
END $$;
