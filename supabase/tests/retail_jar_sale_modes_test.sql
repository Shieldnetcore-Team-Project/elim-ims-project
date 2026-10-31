-- ============================================================================
-- Acceptance tests: retail shop dispenser jars
-- (20261031160000_retail_jar_sale_modes.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The brief's example: the Warehouse posts
-- 20 filled dispensers to the shop; the shop sells 15 with the empty to come
-- back, 1 with the jar bought for good, and gets 4 empties back -> 4 filled
-- left, 11 owed; one more empty -> 10 owed.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3200000-0000-0000-0000-000000000001', 'jarfac', 'Jar Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a3200000-0000-0000-0000-000000000001', 'cashier@jar'),
  ('a3200000-0000-0000-0000-000000000002', 'manager@jar');
DELETE FROM user_roles WHERE user_id IN ('a3200000-0000-0000-0000-000000000001', 'a3200000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES
  ('a3200000-0000-0000-0000-000000000001', 'super_admin'),
  ('a3200000-0000-0000-0000-000000000002', 'super_admin');
INSERT INTO container_types(id, factory_id, name, jar_price, with_jar_price) VALUES
  ('e3200000-0000-0000-0000-000000000001', 'f3200000-0000-0000-0000-000000000001', 'JT New Jug', 3000, 4200);
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3200000-0000-0000-0000-000000000001', 'f3200000-0000-0000-0000-000000000001', 'JT Dispenser Water', 'Piece', 1200, 20, 'finished'),
  ('b3200000-0000-0000-0000-000000000002', 'f3200000-0000-0000-0000-000000000001', 'JT Sachet', 'Bag', 300, 100, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b3200000-0000-0000-0000-000000000001', 'e3200000-0000-0000-0000-000000000001', 1, 'with_water');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3200000-0000-0000-0000-000000000001', 'f3200000-0000-0000-0000-000000000001', 'JT Shop', 'active', 'outlet');
SELECT set_config('test.uid', 'a3200000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.summary() RETURNS SETOF record LANGUAGE sql AS $$
  SELECT * FROM public.shop_jar_summary('c3200000-0000-0000-0000-000000000001', CURRENT_DATE, CURRENT_DATE)
$$;
CREATE OR REPLACE FUNCTION pg_temp.sale(p_items jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.create_sale(jsonb_build_object('factory_id', 'f3200000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3200000-0000-0000-0000-000000000001', 'items', p_items, 'amount_paid', 0))
$$;
CREATE OR REPLACE FUNCTION pg_temp.owed() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(outstanding), 0) FROM public.shop_jar_obligations('c3200000-0000-0000-0000-000000000001', NULL)
$$;
CREATE OR REPLACE FUNCTION pg_temp.ret(p_sale uuid, p_good int, p_damaged int, p_ref text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.record_customer_jar_return(jsonb_build_object('outlet_id', 'c3200000-0000-0000-0000-000000000001',
    'container_type_id', 'e3200000-0000-0000-0000-000000000001', 'sale_id', p_sale,
    'quantity_good', p_good, 'quantity_damaged', p_damaged, 'client_ref', p_ref))
$$;

-- @@ Test 1: 20 posted to the shop; a jug line needs a jar choice; prices from the jug type
DO $$
DECLARE ok boolean := false; v jsonb;
  f uuid := 'f3200000-0000-0000-0000-000000000001'; r uuid := 'c3200000-0000-0000-0000-000000000001';
  p uuid := 'b3200000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 20))));
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = r AND product_id = p) = 20, 'shop has 20 filled');
  BEGIN
    PERFORM pg_temp.sale(jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 1)));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Choose Swap, Return later or Permanent%';
  END;
  PERFORM pg_temp.check(ok, 'jar choice required');
  ok := false;
  BEGIN
    PERFORM pg_temp.sale(jsonb_build_array(jsonb_build_object('product_id', 'b3200000-0000-0000-0000-000000000002',
      'quantity', 1, 'jar_mode', 'swap')));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%does not come in a jug%';
  END;
  PERFORM pg_temp.check(ok, 'no jar choice on a non-jug product');
END $$;

-- @@ Test 2: 15 return-later, 1 permanent (priced N4,200 whatever the screen sent), 4 back -> 4 filled, 11 owed
DO $$
DECLARE v jsonb; perm jsonb; s record;
  r uuid := 'c3200000-0000-0000-0000-000000000001'; p uuid := 'b3200000-0000-0000-0000-000000000001';
BEGIN
  v := pg_temp.sale(jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 15, 'jar_mode', 'return_later')));
  perm := pg_temp.sale(jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 1, 'unit_price', 1,
                                                            'jar_mode', 'permanent')));
  PERFORM pg_temp.check((perm->>'grand_total')::numeric = 4200, 'permanent = 4200: ' || (perm->>'grand_total'));
  PERFORM pg_temp.check((SELECT jar_unit_price FROM sale_items WHERE sale_id = (perm->>'sale_id')::uuid) = 3000,
                        'jar part 3000');
  PERFORM pg_temp.check((v->>'grand_total')::numeric = 15 * 1200, 'return-later charges water only');
  PERFORM pg_temp.check(pg_temp.owed() = 15, 'owed 15 after the sale: ' || pg_temp.owed());
  PERFORM pg_temp.ret((v->>'sale_id')::uuid, 4, 0, 'jar-t2-a');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = r AND product_id = p) = 4, 'filled 20-15-1 = 4');
  PERFORM pg_temp.check(pg_temp.owed() = 11, 'owed 15-4 = 11: ' || pg_temp.owed());
  SELECT * INTO s FROM public.shop_jar_summary(r, CURRENT_DATE, CURRENT_DATE);
  PERFORM pg_temp.check(s.filled_on_hand = 4 AND s.empties_at_shop = 4 AND s.owed_by_customers = 11
                        AND s.filled_received = 20 AND s.sold_return_later = 15 AND s.sold_permanent = 1
                        AND s.returned_good = 4, 'summary: ' || row_to_json(s)::text);
