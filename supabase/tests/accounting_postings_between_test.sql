-- ============================================================================
-- Acceptance tests: accounting_postings_between
-- (20261103130000_accounting_postings_between.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3700000-0000-0000-0000-000000000001', 'apbfac', 'APB Factory');
INSERT INTO auth.users(id, email) VALUES ('a3700000-0000-0000-0000-000000000001', 'admin@apb');
INSERT INTO user_roles(user_id, role) VALUES ('a3700000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3700000-0000-0000-0000-000000000001', 'f3700000-0000-0000-0000-000000000001', 'APB 75cl', 'Pack', 300, 500, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3700000-0000-0000-0000-000000000001', 'f3700000-0000-0000-0000-000000000001', 'APB Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a3700000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: a posting shows on its own day and not on another; a bad range is refused
DO $$
DECLARE f uuid := 'f3700000-0000-0000-0000-000000000001'; t date := public._lagos_today(); ok boolean := false;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f,
    'sales_rep_id', 'c3700000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3700000-0000-0000-0000-000000000001', 'quantity', 7))));
  PERFORM pg_temp.check((SELECT count(*) FROM public.accounting_postings_between(f, t, t)) = 1, 'today: 1');
  PERFORM pg_temp.check((SELECT count(*) FROM public.accounting_postings_between(f, t - 5, t - 1)) = 0, 'earlier days: none');
  PERFORM pg_temp.check((SELECT items FROM public.accounting_postings_between(f, t, t)) LIKE 'APB 75cl × 7%', 'its products');
  BEGIN
    PERFORM public.accounting_postings_between(f, t, t - 1);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%valid date range%';
  END;
  PERFORM pg_temp.check(ok, 'end before start refused');
END $$;
