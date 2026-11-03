-- ============================================================================
-- Acceptance tests: retail dispenser sales, empties and the cashier's
-- remittance (20261102300000_retail_dispenser_revenue_remittance.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The brief's figures: the Warehouse posts
-- 20 filled dispensers to the shop; one POS sale has 18 with the empty to
-- come back and 2 with the jar bought; 10 empties come back, then 8; all 18
-- go to the Warehouse and are counted; the cashier hands in the day and
-- Accounts confirms it.
-- Prices are the test's own setup (water N1,200, jar N3,000, jar + water
-- N4,200), not figures the system invents.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3300000-0000-0000-0000-000000000001', 'dspfac', 'Dispenser Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a3300000-0000-0000-0000-000000000001', 'admin@dsp'),
  ('a3300000-0000-0000-0000-000000000002', 'cashier@dsp'),
  ('a3300000-0000-0000-0000-000000000003', 'accountant@dsp');
INSERT INTO profiles(id, full_name) VALUES
  ('a3300000-0000-0000-0000-000000000001', 'DSP Admin'),
  ('a3300000-0000-0000-0000-000000000002', 'DSP Cashier'),
  ('a3300000-0000-0000-0000-000000000003', 'DSP Accountant')
ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
DELETE FROM user_roles WHERE user_id IN ('a3300000-0000-0000-0000-000000000001', 'a3300000-0000-0000-0000-000000000002',
                                         'a3300000-0000-0000-0000-000000000003');
INSERT INTO user_roles(user_id, role) VALUES ('a3300000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a3300000-0000-0000-0000-000000000002', 'sales', 'f3300000-0000-0000-0000-000000000001'),
  ('a3300000-0000-0000-0000-000000000003', 'accountant', 'f3300000-0000-0000-0000-000000000001');
INSERT INTO container_types(id, factory_id, name, jar_price, with_jar_price) VALUES
  ('e3300000-0000-0000-0000-000000000001', 'f3300000-0000-0000-0000-000000000001', 'DSP New Dispenser Jug', 3000, 4200);
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3300000-0000-0000-0000-000000000001', 'f3300000-0000-0000-0000-000000000001', 'DSP Dispenser Water', 'Piece', 1200, 20, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b3300000-0000-0000-0000-000000000001', 'e3300000-0000-0000-0000-000000000001', 1, 'with_water');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3300000-0000-0000-0000-000000000001', 'f3300000-0000-0000-0000-000000000001', 'DSP Shop', 'active', 'outlet');
SELECT set_config('test.uid', 'a3300000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('test.uid', CASE p WHEN 'admin' THEN 'a3300000-0000-0000-0000-000000000001'
                                       WHEN 'cashier' THEN 'a3300000-0000-0000-0000-000000000002'
                                       ELSE 'a3300000-0000-0000-0000-000000000003' END, false);
$$;
CREATE OR REPLACE FUNCTION pg_temp.day() RETURNS jsonb LANGUAGE sql AS $$
  SELECT (public.shop_dispenser_day('c3300000-0000-0000-0000-000000000001',
                                    (now() AT TIME ZONE 'Africa/Lagos')::date)->'types')->0
$$;
CREATE OR REPLACE FUNCTION pg_temp.wh_jugs() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(balance), 0) FROM container_balances
   WHERE holder_type = 'warehouse' AND container_type_id = 'e3300000-0000-0000-0000-000000000001'
$$;
CREATE OR REPLACE FUNCTION pg_temp.company_jugs() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(balance), 0) FROM container_balances
   WHERE holder_type <> 'external' AND container_type_id = 'e3300000-0000-0000-0000-000000000001'
