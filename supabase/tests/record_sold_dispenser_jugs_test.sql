-- ============================================================================
-- Acceptance tests: Record sold Dispenser + Water
-- (20261104230000_record_sold_dispenser_jugs.sql). Runs as an admin.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9c00000-0000-0000-0000-000000000001', 'sjfac', 'SJ Factory');
INSERT INTO auth.users(id, email) VALUES ('a9c00000-0000-0000-0000-000000000001', 'admin@sj');
DELETE FROM user_roles WHERE user_id = 'a9c00000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a9c00000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e9c00000-0000-0000-0000-000000000001', 'f9c00000-0000-0000-0000-000000000001', 'New Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b9c00000-0000-0000-0000-000000000001', 'f9c00000-0000-0000-0000-000000000001', 'SJ Dispenser Water', 'Piece', 1200, 100, 'finished'),
  ('b9c00000-0000-0000-0000-000000000002', 'f9c00000-0000-0000-0000-000000000001', 'SJ Dispenser Empty', 'Piece', 3000, 0, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b9c00000-0000-0000-0000-000000000001', 'e9c00000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b9c00000-0000-0000-0000-000000000002', 'e9c00000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d9c00000-0000-0000-0000-000000000001', 'f9c00000-0000-0000-0000-000000000001', 'SJ Yemi', true);
SELECT set_config('test.uid', 'a9c00000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: 15 dispensers posted; 4 sold on with the jug -> billed 12,000, jugs held 11, stock unchanged
DO $$
DECLARE r jsonb; f uuid := 'f9c00000-0000-0000-0000-000000000001'; c uuid := 'd9c00000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', c, 'customer_name', 'SJ Yemi',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b9c00000-0000-0000-0000-000000000001', 'quantity', 15))));
  PERFORM pg_temp.check(public._jug_customer_balance(c, 'e9c00000-0000-0000-0000-000000000001') = 15, 'holds 15 jugs');
  r := public.record_sold_dispenser_jugs(jsonb_build_object('customer_id', c, 'quantity', 4));
  PERFORM pg_temp.check((SELECT grand_total FROM sales WHERE invoice_number = r->>'invoice_number') = 12000
                        AND (SELECT status FROM sales WHERE invoice_number = r->>'invoice_number') = 'posted',
                        'invoice 12,000 posted');
  PERFORM pg_temp.check(public._jug_customer_balance(c, 'e9c00000-0000-0000-0000-000000000001') = 11, 'holds 11 now');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b9c00000-0000-0000-0000-000000000002') = 0,
                        'Dispenser Empty stock unchanged');
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.record_sold_dispenser_jugs(%L)$q$,
    jsonb_build_object('customer_id', c, 'quantity', 12))) LIKE '%holds only 11%', 'no more than held');
END $$;
