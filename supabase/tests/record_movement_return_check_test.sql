-- ============================================================================
-- Acceptance tests: Record movement "Empties returned" limit
-- (20261110110000_record_movement_return_check.sql)
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9900000-0000-0000-0000-000000000001', 'rcfac', 'RC Factory');
INSERT INTO auth.users(id, email) VALUES ('a9900000-0000-0000-0000-000000000001', 'admin@rc');
DELETE FROM user_roles WHERE user_id = 'a9900000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a9900000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'Old Dispenser Jug'),
  ('e9900000-0000-0000-0000-000000000002', 'f9900000-0000-0000-0000-000000000001', 'New Dispenser Jug'),
  ('e9900000-0000-0000-0000-000000000003', 'f9900000-0000-0000-0000-000000000001', 'Crate');
INSERT INTO products(id, factory_id, name, unit, unit_price, product_type) VALUES
  ('d9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'RC Dispenser Water', 'Piece', 1200, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('d9900000-0000-0000-0000-000000000001', 'e9900000-0000-0000-0000-000000000002', 1, 'with_water');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'RC Marketer', 'active', 'rep');
INSERT INTO customers(id, factory_id, name) VALUES
  ('b9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'RC Customer');
SELECT set_config('test.uid', 'a9900000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
-- 'issue' or 'return' of p_q for a holder; the error text, or NULL if it saved.
CREATE OR REPLACE FUNCTION pg_temp.mv(p_kind text, p_ht text, p_hid uuid, p_type int, p_q numeric) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.err(format('SELECT public.record_container_movement(%L)', jsonb_build_object(
    'factory_id', 'f9900000-0000-0000-0000-000000000001',
    'container_type_id', 'e9900000-0000-0000-0000-00000000000' || p_type,
    'kind', p_kind, 'holder_type', p_ht, 'holder_id', p_hid, 'quantity', p_q)));
$$;

-- @@ Test 1: never more back than held; Old + New as one; pending, full stock, other containers, walk-in
DO $$
DECLARE
  c uuid := 'b9900000-0000-0000-0000-000000000001';
  r uuid := 'c9900000-0000-0000-0000-000000000001';
BEGIN
  -- Nothing held: refused, naming the person and pointing at the fix.
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 1) LIKE 'RC Customer can return at most 0%opening balance%', 'nothing held is refused');
  PERFORM pg_temp.check((SELECT count(*) FROM container_movements WHERE from_id = c) = 0, 'a refusal writes nothing');

  -- Holds 10 New: 11 refused, 10 fine, and back to nothing.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 10) IS NULL, 'opening issue saves');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 11) LIKE '%at most 10%', 'more than held is refused');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 10) IS NULL, 'exactly what is held saves');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 1) LIKE '%at most 0%', 'then nothing left');

  -- Old and New count as one: holds 6 New, can bring back Old.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 6) IS NULL, 'issue 6 New');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 1, 6) IS NULL, 'Old returned against New held');

  -- A crate is its own figure; no jugs count towards it.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 3) IS NULL, 'issue 3 New');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 3, 1) LIKE '%at most 0%', 'jugs do not count for crates');

  -- A return waiting for QC is already spoken for.
  INSERT INTO jug_returns(factory_id, reference, customer_id, container_type_id, quantity_claimed, recorded_by)
  VALUES ('f9900000-0000-0000-0000-000000000001', 'JR-RC-1', c, 'e9900000-0000-0000-0000-000000000002', 2,
          'a9900000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 2) LIKE '%at most 1%', 'pending return counted');

  -- A marketer's full dispensers aren't empties.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'sales_rep', r, 2, 5) IS NULL, 'issue 5 to marketer');
  INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
  VALUES (r, 'd9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 3);
  PERFORM pg_temp.check(pg_temp.mv('return', 'sales_rep', r, 2, 3) LIKE 'RC Marketer can return at most 2%', 'full stock not returnable as empties');
  PERFORM pg_temp.check(pg_temp.mv('return', 'sales_rep', r, 2, 2) IS NULL, 'the empties save');

  -- Walk-in has no per-person figure.
  PERFORM pg_temp.check(pg_temp.mv('return', 'walk_in', NULL, 2, 4) IS NULL, 'walk-in not limited');
END $$;
