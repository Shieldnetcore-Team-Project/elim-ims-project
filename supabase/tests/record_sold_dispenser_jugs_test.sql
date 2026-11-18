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
    jsonb_build_object('customer_id', c, 'quantity', 12))) LIKE '%only 11 dispenser jug%', 'no more than held');
END $$;

-- @@ Test 2: Dispenser Water supplied as a swap (no jug on the ledger, 20261118090000):
-- 20 supplied, 3 back unsold -> 17 can be sold; 10 sold -> 7 left; ledger never minus
DO $$
DECLARE r jsonb; f uuid := 'f9c00000-0000-0000-0000-000000000001'; c uuid := 'd9c00000-0000-0000-0000-000000000002';
        s jsonb; t uuid := 'e9c00000-0000-0000-0000-000000000001'; b numeric;
BEGIN
  INSERT INTO customers(id, factory_id, name, registered) VALUES (c, f, 'SJ High Commission', true);
  s := public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', c, 'customer_name', 'SJ High Commission',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b9c00000-0000-0000-0000-000000000001',
                                                  'quantity', 20, 'jar_mode', 'swap'))));
  IF (SELECT status FROM sales WHERE id = (s->>'sale_id')::uuid) <> 'posted' THEN
    PERFORM public._post_sale((s->>'sale_id')::uuid, 'test');
  END IF;
  PERFORM pg_temp.check(public._jug_customer_balance(c, t) = 0, 'swap leaves no jug on the ledger');
  INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned, unit, reason, received_by)
  VALUES (f, 'SR-SJ-1', (s->>'sale_id')::uuid, c, 'b9c00000-0000-0000-0000-000000000001', 3, 'Piece', 'unsold',
          'a9c00000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(public._customer_jugs_sellable(c) = 17, '17 sellable');
  b := public._jug_customer_balance(c, t);
  r := public.record_sold_dispenser_jugs(jsonb_build_object('customer_id', c, 'quantity', 10));
  PERFORM pg_temp.check((SELECT grand_total FROM sales WHERE invoice_number = r->>'invoice_number') = 30000,
                        'billed 10 x 3,000');
  PERFORM pg_temp.check(public._customer_jugs_sellable(c) = 7, '7 left');
  PERFORM pg_temp.check(public._jug_customer_balance(c, t) = b, 'ledger unchanged by the sold jugs');
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.record_sold_dispenser_jugs(%L)$q$,
    jsonb_build_object('customer_id', c, 'quantity', 8))) LIKE '%only 7 dispenser jug%', 'no more than 7');
END $$;

-- @@ Test 3: H MEDIX case (20261118100000) -- 50 swapped, 49 empties handed in -> 1 Jug + Water can be recorded
DO $$
DECLARE r jsonb; f uuid := 'f9c00000-0000-0000-0000-000000000001'; c uuid := 'd9c00000-0000-0000-0000-000000000003';
        s jsonb; t uuid := 'e9c00000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO customers(id, factory_id, name, registered) VALUES (c, f, 'SJ Medix', true);
  s := public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', c, 'customer_name', 'SJ Medix',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b9c00000-0000-0000-0000-000000000001',
                                                  'quantity', 50, 'jar_mode', 'swap'))));
  IF (SELECT status FROM sales WHERE id = (s->>'sale_id')::uuid) <> 'posted' THEN
    PERFORM public._post_sale((s->>'sale_id')::uuid, 'test');
  END IF;
  -- 49 empties handed in (plus 30 older jugs from before tracking) on the jug ledger
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, quantity, source)
  VALUES (f, t, 'customer', c, 'warehouse', 79, 'return');
  r := public.record_sold_dispenser_jugs(jsonb_build_object('customer_id', c, 'quantity', 1));
  PERFORM pg_temp.check((SELECT grand_total FROM sales WHERE invoice_number = r->>'invoice_number') = 3000,
                        '1 jug billed');
END $$;