$$;
CREATE OR REPLACE FUNCTION pg_temp.sale(p_items jsonb, p_ref text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.create_sale(jsonb_build_object('factory_id', 'f3300000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3300000-0000-0000-0000-000000000001', 'items', p_items, 'client_ref', p_ref,
    'customer_name', 'Mrs Ade', 'customer_phone', '08033300001',
    'payments', jsonb_build_array(jsonb_build_object('amount', 25000, 'method', 'cash'),
                                  jsonb_build_object('amount', 5000, 'method', 'pos'))))
$$;
CREATE TEMP TABLE t_state(k text PRIMARY KEY, val jsonb);
GRANT ALL ON t_state TO PUBLIC;

-- @@ Test 1: the Warehouse posts 20; the cashier can't oversell across two lines of one dispenser
DO $$
DECLARE ok boolean := false;
  p uuid := 'b3300000-0000-0000-0000-000000000001'; r uuid := 'c3300000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO t_state VALUES ('company_jugs_start', to_jsonb(pg_temp.company_jugs()));
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f3300000-0000-0000-0000-000000000001',
    'sales_rep_id', r, 'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 20))));
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = r AND product_id = p) = 20, 'shop has 20 filled');
  PERFORM pg_temp.as_user('cashier');
  BEGIN
    PERFORM pg_temp.sale(jsonb_build_array(
      jsonb_build_object('product_id', p, 'quantity', 19, 'jar_mode', 'return_later'),
      jsonb_build_object('product_id', p, 'quantity', 2, 'jar_mode', 'permanent')), 'dsp-over');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%need 21 together%';
  END;
  PERFORM pg_temp.check(ok, '19 + 2 > 20 refused');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM sales WHERE client_ref = 'dsp-over'), 'nothing posted');
  ok := false;
  BEGIN
    PERFORM pg_temp.sale(jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 1)), 'dsp-nojar');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Choose Swap, Return later or Permanent%';
  END;
  PERFORM pg_temp.check(ok, 'jar arrangement required');
END $$;

-- @@ Test 2: one sale, 18 returnable + 2 permanent -> 0 filled, 18 owed, 2 jars leave the company
DO $$
DECLARE v jsonb; v2 jsonb; rev jsonb; ok boolean := false;
  p uuid := 'b3300000-0000-0000-0000-000000000001'; r uuid := 'c3300000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.as_user('cashier');
  v := pg_temp.sale(jsonb_build_array(
    jsonb_build_object('product_id', p, 'quantity', 18, 'jar_mode', 'return_later'),
    jsonb_build_object('product_id', p, 'quantity', 2, 'jar_mode', 'permanent', 'unit_price', 1)), 'dsp-sale-1');
  INSERT INTO t_state VALUES ('sale', v);
  PERFORM pg_temp.check(v->>'status' = 'posted', 'posted at once: ' || v::text);
  PERFORM pg_temp.check((v->>'grand_total')::numeric = 18 * 1200 + 2 * 4200, 'total 30,000: ' || (v->>'grand_total'));
  -- A double tap sends the same request again: the first sale comes back.
  v2 := pg_temp.sale(jsonb_build_array(
    jsonb_build_object('product_id', p, 'quantity', 18, 'jar_mode', 'return_later'),
    jsonb_build_object('product_id', p, 'quantity', 2, 'jar_mode', 'permanent')), 'dsp-sale-1');
  PERFORM pg_temp.check((v2->>'duplicate')::boolean AND v2->>'sale_id' = v->>'sale_id', 'resubmit returns the first');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM sales WHERE sales_rep_id = r) = 1, 'one sale only');

  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = r AND product_id = p) = 0, '1. filled 0');
  PERFORM pg_temp.check((SELECT SUM(outstanding) FROM public.shop_jar_obligations(r, NULL)) = 18, '2. owed 18');
  PERFORM pg_temp.check(pg_temp.company_jugs() = (SELECT val FROM t_state WHERE k = 'company_jugs_start')::numeric - 2,
                        '3. company jugs down by 2: ' || pg_temp.company_jugs());
  BEGIN
    PERFORM pg_temp.sale(jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 1, 'jar_mode', 'swap')), 'dsp-more');
  EXCEPTION WHEN OTHERS THEN ok := true;
  END;
  PERFORM pg_temp.check(ok, 'no overselling once empty');

  rev := public._outlet_day_figures(r, (now() AT TIME ZONE 'Africa/Lagos')::date)->'money';
  PERFORM pg_temp.check((rev->'revenue'->>'water_revenue')::numeric = 20 * 1200, '4. water revenue 20 x 1,200: ' || rev::text);
  PERFORM pg_temp.check((rev->'revenue'->>'jar_revenue')::numeric = 2 * 3000, '5. jar revenue 2 x 3,000: ' || rev::text);
  PERFORM pg_temp.check((rev->'revenue'->>'adjustments')::numeric = 0 AND (rev->>'sales_value')::numeric = 30000,
                        '6. water + jars = sales 30,000: ' || rev::text);
  PERFORM pg_temp.check((rev->'revenue'->>'sold_return_later')::numeric = 18 AND (rev->'revenue'->>'sold_permanent')::numeric = 2
                        AND (rev->'revenue'->>'jars_sold')::numeric = 2, 'units by choice: ' || rev::text);
  PERFORM pg_temp.check((rev->>'cash_expected')::numeric = 25000 AND (rev->>'other_expected')::numeric = 5000,
                        'cash 25,000 + POS 5,000: ' || rev::text);