END $$;

-- @@ Test 3: one more back -> 10; a resubmit doesn't post twice; damaged counted apart
DO $$
DECLARE v1 jsonb; v2 jsonb; s record; sale uuid;
  r uuid := 'c3200000-0000-0000-0000-000000000001';
BEGIN
  sale := (SELECT sale_id FROM public.shop_jar_obligations(r, NULL) LIMIT 1);
  v1 := pg_temp.ret(sale, 0, 1, 'jar-t3-a');
  v2 := pg_temp.ret(sale, 0, 1, 'jar-t3-a');
  PERFORM pg_temp.check((v2->>'duplicate')::boolean AND v1->>'id' = v2->>'id', 'resubmit returns the first');
  PERFORM pg_temp.check(pg_temp.owed() = 10, 'owed 10: ' || pg_temp.owed());
  SELECT * INTO s FROM public.shop_jar_summary(r, CURRENT_DATE, CURRENT_DATE);
  PERFORM pg_temp.check(s.returned_good = 4 AND s.returned_damaged = 1 AND s.empties_at_shop = 5,
                        'summary: ' || row_to_json(s)::text);
END $$;

-- @@ Test 4: more back than owed -> the rest waits; the recorder can't approve it; a manager can
DO $$
DECLARE v jsonb; ok boolean := false; jr uuid;
  r uuid := 'c3200000-0000-0000-0000-000000000001';
  sale uuid := (SELECT sale_id FROM public.shop_jar_obligations('c3200000-0000-0000-0000-000000000001', NULL) LIMIT 1);
BEGIN
  v := pg_temp.ret(sale, 12, 0, 'jar-t4-a');
  PERFORM pg_temp.check((v->>'applied')::int = 10 AND (v->>'excess')::int = 2, 'applied 10, excess 2: ' || v::text);
  PERFORM pg_temp.check(pg_temp.owed() = 0, 'nothing owed');
  jr := (v->>'id')::uuid;
  PERFORM pg_temp.check((SELECT empties_at_shop FROM public.shop_jar_summary(r, CURRENT_DATE, CURRENT_DATE)) = 15,
                        'excess not in the shop yet');
  BEGIN
    PERFORM public.decide_jar_return_excess(jr, true, 'mine');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Someone other than%';
  END;
  PERFORM pg_temp.check(ok, 'recorder cannot approve');
  PERFORM set_config('test.uid', 'a3200000-0000-0000-0000-000000000002', false);
  PERFORM public.decide_jar_return_excess(jr, true, 'Old customer, counted');
  PERFORM set_config('test.uid', 'a3200000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check((SELECT empties_at_shop FROM public.shop_jar_summary(r, CURRENT_DATE, CURRENT_DATE)) = 17,
                        'approved excess in the shop');
END $$;

-- @@ Test 5: empties to the Warehouse -- sent 10, Warehouse counts 9; the 1 stays on the shop
DO $$
DECLARE v jsonb; s record; o record;
  f uuid := 'f3200000-0000-0000-0000-000000000001'; r uuid := 'c3200000-0000-0000-0000-000000000001';
  t uuid := 'e3200000-0000-0000-0000-000000000001';
BEGIN
  v := public.record_jug_return(jsonb_build_object('sales_rep_id', r, 'container_type_id', t, 'quantity', 10));
  SELECT * INTO s FROM public.shop_jar_summary(r, CURRENT_DATE, CURRENT_DATE);
  PERFORM pg_temp.check(s.sent_unconfirmed = 10 AND s.empties_at_shop = 17, 'not moved until confirmed: ' || row_to_json(s)::text);
  PERFORM set_config('test.uid', 'a3200000-0000-0000-0000-000000000002', false);
  PERFORM public.verify_jug_return((v->>'id')::uuid, 9, 'one short');
  PERFORM set_config('test.uid', 'a3200000-0000-0000-0000-000000000001', false);
  SELECT * INTO s FROM public.shop_jar_summary(r, CURRENT_DATE, CURRENT_DATE);
  PERFORM pg_temp.check(s.sent_to_warehouse = 10 AND s.confirmed_by_warehouse = 9 AND s.sent_unconfirmed = 0
                        AND s.empties_at_shop = 8, 'shortfall stays on the shop: ' || row_to_json(s)::text);
  SELECT * INTO o FROM public.jug_overview(f, CURRENT_DATE, CURRENT_DATE) WHERE container_type_id = t;
  PERFORM pg_temp.check(o.written_off_total = 0 AND o.with_customers = 0, 'overview: ' || row_to_json(o)::text);
END $$;

-- @@ Test 6: deleting the permanent sale puts the jar back in the company's count
DO $$
DECLARE sid uuid; before numeric; after numeric;
  f uuid := 'f3200000-0000-0000-0000-000000000001'; t uuid := 'e3200000-0000-0000-0000-000000000001';
BEGIN
  sid := (SELECT s.id FROM sales s JOIN sale_items si ON si.sale_id = s.id WHERE si.jar_mode = 'permanent' LIMIT 1);
  before := (SELECT in_circulation FROM public.jug_overview(f, CURRENT_DATE, CURRENT_DATE) WHERE container_type_id = t);
  UPDATE sales SET deleted_at = now() WHERE id = sid;
  after := (SELECT in_circulation FROM public.jug_overview(f, CURRENT_DATE, CURRENT_DATE) WHERE container_type_id = t);
  PERFORM pg_temp.check(after = before + 1, 'jar back: ' || before || ' -> ' || after);
END $$;
