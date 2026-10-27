-- ============================================================================
-- Acceptance tests: empty bottles never go out on a posting or sale
-- (20261027210000_no_empty_bottles_in_postings.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration's Malla clean-up already
-- ran (on no data); test 2 builds such a posting and runs the same steps
-- through reverse_stock_dispatch, which the clean-up mirrors.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f2000000-0000-0000-0000-000000000001', 'noempty', 'No Empty Factory');
INSERT INTO auth.users(id, email) VALUES ('a2000000-0000-0000-0000-000000000001', 'admin@noempty');
DELETE FROM user_roles WHERE user_id = 'a2000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a2000000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b2000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'NE 50cl Bottle Water', 'Pack', 1000, 100, 'finished'),
  ('b2000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'NE 50cl Bottle', 'Piece', 0, 5000, 'semi_finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c2000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'NE Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a2000000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: Bottle Water posts; an empty bottle is refused
DO $$
DECLARE ok boolean := false;
  f uuid := 'f2000000-0000-0000-0000-000000000001'; r uuid := 'c2000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b2000000-0000-0000-0000-000000000001', 'quantity', 10))));
  BEGIN
    PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
      'items', jsonb_build_array(jsonb_build_object('product_id', 'b2000000-0000-0000-0000-000000000002', 'quantity', 497))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%empty bottle%';
  END;
  PERFORM pg_temp.check(ok, 'empty bottle refused');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b2000000-0000-0000-0000-000000000002') = 5000,
                        'empty bottle stock untouched');
END $$;
