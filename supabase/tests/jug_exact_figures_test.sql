-- ============================================================================
-- Acceptance tests: exact jug figures (20261104140000_jug_exact_figures.sql)
-- The Warehouse comes from its dispenser stock; nobody shows below 0.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9600000-0000-0000-0000-000000000001', 'jxfac', 'JX Factory');
INSERT INTO auth.users(id, email) VALUES ('a9600000-0000-0000-0000-000000000001', 'admin@jx');
DELETE FROM user_roles WHERE user_id = 'a9600000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a9600000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e9600000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000001', 'New Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b9600000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000001', 'JX Dispenser Water', 'Piece', 1200, 40),
  ('b9600000-0000-0000-0000-000000000002', 'f9600000-0000-0000-0000-000000000001', 'JX Dispenser Empty', 'Piece', 3000, 7);
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit) VALUES
  ('b9600000-0000-0000-0000-000000000001', 'e9600000-0000-0000-0000-000000000001', 1),
  ('b9600000-0000-0000-0000-000000000002', 'e9600000-0000-0000-0000-000000000001', 1);
INSERT INTO customers(id, factory_id, name) VALUES
  ('d9600000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000001', 'JX Buyer');
SELECT set_config('test.uid', 'a9600000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: Warehouse = jugs in stock (40 filled + 7 empty); a customer below 0 shows 0
DO $$
DECLARE r record; f uuid := 'f9600000-0000-0000-0000-000000000001'; t uuid := 'e9600000-0000-0000-0000-000000000001';
BEGIN
  -- Ledger out of step: 30 out of the Warehouse to nowhere, 5 back from a customer it never had.
  INSERT INTO container_movements(factory_id, container_type_id, from_type, to_type, quantity, source)
  VALUES (f, t, 'warehouse', 'external', 30, 'lost');
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, quantity, source)
  VALUES (f, t, 'customer', 'd9600000-0000-0000-0000-000000000001', 'warehouse', 5, 'return');
  SELECT * INTO r FROM public.jug_places_now(f);
  PERFORM pg_temp.check(r.warehouse = 47, 'warehouse from stock: ' || r.warehouse);
  PERFORM pg_temp.check(r.customers = 0, 'customer never below 0: ' || r.customers);
  SELECT * INTO r FROM public.jug_locations(f, (now() AT TIME ZONE 'Africa/Lagos')::date);
  PERFORM pg_temp.check(r.warehouse = 47 AND r.customers = 0, 'report agrees');
  UPDATE products SET current_stock = 10 WHERE id = 'b9600000-0000-0000-0000-000000000001';
  SELECT * INTO r FROM public.jug_places_now(f);
  PERFORM pg_temp.check(r.warehouse = 17, 'follows the stock: ' || r.warehouse);
END $$;