END $$;

-- @@ Test 3: the day's dispenser reconciliation before any empty comes back
DO $$
DECLARE d jsonb := pg_temp.day();
BEGIN
  PERFORM pg_temp.check((d->>'received_filled')::numeric = 20 AND (d->>'opening_filled')::numeric = 0, 'received 20: ' || d::text);
  PERFORM pg_temp.check((d->>'sold_return_later')::numeric = 18 AND (d->>'sold_permanent')::numeric = 2, 'sold 18 + 2: ' || d::text);
  PERFORM pg_temp.check((d->>'filled_remaining')::numeric = 0, 'remaining 0: ' || d::text);
  PERFORM pg_temp.check((d->>'empties_expected')::numeric = 18 AND (d->>'owed_from_day')::numeric = 18
                        AND (d->>'owed_total')::numeric = 18, 'expected / owed 18: ' || d::text);
  PERFORM pg_temp.check((d->>'jars_sold')::numeric = 2, 'jars sold 2: ' || d::text);
  PERFORM pg_temp.check((d->>'inventory_variance')::numeric = 0 AND (d->>'pos_units')::numeric = 20
                        AND (d->>'stock_sold')::numeric = 20, 'POS agrees with the stock: ' || d::text);
  PERFORM pg_temp.check((d->>'water_revenue')::numeric = 24000 AND (d->>'jar_revenue')::numeric = 6000, 'revenue: ' || d::text);
END $$;

-- @@ Test 4: 10 empties back, then 8 (resubmitted once) -> 18 at the shop, 0 owed
DO $$
DECLARE d jsonb; v jsonb; v2 jsonb;
  r uuid := 'c3300000-0000-0000-0000-000000000001';
  sid uuid := ((SELECT val FROM t_state WHERE k = 'sale')->>'sale_id')::uuid;
BEGIN
  PERFORM pg_temp.as_user('cashier');
  v := public.record_customer_jar_return(jsonb_build_object('outlet_id', r, 'sale_id', sid,
    'container_type_id', 'e3300000-0000-0000-0000-000000000001', 'quantity_good', 10, 'client_ref', 'dsp-ret-1'));
  PERFORM pg_temp.check(v->>'return_number' IS NOT NULL, 'return reference');
  d := pg_temp.day();
  PERFORM pg_temp.check((d->>'empties_expected')::numeric = 18 AND (d->>'returned_good')::numeric = 10
                        AND (d->>'owed_total')::numeric = 8, '18 expected, 10 back, 8 owed: ' || d::text);
  v := public.record_customer_jar_return(jsonb_build_object('outlet_id', r, 'sale_id', sid,
    'container_type_id', 'e3300000-0000-0000-0000-000000000001', 'quantity_good', 8, 'client_ref', 'dsp-ret-2'));
  v2 := public.record_customer_jar_return(jsonb_build_object('outlet_id', r, 'sale_id', sid,
    'container_type_id', 'e3300000-0000-0000-0000-000000000001', 'quantity_good', 8, 'client_ref', 'dsp-ret-2'));
  PERFORM pg_temp.check((v2->>'duplicate')::boolean, 'a return is not counted twice');
  d := pg_temp.day();
  PERFORM pg_temp.check((d->>'returned_good')::numeric = 18 AND (d->>'owed_total')::numeric = 0
                        AND (d->>'empties_at_shop')::numeric = 18, '7. all 18 back, 0 owed: ' || d::text);
