-- ============================================================================
-- Acceptance tests: jugs follow Store -> QC -> Production -> Warehouse
-- (20261104120000_jug_route_store_qc_production.sql). Runs as an admin.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9500000-0000-0000-0000-000000000001', 'jrfac', 'JR Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a9500000-0000-0000-0000-000000000001', 'admin@jr'),
  ('a9500000-0000-0000-0000-000000000002', 'admin2@jr');
INSERT INTO user_roles(user_id, role) VALUES
  ('a9500000-0000-0000-0000-000000000001', 'super_admin'),
  ('a9500000-0000-0000-0000-000000000002', 'super_admin');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e9500000-0000-0000-0000-000000000001', 'f9500000-0000-0000-0000-000000000001', 'New Jug'),
  ('e9500000-0000-0000-0000-000000000002', 'f9500000-0000-0000-0000-000000000001', 'Old Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b9500000-0000-0000-0000-000000000001', 'f9500000-0000-0000-0000-000000000001', 'JR Dispenser Water', 'Piece', 1200, 0);
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit) VALUES
  ('b9500000-0000-0000-0000-000000000001', 'e9500000-0000-0000-0000-000000000001', 1);
SELECT set_config('test.uid', 'a9500000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.at(p text) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(CASE WHEN to_type = p THEN quantity ELSE -quantity END), 0) FROM container_movements
   WHERE container_type_id = 'e9500000-0000-0000-0000-000000000001' AND (to_type = p OR from_type = p) $$;

-- @@ Test 1: bought in -> Store; Store -> QC -> verified -> PM
DO $$
DECLARE b jsonb; f uuid := 'f9500000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.receive_new_jugs(f, 'e9500000-0000-0000-0000-000000000001', 100, 'DN-1', NULL);
  PERFORM pg_temp.check(pg_temp.at('store') = 100, 'store 100: ' || pg_temp.at('store'));
  b := public.send_jugs_to_qc(jsonb_build_object('factory_id', f, 'jug_kind', 'new', 'quantity', 60));
  PERFORM pg_temp.check(pg_temp.at('store') = 100, 'nothing moves until QC accepts');
  PERFORM set_config('test.uid', 'a9500000-0000-0000-0000-000000000002', false);
  PERFORM public.accept_qc_jugs((b->>'id')::uuid, 60, NULL);
  PERFORM pg_temp.check(pg_temp.at('store') = 40 AND pg_temp.at('qc') = 60, 'store 40, qc 60');
  PERFORM public.verify_qc_jugs((b->>'id')::uuid, 55, 5, 'cracked');
  PERFORM pg_temp.check(pg_temp.at('qc') = 55, 'damaged written off: ' || pg_temp.at('qc'));
  PERFORM set_config('test.uid', 'a9500000-0000-0000-0000-000000000001', false);
  PERFORM public.receive_qc_jugs((b->>'id')::uuid, NULL);
  PERFORM pg_temp.check(pg_temp.at('qc') = 0 AND pg_temp.at('production') = 55, 'good to production');
END $$;

-- @@ Test 2: Store issues straight to Production; a count corrects a place
DO $$
DECLARE f uuid := 'f9500000-0000-0000-0000-000000000001'; r jsonb;
BEGIN
  PERFORM public.send_jugs_to_production(jsonb_build_object('factory_id', f, 'jug_kind', 'new', 'quantity', 10));
  PERFORM pg_temp.check(pg_temp.at('store') = 30 AND pg_temp.at('production') = 65, 'store 30, production 65');
  r := public.set_jug_count(f, 'e9500000-0000-0000-0000-000000000001', 'warehouse', 12, 'opening count');
  PERFORM pg_temp.check(pg_temp.at('warehouse') = 12 AND (r->>'change')::numeric = 12, 'warehouse counted 12');
  -- The report's Warehouse comes from dispenser stock (20261104140000); the
  -- other places from the ledger.
  PERFORM pg_temp.check((SELECT production FROM public.jug_locations(f, CURRENT_DATE)
                          WHERE container_name = 'New Jug') = 65, 'jug_locations agrees');
END $$;

-- @@ Test 3: an accepted dispenser release brings its jugs into the Warehouse; reversal takes them back
DO $$
DECLARE f uuid := 'f9500000-0000-0000-0000-000000000001'; rid uuid := gen_random_uuid();
BEGIN
  INSERT INTO production_releases(id, factory_id, release_number, product_id, quantity, unit, status)
  VALUES (rid, f, 'REL-JR-1', 'b9500000-0000-0000-0000-000000000001', 20, 'Piece', 'pending');
  UPDATE production_releases SET status = 'accepted', accepted_quantity = 20 WHERE id = rid;
  PERFORM pg_temp.check(pg_temp.at('warehouse') = 32 AND pg_temp.at('production') = 45, 'production -> warehouse 20');
  UPDATE production_releases SET status = 'reversed' WHERE id = rid;
  PERFORM pg_temp.check(pg_temp.at('warehouse') = 12 AND pg_temp.at('production') = 65, 'reversal moves them back');
END $$;
