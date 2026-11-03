-- ============================================================================
-- Acceptance tests: the Retail Shop's stock brought forward
-- (20261103230000_shop_stock_bbf.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The shop holds 34 sachet and 263
-- dispensers; the old system says 7 and 3, and 26 of a 50cl it has none of.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f4500000-0000-0000-0000-000000000001', 'bbffac', 'BBF Factory');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b4500000-0000-0000-0000-000000000001', 'f4500000-0000-0000-0000-000000000001', 'Sachet Water', 'Bag', 300, 0, 'finished'),
  ('b4500000-0000-0000-0000-000000000002', 'f4500000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 0, 'finished'),
  ('b4500000-0000-0000-0000-000000000003', 'f4500000-0000-0000-0000-000000000001', '50cl Bottle Water', 'Pack', 1500, 0, 'finished'),
  ('b4500000-0000-0000-0000-000000000004', 'f4500000-0000-0000-0000-000000000001', '35cl Bottle Water', 'Pack', 1300, 0, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c4500000-0000-0000-0000-000000000001', 'f4500000-0000-0000-0000-000000000001', 'BBF Shop', 'active', 'outlet');
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity) VALUES
  ('c4500000-0000-0000-0000-000000000001', 'b4500000-0000-0000-0000-000000000001', 'f4500000-0000-0000-0000-000000000001', 34),
  ('c4500000-0000-0000-0000-000000000001', 'b4500000-0000-0000-0000-000000000002', 'f4500000-0000-0000-0000-000000000001', 263),
  ('c4500000-0000-0000-0000-000000000001', 'b4500000-0000-0000-0000-000000000004', 'f4500000-0000-0000-0000-000000000001', 25);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: set to the figures, one adjustment each, listed only, a second run changes nothing
DO $$
DECLARE s uuid := 'c4500000-0000-0000-0000-000000000001'; r jsonb;
  lines jsonb := jsonb_build_array(jsonb_build_object('match', 'Sachet%', 'quantity', 7),
                                   jsonb_build_object('match', 'Dispenser Water%', 'quantity', 3),
                                   jsonb_build_object('match', '50cl%', 'quantity', 26));
BEGIN
  r := public._set_shop_stock_bbf(s, lines);
  PERFORM pg_temp.check(jsonb_array_length(r) = 3, 'three changed: ' || r::text);
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = s AND product_id = 'b4500000-0000-0000-0000-000000000001') = 7, 'sachet 7');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = s AND product_id = 'b4500000-0000-0000-0000-000000000002') = 3, 'dispenser 3');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = s AND product_id = 'b4500000-0000-0000-0000-000000000003') = 26, '50cl 26 (new row)');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = s AND product_id = 'b4500000-0000-0000-0000-000000000004') = 25, '35cl not listed, untouched');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM rep_stock_movements WHERE sales_rep_id = s AND movement_type = 'adjustment'
                          AND product_id = 'b4500000-0000-0000-0000-000000000002') = -260, 'dispenser ledger -260');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'shop_stock_bbf' AND entity_id = s::text), 'audited');

  r := public._set_shop_stock_bbf(s, lines);
  PERFORM pg_temp.check(jsonb_array_length(r) = 0, 'second run changes nothing: ' || r::text);

  -- The list is the whole shop: 35cl to 0.
  r := public._set_shop_stock_bbf(s, lines, true);
  PERFORM pg_temp.check(jsonb_array_length(r) = 1, 'only 35cl changes: ' || r::text);
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = s AND product_id = 'b4500000-0000-0000-0000-000000000004') = 0, '35cl 0');
  r := public._set_shop_stock_bbf(s, lines, true);
  PERFORM pg_temp.check(jsonb_array_length(r) = 0, 'second run changes nothing: ' || r::text);
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public._set_shop_stock_bbf(%L, %L)', s,
    jsonb_build_array(jsonb_build_object('match', '%Bottle%', 'quantity', 1)))) LIKE '%names 2 products%',
    'a pattern naming two products is refused');
END $$;