END $$;

-- @@ Test 5: all 18 sent to the Warehouse: off the shop's empties at once, into the Warehouse when counted
DO $$
DECLARE d jsonb; v jsonb; wh_before numeric := pg_temp.wh_jugs();
  r uuid := 'c3300000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.as_user('cashier');
  v := public.record_jug_return(jsonb_build_object('sales_rep_id', r,
    'container_type_id', 'e3300000-0000-0000-0000-000000000001', 'quantity', 18));
  d := pg_temp.day();
  PERFORM pg_temp.check((d->>'empties_at_shop')::numeric = 0 AND (d->>'sent_unconfirmed')::numeric = 18,
                        'in transit, not at the shop: ' || d::text);
  PERFORM pg_temp.check(pg_temp.wh_jugs() = wh_before, 'Warehouse unchanged until counted');
  PERFORM pg_temp.as_user('admin');
  PERFORM public.verify_jug_return((v->>'id')::uuid, 18, NULL);
  d := pg_temp.day();
  PERFORM pg_temp.check((d->>'empties_at_shop')::numeric = 0 AND (d->>'sent_unconfirmed')::numeric = 0
                        AND (d->>'confirmed_by_warehouse')::numeric = 18 AND (d->>'transfer_short')::numeric = 0,
                        'shop empties 0, 18 confirmed: ' || d::text);
  PERFORM pg_temp.check(pg_temp.wh_jugs() = wh_before + 18, '8. Warehouse empties +18: ' || wh_before || ' -> ' || pg_temp.wh_jugs());
END $$;

