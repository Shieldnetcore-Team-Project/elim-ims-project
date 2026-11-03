-- ============================================================================
-- Acceptance tests: rule A -- marketers' dispensers at N1,200, a jug not
-- returned owed (20261103210000_marketers_like_shop.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Dispenser Water N1,200, Dispenser Empty
-- N3,000 (the jug). A marketer is posted 10, sells 6 water only (customers
-- swap empties), returns 2 unsold and brings the 6 empties, which QC counts.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f4300000-0000-0000-0000-000000000001', 'rlafac', 'RLA Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a4300000-0000-0000-0000-000000000001', 'admin@rla'),
  ('a4300000-0000-0000-0000-000000000002', 'qc@rla');
INSERT INTO user_roles(user_id, role) VALUES
  ('a4300000-0000-0000-0000-000000000001', 'super_admin'),
  ('a4300000-0000-0000-0000-000000000002', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e4300000-0000-0000-0000-000000000001', 'f4300000-0000-0000-0000-000000000001', 'RLA Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b4300000-0000-0000-0000-000000000001', 'f4300000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 100, 'finished'),
  ('b4300000-0000-0000-0000-000000000002', 'f4300000-0000-0000-0000-000000000001', 'Dispenser Empty', 'pieces', 3000, 0, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b4300000-0000-0000-0000-000000000001', 'e4300000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b4300000-0000-0000-0000-000000000002', 'e4300000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c4300000-0000-0000-0000-000000000001', 'f4300000-0000-0000-0000-000000000001', 'RLA Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a4300000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: posted at 1,200; empties clear the jug without money; the balance charges the jugs still out
DO $$
DECLARE s jsonb; j jsonb; f uuid := 'f4300000-0000-0000-0000-000000000001'; m uuid := 'c4300000-0000-0000-0000-000000000001';
  w uuid := 'b4300000-0000-0000-0000-000000000001'; t uuid := 'e4300000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 10))));
  PERFORM pg_temp.check((SELECT SUM(line_value) FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
                          WHERE d.sales_rep_id = m) = 12000, 'posted at 1,200 each, not water + jug');
  -- 6 sold as water only: customers handed their empties to the marketer.
  -- (A marketer's sale waits for approval; posted here directly.)
  s := public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 6, 'jar_mode', 'swap'))));
  PERFORM public._post_sale((s->>'sale_id')::uuid, 'test');
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity_returned', 2))));
  j := public.record_jug_return(jsonb_build_object('sales_rep_id', m, 'container_type_id', t, 'quantity', 6));
  PERFORM set_config('test.uid', 'a4300000-0000-0000-0000-000000000002', false);
  PERFORM public.verify_jug_return((j->>'id')::uuid, 6, NULL);
  PERFORM set_config('test.uid', 'a4300000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check((SELECT credit_price FROM jug_returns WHERE id = (j->>'id')::uuid) IS NULL, 'no money credit for empties');

  s := public.rep_account_summary(m);
  PERFORM pg_temp.check((s->>'goods_out_value')::numeric = 12000, 'goods out 12,000: ' || s::text);
  PERFORM pg_temp.check((s->>'jugs_owed')::numeric = 2 AND (s->>'jugs_owed_value')::numeric = 6000,
                        '2 jugs still out (full on the van) x 3,000: ' || s::text);
  -- Goods out 12,000 - unsold back 2,400 + jugs still out 6,000 - the 6
  -- sold on credit (owed by customers, 7,200) = 8,400.
  PERFORM pg_temp.check((s->>'net_balance_owed')::numeric = 12000 - 2400 + 6000 - 7200, 'balance 8,400: ' || s::text);
END $$;
