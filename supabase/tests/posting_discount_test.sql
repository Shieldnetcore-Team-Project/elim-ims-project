-- ============================================================================
-- Acceptance tests: Accounts' discount per pack on postings
-- (20261103220000_posting_discount.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The Warehouse posts 10 packs at N1,700 to
-- the shop; Accounts give N100 off a pack.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f4400000-0000-0000-0000-000000000001', 'pdsfac', 'PDS Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a4400000-0000-0000-0000-000000000001', 'admin@pds'),
  ('a4400000-0000-0000-0000-000000000002', 'cashier@pds'),
  ('a4400000-0000-0000-0000-000000000003', 'accountant@pds');
DELETE FROM user_roles WHERE user_id IN ('a4400000-0000-0000-0000-000000000001', 'a4400000-0000-0000-0000-000000000002',
                                         'a4400000-0000-0000-0000-000000000003');
INSERT INTO user_roles(user_id, role) VALUES ('a4400000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a4400000-0000-0000-0000-000000000002', 'sales', 'f4400000-0000-0000-0000-000000000001'),
  ('a4400000-0000-0000-0000-000000000003', 'accountant', 'f4400000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b4400000-0000-0000-0000-000000000001', 'f4400000-0000-0000-0000-000000000001', 'PDS 75cl', 'Pack', 1700, 100, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c4400000-0000-0000-0000-000000000001', 'f4400000-0000-0000-0000-000000000001', 'PDS Shop', 'active', 'outlet');
SELECT set_config('test.uid', 'a4400000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: N100 off a pack: value 16,000, the posting reads N1,600 a pack; limits and rights
DO $$
DECLARE d jsonb; r jsonb; l record; ids uuid[]; p uuid := 'b4400000-0000-0000-0000-000000000001';
BEGIN
  d := public.create_stock_dispatch(jsonb_build_object('factory_id', 'f4400000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c4400000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 10))));
  ids := ARRAY[(d->>'id')::uuid];

  PERFORM set_config('test.uid', 'a4400000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.set_posting_discount(%L, %L, NULL)', ids,
    jsonb_build_array(jsonb_build_object('product_id', p, 'unit_price', 1700, 'unit_discount', 100)))) LIKE '%Insufficient%',
    'the shop cannot give itself a discount');

  PERFORM set_config('test.uid', 'a4400000-0000-0000-0000-000000000003', false);
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.set_posting_discount(%L, %L, NULL)', ids,
    jsonb_build_array(jsonb_build_object('product_id', p, 'unit_price', 1700, 'unit_discount', 1800)))) LIKE '%more than the price%',
    'not more than the price');
  SELECT * INTO l FROM public.posting_discount_lines(ids);
  PERFORM pg_temp.check(l.quantity = 10 AND l.unit_price = 1700 AND l.unit_discount = 0, 'lines to discount: ' || row_to_json(l)::text);
  r := public.set_posting_discount(ids, jsonb_build_array(jsonb_build_object('product_id', p, 'unit_price', 1700,
         'unit_discount', 100)), 'Bulk buyer');
  PERFORM pg_temp.check((r->>'before')::numeric = 17000 AND (r->>'after')::numeric = 16000, 'totals: ' || r::text);
  PERFORM pg_temp.check((SELECT total_value FROM stock_dispatches WHERE id = ids[1]) = 16000, 'the posting total follows');
  SELECT * INTO l FROM public.rep_posting_lines('dispatch', ids[1]);
  PERFORM pg_temp.check(l.unit_price = 1600 AND l.line_total = 16000, 'reads at 1,600 a pack: ' || row_to_json(l)::text);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'set_posting_discount' AND entity_id = ids[1]::text),
                        'audited');

  -- A price corrected later keeps the discount.
  PERFORM set_config('test.uid', 'a4400000-0000-0000-0000-000000000001', false);
  UPDATE products SET unit_price = 1800 WHERE id = p;
  PERFORM public.reprice_posted_lines(p, 'test');
  PERFORM pg_temp.check((SELECT line_value FROM stock_dispatch_items WHERE dispatch_id = ids[1]) = 10 * (1800 - 100),
                        'repriced with the discount kept');
END $$;
