-- ============================================================================
-- Acceptance tests: rep_van_stock (20261030230000_rep_van_stock.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. An accountant (who can't read products
-- directly) gets a marketer's van stock with each product's name, unit and
-- price per pack; empty lines are left out; no rights is refused.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b1100000-0000-0000-0000-000000000001', 'acct@rvs'),
  ('b1100000-0000-0000-0000-000000000002', 'nobody@rvs');
DELETE FROM user_roles WHERE user_id IN ('b1100000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'b1100000-0000-0000-0000-000000000001', 'accountant', id FROM factories WHERE code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT x.id::uuid, f.id, x.name, 'Pack', 'finished', true, 0, x.price
  FROM factories f, (VALUES ('b1100000-0000-0000-0000-0000000000a1', 'RVS 75cl', 1700),
                            ('b1100000-0000-0000-0000-0000000000a2', 'RVS 50cl', 2650)) AS x(id, name, price)
 WHERE f.code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'b1100000-0000-0000-0000-0000000000b1', id, 'RVS Marketer', 'active', 'rep' FROM factories WHERE code = 'water';
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
SELECT 'b1100000-0000-0000-0000-0000000000b1', x.p::uuid, f.id, x.q
  FROM factories f, (VALUES ('b1100000-0000-0000-0000-0000000000a1', 40), ('b1100000-0000-0000-0000-0000000000a2', 0)) AS x(p, q)
 WHERE f.code = 'water';

-- @@ Test 1: an accountant sees names and price per pack; no rights is refused
DO $$
DECLARE got text; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'b1100000-0000-0000-0000-000000000001', false);
  got := (SELECT string_agg(concat_ws('/', name, unit, unit_price::int, quantity::int), ' ')
            FROM public.rep_van_stock('b1100000-0000-0000-0000-0000000000b1'));
  IF got IS DISTINCT FROM 'RVS 75cl/Pack/1700/40' THEN RAISE EXCEPTION 'ASSERTION FAILED: %', got; END IF;
  PERFORM set_config('test.uid', 'b1100000-0000-0000-0000-000000000002', false);
  BEGIN
    PERFORM * FROM public.rep_van_stock('b1100000-0000-0000-0000-0000000000b1');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  IF NOT ok THEN RAISE EXCEPTION 'ASSERTION FAILED: no rights not refused'; END IF;
END $$;