-- @@ Test 6: the cashier submits; only Accounts confirms; a difference needs a note
DO $$
DECLARE ok boolean := false; rid uuid; c jsonb;
  r uuid := 'c3300000-0000-0000-0000-000000000001'; d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  PERFORM pg_temp.as_user('cashier');
  rid := (public.submit_outlet_day(r, d, 25000, 5000,
           jsonb_build_array(jsonb_build_object('product_id', 'b3300000-0000-0000-0000-000000000001', 'counted', 0)))->>'id')::uuid;
  BEGIN
    PERFORM public.confirm_outlet_day(rid, 25000, 5000, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM pg_temp.check(ok, 'the cashier cannot confirm their own remittance');

  PERFORM pg_temp.as_user('accountant');
  ok := false;
  BEGIN
    PERFORM public.confirm_outlet_day(rid, 24000, 5000, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Add a note%';
  END;
  PERFORM pg_temp.check(ok, 'a shortage needs a note');
  PERFORM public.confirm_outlet_day(rid, 25000, 5000, NULL);

  c := public.shop_dispenser_day(r, d)->'cashup';
  PERFORM pg_temp.check(c->>'status' = 'confirmed' AND (c->>'short_over')::numeric = 0, '9. confirmed, nothing short: ' || c::text);
  PERFORM pg_temp.check((c->'revenue'->>'jar_revenue')::numeric = 6000 AND (c->'revenue'->>'water_revenue')::numeric = 24000,
                        '9. jar revenue apart on the remittance: ' || c::text);
  PERFORM pg_temp.check(c->>'cashier' = 'DSP Cashier' AND c->>'accountant' = 'DSP Accountant'
                        AND jsonb_array_length(c->'remittances') = 2 AND c->>'reference' LIKE 'CU-%',
                        'who, references: ' || c::text);
  PERFORM pg_temp.check((SELECT SUM(amount) FROM rep_remittances WHERE sales_rep_id = r) = 30000, 'remitted 30,000');
END $$;

-- @@ Test 7: the reports agree with the source records; filters narrow them
DO $$
DECLARE rep jsonb; x jsonb;
  f uuid := 'f3300000-0000-0000-0000-000000000001'; d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  PERFORM pg_temp.as_user('accountant');
  rep := public.retail_dispenser_report(f, d, d);
  PERFORM pg_temp.check(jsonb_array_length(rep->'sales') = 2, 'two dispenser lines: ' || (rep->'sales')::text);
  PERFORM pg_temp.check((SELECT SUM((e->>'water_revenue')::numeric) FROM jsonb_array_elements(rep->'sales') e) = 24000
                    AND (SELECT SUM((e->>'jar_revenue')::numeric) FROM jsonb_array_elements(rep->'sales') e) = 6000,
                        'report revenue: ' || (rep->'sales')::text);
  PERFORM pg_temp.check((SELECT SUM((e->>'jugs')::numeric) FILTER (WHERE e->>'jar_mode' = 'permanent')
                           FROM jsonb_array_elements(rep->'sales') e) = 2, 'permanent jugs 2');
  PERFORM pg_temp.check((SELECT SUM((e->>'quantity_good')::numeric) FROM jsonb_array_elements(rep->'returns') e) = 18,
                        'returns 18: ' || (rep->'returns')::text);
  x := rep->'transfers'->0;
  PERFORM pg_temp.check(jsonb_array_length(rep->'transfers') = 1 AND (x->>'sent')::numeric = 18
                        AND (x->>'received')::numeric = 18 AND (x->>'short')::numeric = 0, 'transfer: ' || x::text);
  x := rep->'cashups'->0;
  PERFORM pg_temp.check(jsonb_array_length(rep->'cashups') = 1 AND x->>'status' = 'confirmed'
                        AND (x->>'jar_revenue')::numeric = 6000 AND (x->>'received')::numeric = 30000
                        AND (x->>'short_over')::numeric = 0 AND x->>'accountant' = 'DSP Accountant', 'cash-up: ' || x::text);
  PERFORM pg_temp.check(jsonb_array_length(rep->'outstanding') = 0, 'nothing owed');
  PERFORM pg_temp.check(jsonb_array_length(rep->'cashiers') = 1 AND rep->'cashiers'->0->>'name' = 'DSP Cashier', 'cashier list');

  rep := public.retail_dispenser_report(f, d, d, NULL, 'a3300000-0000-0000-0000-000000000001', NULL);
  PERFORM pg_temp.check(jsonb_array_length(rep->'sales') = 0 AND jsonb_array_length(rep->'returns') = 0, 'cashier filter');
  rep := public.retail_dispenser_report(f, d, d, NULL, NULL, '0803330');
  PERFORM pg_temp.check(jsonb_array_length(rep->'sales') = 2, 'customer filter by phone');
  rep := public.retail_dispenser_report(f, d, d, NULL, NULL, 'nobody');
  PERFORM pg_temp.check(jsonb_array_length(rep->'sales') = 0, 'customer filter: no match');
END $$;

-- @@ Test 8: everything agrees -- POS, the shop, the Warehouse and the money
DO $$
DECLARE d jsonb := pg_temp.day(); r uuid := 'c3300000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.check((SELECT COALESCE(SUM(balance), 0) FROM container_balances
                          WHERE holder_type = 'sales_rep' AND holder_id = r) = 0, 'the shop holds no jug');
  PERFORM pg_temp.check((SELECT COALESCE(SUM(balance), 0) FROM container_balances
                          WHERE holder_type IN ('customer', 'walk_in')
                            AND container_type_id = 'e3300000-0000-0000-0000-000000000001') = 0, 'no customer holds one');
  PERFORM pg_temp.check((d->>'inventory_variance')::numeric = 0 AND (d->>'count_variance')::numeric = 0,
                        '10. no inventory variance: ' || d::text);
  PERFORM pg_temp.check((d->>'received_filled')::numeric - (d->>'sold_return_later')::numeric - (d->>'sold_permanent')::numeric
                          = (d->>'filled_remaining')::numeric, '20 - 18 - 2 = 0');
END $$;
