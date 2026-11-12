-- ============================================================================
-- Acceptance tests: 20261112130000_marketer_dispenser_breakdown.sql
--   100 Dispenser Water posted to a marketer; 80 empties come back through
--   QC: Accounts sees 20 Jug + Water sold (N4,200) and 80 Dispenser Water
--   (N1,200), and the balance is the same 180,000 (user, 2026-11-12).
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7700000-0000-0000-0000-000000000001', 'mdbfac', 'MDB Factory');
INSERT INTO auth.users(id, email) VALUES ('a7700000-0000-0000-0000-000000000001', 'admin@mdb');
INSERT INTO user_roles(user_id, role) VALUES ('a7700000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'MDB Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 500, 'finished'),
  ('b7700000-0000-0000-0000-000000000002', 'f7700000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 3000, 0, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b7700000-0000-0000-0000-000000000001', 'e7700000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b7700000-0000-0000-0000-000000000002', 'e7700000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'MDB Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a7700000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: 100 posted, all sold, 80 empties back -> 20 Jug + Water, 80 Dispenser Water
DO $$
DECLARE f uuid := 'f7700000-0000-0000-0000-000000000001'; m uuid := 'c7700000-0000-0000-0000-000000000001';
  w uuid := 'b7700000-0000-0000-0000-000000000001'; b jsonb; s jsonb;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 100))));
  -- The marketer sold all 100 (off the van).
  UPDATE rep_stock SET quantity = 0 WHERE sales_rep_id = m AND product_id = w;
  -- QC takes in 80 empties from them.
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity, source, reference)
  VALUES (f, 'e7700000-0000-0000-0000-000000000001', 'sales_rep', m, 'qc', NULL, 80, 'return', 'JRQ-T1');

  b := public.rep_dispenser_breakdown(m);
  PERFORM pg_temp.check((b->>'posted')::numeric = 100 AND (b->>'sold')::numeric = 100 AND (b->>'on_van')::numeric = 0,
                        'posted/sold: ' || b::text);
  PERFORM pg_temp.check((b->>'jug_water_sold')::numeric = 20, 'Jug + Water sold 20: ' || b::text);
  PERFORM pg_temp.check((b->>'water_sold')::numeric = 80, 'Dispenser Water sold 80: ' || b::text);
  PERFORM pg_temp.check((b->>'jug_water_price')::numeric = 4200 AND (b->>'water_price')::numeric = 1200,
                        'prices: ' || b::text);
  -- The balance is the same money: 20 x 4,200 + 80 x 1,200.
  s := public.rep_account_summary(m);
  PERFORM pg_temp.check((s->>'net_balance_owed')::numeric = 20 * 4200 + 80 * 1200,
                        'balance ' || (s->>'net_balance_owed') || ' = 180,000');
END $$;

-- @@ Test 2: 10 still on the van are not counted as sold
DO $$
DECLARE m uuid := 'c7700000-0000-0000-0000-000000000001'; w uuid := 'b7700000-0000-0000-0000-000000000001'; b jsonb;
BEGIN
  UPDATE rep_stock SET quantity = 10 WHERE sales_rep_id = m AND product_id = w;
  b := public.rep_dispenser_breakdown(m);
  PERFORM pg_temp.check((b->>'on_van')::numeric = 10 AND (b->>'sold')::numeric = 90, 'on van: ' || b::text);
  PERFORM pg_temp.check((b->>'jug_water_sold')::numeric = 10 AND (b->>'water_sold')::numeric = 80, 'split: ' || b::text);
  UPDATE rep_stock SET quantity = 0 WHERE sales_rep_id = m AND product_id = w;
END $$;
