-- ============================================================================
-- Acceptance tests: 20261109140000_dispenser_types_on_postings.sql
--   A posting says Dispenser Water or Jug + Water with its price, its jug is
--   not owed again, unsold Jug + Water comes back at its price, and the shop's
--   day close lists the three types and still adds up to the one stock.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7500000-0000-0000-0000-000000000001', 'dtpfac', 'DTP Factory');
INSERT INTO auth.users(id, email) VALUES ('a7500000-0000-0000-0000-000000000001', 'admin@dtp');
INSERT INTO user_roles(user_id, role) VALUES ('a7500000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e7500000-0000-0000-0000-000000000001', 'f7500000-0000-0000-0000-000000000001', 'DTP Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7500000-0000-0000-0000-000000000001', 'f7500000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 100, 'finished'),
  ('b7500000-0000-0000-0000-000000000002', 'f7500000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 3000, 0, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b7500000-0000-0000-0000-000000000001', 'e7500000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b7500000-0000-0000-0000-000000000002', 'e7500000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c7500000-0000-0000-0000-000000000001', 'f7500000-0000-0000-0000-000000000001', 'DTP Marketer', 'active', 'rep'),
  ('c7500000-0000-0000-0000-000000000002', 'f7500000-0000-0000-0000-000000000001', 'DTP Shop', 'active', 'outlet');
SELECT set_config('test.uid', 'a7500000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: both types on one posting, each named and priced, one stock
DO $$
DECLARE f uuid := 'f7500000-0000-0000-0000-000000000001'; m uuid := 'c7500000-0000-0000-0000-000000000001';
  w uuid := 'b7500000-0000-0000-0000-000000000001'; d jsonb; t text;
BEGIN
  d := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(
      jsonb_build_object('product_id', w, 'quantity', 10, 'jar_mode', 'permanent'),
      jsonb_build_object('product_id', w, 'quantity', 5))));
  PERFORM pg_temp.check((d->>'total_value')::numeric = 10 * 4200 + 5 * 1200, 'value: ' || d::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = w) = 85, 'one Warehouse stock');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = m AND product_id = w) = 15, 'one van stock');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.rep_posting_lines('dispatch', (d->>'id')::uuid) l
                                 WHERE l.product_name = 'Jug + Water' AND l.unit_price = 4200 AND l.quantity = 10), 'invoice line Jug + Water');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.rep_posting_lines('dispatch', (d->>'id')::uuid) l
                                 WHERE l.product_name = 'Dispenser Water' AND l.unit_price = 1200 AND l.quantity = 5), 'invoice line Dispenser Water');
  SELECT items INTO t FROM public.accounting_postings(f, 100) WHERE reference = d->>'dispatch_number';
  PERFORM pg_temp.check(t LIKE '%Jug + Water × 10 @ 4,200%' AND t LIKE '%Dispenser Water × 5 @ 1,200%', 'Accounts: ' || t);
  SELECT items INTO t FROM public.warehouse_transactions(f, 100) WHERE reference = d->>'dispatch_number';
  PERFORM pg_temp.check(t LIKE '%Jug + Water × 10%', 'Warehouse: ' || t);
END $$;

-- @@ Test 2: only a filled dispenser can be Jug + Water; both types share the stock check
DO $$
DECLARE f uuid := 'f7500000-0000-0000-0000-000000000001'; m uuid := 'c7500000-0000-0000-0000-000000000001'; ok boolean := false;
BEGIN
  UPDATE products SET current_stock = 5 WHERE id = 'b7500000-0000-0000-0000-000000000002';
  BEGIN
    PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m, 'items', jsonb_build_array(
      jsonb_build_object('product_id', 'b7500000-0000-0000-0000-000000000002', 'quantity', 1, 'jar_mode', 'permanent'))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%can''t be posted as Jug + Water%'; END;
  PERFORM pg_temp.check(ok, 'Empty Jug refused as Jug + Water');
  ok := false;
  BEGIN
    PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m, 'items', jsonb_build_array(
      jsonb_build_object('product_id', 'b7500000-0000-0000-0000-000000000001', 'quantity', 50, 'jar_mode', 'permanent'),
      jsonb_build_object('product_id', 'b7500000-0000-0000-0000-000000000001', 'quantity', 50))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient store stock%'; END;
  PERFORM pg_temp.check(ok, 'the two lines together are checked against the stock');
END $$;

-- @@ Test 3: a Jug + Water jug is not owed again; only the Dispenser Water jugs are
DO $$
DECLARE s jsonb;
BEGIN
  s := public.rep_account_summary('c7500000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check((s->>'goods_out_value')::numeric = 48000, 'goods: ' || s::text);
  PERFORM pg_temp.check((s->>'jugs_owed')::numeric = 5 AND (s->>'jugs_owed_value')::numeric = 15000, 'jugs: ' || s::text);
END $$;

-- @@ Test 4: unsold Jug + Water comes back at its price, no more than was posted
DO $$
DECLARE f uuid := 'f7500000-0000-0000-0000-000000000001'; m uuid := 'c7500000-0000-0000-0000-000000000001';
  w uuid := 'b7500000-0000-0000-0000-000000000001'; r jsonb; s jsonb; ok boolean := false;
BEGIN
  r := public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', m, 'items', jsonb_build_array(
    jsonb_build_object('product_id', w, 'quantity_returned', 2, 'jar_mode', 'permanent'),
    jsonb_build_object('product_id', w, 'quantity_returned', 1))));
  PERFORM pg_temp.check(r->>'return_number' LIKE '% + %', 'both returns named: ' || r::text);
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = m AND product_id = w) = 12, 'van stock');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM rep_return_items i JOIN rep_returns x ON x.id = i.rep_return_id
                                 WHERE x.sales_rep_id = m AND i.jar_mode = 'permanent' AND i.quantity_returned = 2 AND i.unit_price = 4200), 'credited 4,200');
  s := public.rep_account_summary(m);
  PERFORM pg_temp.check((s->>'jugs_owed')::numeric = 4, 'the plain return clears a jug, Jug + Water does not: ' || s::text);
  PERFORM pg_temp.check((s->>'accepted_returns_value')::numeric = 2 * 4200 + 1200, 'returns value: ' || s::text);
  BEGIN
    PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', m, 'items', jsonb_build_array(
      jsonb_build_object('product_id', w, 'quantity_returned', 9, 'jar_mode', 'permanent'))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Only 8 Jug + Water%'; END;
  PERFORM pg_temp.check(ok, 'over-return refused');
END $$;

-- @@ Test 5: a Costing change re-prices Dispenser Water lines, not Jug + Water
DO $$
DECLARE w uuid := 'b7500000-0000-0000-0000-000000000001';
BEGIN
  UPDATE products SET unit_price = 1300 WHERE id = w;
  PERFORM public.reprice_posted_lines(w, 'test');
  PERFORM pg_temp.check((SELECT bool_and(unit_price = 1300) FROM stock_dispatch_items WHERE product_id = w AND jar_mode IS NULL), 'water re-priced');
  PERFORM pg_temp.check((SELECT bool_and(unit_price = 4200) FROM stock_dispatch_items WHERE product_id = w AND jar_mode = 'permanent'), 'Jug + Water kept');
  UPDATE products SET unit_price = 1200 WHERE id = w;
END $$;

-- @@ Test 6: the day close lists the three types and adds up to the one stock
DO $$
DECLARE f uuid := 'f7500000-0000-0000-0000-000000000001'; o uuid := 'c7500000-0000-0000-0000-000000000002';
  w uuid := 'b7500000-0000-0000-0000-000000000001'; s jsonb; fig jsonb; d jsonb; j jsonb; e jsonb; today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  counts jsonb;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', o,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 3, 'jar_mode', 'permanent'),
                               jsonb_build_object('product_id', w, 'quantity', 10))));
  s := public.create_sale(jsonb_build_object('factory_id', f, 'sales_rep_id', o, 'amount_paid', 0,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 5, 'jar_mode', 'permanent'),
                               jsonb_build_object('product_id', w, 'quantity', 4, 'jar_mode', 'swap'))));
  IF s->>'status' = 'pending_approval' THEN PERFORM public._post_sale((s->>'sale_id')::uuid, 'test'); END IF;

  fig := public._outlet_day_figures(o, today);
  SELECT x INTO d FROM jsonb_array_elements(fig->'products') x WHERE x->>'name' = 'Dispenser Water';
  SELECT x INTO j FROM jsonb_array_elements(fig->'products') x WHERE x->>'name' = 'Jug + Water';
  SELECT x INTO e FROM jsonb_array_elements(fig->'products') x WHERE x->>'name' = 'Empty Jug';
  PERFORM pg_temp.check((j->>'received')::numeric = 3 AND (j->>'sold')::numeric = 5 AND (j->>'closing')::numeric = 0, 'Jug + Water: ' || j::text);
  PERFORM pg_temp.check(j->>'note' = '2 taken from Dispenser Water stock', 'note: ' || j::text);
  PERFORM pg_temp.check((d->>'received')::numeric = 10 AND (d->>'sold')::numeric = 4 AND (d->>'closing')::numeric = 4, 'Dispenser Water: ' || d::text);
  PERFORM pg_temp.check(d->>'note' = '2 sold as Jug + Water from this stock', 'note: ' || d::text);
  PERFORM pg_temp.check((d->>'closing')::numeric + (j->>'closing')::numeric = (SELECT quantity FROM rep_stock WHERE sales_rep_id = o AND product_id = w), 'adds up to the stock');
  PERFORM pg_temp.check(e IS NOT NULL AND (e->>'closing')::numeric = 0, 'Empty Jug always listed: ' || COALESCE(e::text, 'none'));
  PERFORM pg_temp.check((fig->'stock'->>'closing')::numeric = 4 AND (fig->'stock'->>'sold')::numeric = 9, 'totals: ' || (fig->'stock')::text);

  -- Counted per type, through the normal submit.
  SELECT jsonb_agg(jsonb_build_object('product_id', x->>'product_id', 'counted', (x->>'closing')::numeric))
    INTO counts FROM jsonb_array_elements(fig->'products') x;
  PERFORM public.submit_outlet_day(o, today, (fig->'money'->>'cash_expected')::numeric,
                                   (fig->'money'->>'other_expected')::numeric, counts, NULL);
  PERFORM pg_temp.check(jsonb_array_length((SELECT counted_stock FROM outlet_day_reconciliations WHERE sales_rep_id = o AND close_date = today)) = 3, 'three counted lines');
END $$;

-- @@ Test 7: Accounts' other lists show the type as posted, with its price
DO $$
DECLARE f uuid := 'f7500000-0000-0000-0000-000000000001'; m uuid := 'c7500000-0000-0000-0000-000000000001';
  o uuid := 'c7500000-0000-0000-0000-000000000002'; today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.day_postings(f, CURRENT_DATE - 1, CURRENT_DATE + 1) x
                                 WHERE x.product_name = 'Jug + Water' AND x.unit_price = 4200), 'day postings');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.party_postings_and_returns(f, m) x
                                 WHERE x.kind = 'posting' AND x.product_name = 'Jug + Water' AND x.unit_price = 4200), 'marketer posting');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.party_postings_and_returns(f, m) x
                                 WHERE x.kind = 'return' AND x.product_name = 'Jug + Water' AND x.unit_price = 4200), 'marketer return');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.party_postings_and_returns(f, m) x
                                 WHERE x.kind = 'posting' AND x.product_name = 'Dispenser Water'), 'plain line keeps its name');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.retail_daily_book(o, CURRENT_DATE - 1, CURRENT_DATE + 1) x
                                 WHERE x.kind = 'posting' AND x.product_name = 'Jug + Water'), 'daily book posting');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.retail_daily_book(o, CURRENT_DATE - 1, CURRENT_DATE + 1) x
                                 WHERE x.kind = 'sale' AND x.product_name = 'Jug + Water' AND x.quantity = 5), 'daily book sale');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.rep_posting_lines('sale',
                                  (SELECT s.id FROM sales s WHERE s.sales_rep_id = o LIMIT 1)) x
                                 WHERE x.product_name = 'Jug + Water'), 'sale line');
END $$;

-- @@ Test 8: the whole flow by role: restock, post, officer limits, Accounts' sale, invoice
INSERT INTO auth.users(id, email) VALUES
  ('a7500000-0000-0000-0000-000000000002', 'kemi@dtp'),
  ('a7500000-0000-0000-0000-000000000003', 'gideon@dtp');
INSERT INTO roles(slug, label, is_system) VALUES ('dtp_wh_test', 'Warehouse (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'dtp_wh_test', m::module_key, a::action_key
  FROM unnest(ARRAY['finished-goods', 'distribution']) m, unnest(ARRAY['view', 'create']) a
ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a7500000-0000-0000-0000-000000000002', 'dtp_wh_test', 'f7500000-0000-0000-0000-000000000001'),
  ('a7500000-0000-0000-0000-000000000003', 'dtp_wh_test', 'f7500000-0000-0000-0000-000000000001');
INSERT INTO user_product_rules(user_id, name_pattern, label) VALUES
  ('a7500000-0000-0000-0000-000000000002', 'bottle', 'Bottles'),
  ('a7500000-0000-0000-0000-000000000003', 'dispenser|jug water', 'Dispensers');
INSERT INTO customers(id, factory_id, name, phone, address, registered) VALUES
  ('d7500000-0000-0000-0000-000000000001', 'f7500000-0000-0000-0000-000000000001', 'DTP Office', '0800', 'Abuja', true);
DO $$
DECLARE f uuid := 'f7500000-0000-0000-0000-000000000001'; m uuid := 'c7500000-0000-0000-0000-000000000001';
  w uuid := 'b7500000-0000-0000-0000-000000000001'; e uuid := 'b7500000-0000-0000-0000-000000000002';
  c uuid := 'd7500000-0000-0000-0000-000000000001'; r jsonb; p jsonb; ok boolean := false; v0 numeric; s jsonb; t text;
BEGIN
  PERFORM public._adopt_empty_jug_name();
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM user_product_rules WHERE user_id = 'a7500000-0000-0000-0000-000000000003' AND 'Empty Jug' ~* name_pattern), 'Gideon handles Empty Jug');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM user_product_rules WHERE user_id = 'a7500000-0000-0000-0000-000000000002' AND 'Empty Jug' ~* name_pattern), 'Kemi does not');

  -- Gideon restocks and posts all three types; Kemi is refused.
  PERFORM set_config('test.uid', 'a7500000-0000-0000-0000-000000000003', false);
  PERFORM public.warehouse_restock(jsonb_build_object('factory_id', f, 'product_id', e, 'quantity', 20));
  r := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m, 'items', jsonb_build_array(
    jsonb_build_object('product_id', w, 'quantity', 1),
    jsonb_build_object('product_id', w, 'quantity', 1, 'jar_mode', 'permanent'),
    jsonb_build_object('product_id', e, 'quantity', 3))));
  PERFORM pg_temp.check((r->>'total_value')::numeric = 1200 + 4200 + 9000, 'three types priced: ' || r::text);
  PERFORM set_config('test.uid', 'a7500000-0000-0000-0000-000000000001', false); -- Accounts reads it
  SELECT items INTO t FROM public.accounting_postings(f, 100) WHERE reference = r->>'dispatch_number';
  PERFORM pg_temp.check(t LIKE '%Empty Jug × 3 @ 3,000%' AND t LIKE '%Jug + Water × 1 @ 4,200%' AND t LIKE '%Dispenser Water × 1 @ 1,200%', 'Accounts sees all three: ' || t);
  PERFORM set_config('test.uid', 'a7500000-0000-0000-0000-000000000002', false);
  BEGIN
    PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m, 'items', jsonb_build_array(
      jsonb_build_object('product_id', e, 'quantity', 1))));
  EXCEPTION WHEN OTHERS THEN ok := true; END;
  PERFORM pg_temp.check(ok, 'Kemi cannot post Empty Jug');
  PERFORM set_config('test.uid', 'a7500000-0000-0000-0000-000000000001', false);

  -- Accounts records a van sale as Jug + Water.
  SELECT trim_scale(water_price) || '/' || trim_scale(with_jug) INTO t FROM public.dispenser_type_prices(f);
  PERFORM pg_temp.check(t = '1200/4200', 'prices: ' || COALESCE(t, 'none'));
  v0 := (SELECT quantity FROM rep_stock WHERE sales_rep_id = m AND product_id = w);
  s := public.record_marketer_customer_sale(jsonb_build_object('sales_rep_id', m, 'customer_id', c, 'items', jsonb_build_array(
    jsonb_build_object('product_id', w, 'quantity', 2, 'jar_mode', 'permanent'),
    jsonb_build_object('product_id', w, 'quantity', 1))));
  PERFORM pg_temp.check((s->>'grand_total')::numeric = 2 * 4200 + 1200, 'sale total: ' || s::text);
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = m AND product_id = w) = v0 - 3, 'off the one van stock');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.sale_invoice_lines(ARRAY[(s->>'sale_id')::uuid]) l
                                 WHERE l.product_name = 'Jug + Water' AND l.unit_price = 4200 AND l.quantity = 2), 'invoice says Jug + Water');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.sale_invoice_lines(ARRAY[(s->>'sale_id')::uuid]) l
                                 WHERE l.product_name = 'Dispenser Water' AND l.unit_price = 1200), 'invoice says Dispenser Water');
  PERFORM pg_temp.check((SELECT jar_unit_price FROM sale_items WHERE sale_id = (s->>'sale_id')::uuid AND jar_mode = 'permanent') = 3000, 'jug part kept');
  p := public.sale_invoice_party((s->>'sale_id')::uuid);
  PERFORM pg_temp.check(p->'customer'->>'phone' = '0800' AND p->'customer'->>'address' = 'Abuja', 'contact on the invoice: ' || p::text);

  ok := false;
  BEGIN
    PERFORM public.record_marketer_customer_sale(jsonb_build_object('sales_rep_id', m, 'customer_id', c, 'items', jsonb_build_array(
      jsonb_build_object('product_id', w, 'quantity', v0, 'jar_mode', 'permanent'),
      jsonb_build_object('product_id', w, 'quantity', v0))));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%on hand%'; END;
  PERFORM pg_temp.check(ok, 'both lines checked against the van');
END $$;

-- @@ Test 9: a distributor's Jug + Water and Dispenser Water show apart in Accounts' window (2026-11-12)
DO $$
DECLARE f uuid := 'f7500000-0000-0000-0000-000000000001';
  w uuid := 'b7500000-0000-0000-0000-000000000001'; s jsonb;
BEGIN
  s := public.create_sale(jsonb_build_object('factory_id', f, 'customer_name', 'DTP Medix',
         'sale_date', (now() AT TIME ZONE 'Africa/Lagos')::date, 'payments', '[]'::jsonb,
         'items', jsonb_build_array(
           jsonb_build_object('product_id', w, 'quantity', 19, 'jar_mode', 'permanent'),
           jsonb_build_object('product_id', w, 'quantity', 14, 'unit_price', 1200, 'jar_mode', 'swap'))));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.party_postings_and_returns(f, NULL, 'DTP Medix') x
                                 WHERE x.product_name = 'Jug + Water' AND x.quantity = 19 AND x.unit_price = 4200),
                        'Jug + Water line: ' || (SELECT string_agg(product_name || ' ' || quantity || ' @ ' || unit_price, '; ')
                                                    FROM public.party_postings_and_returns(f, NULL, 'DTP Medix')));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.party_postings_and_returns(f, NULL, 'DTP Medix') x
                                 WHERE x.product_name = 'Dispenser Water' AND x.quantity = 14 AND x.unit_price = 1200),
                        'Dispenser Water line kept apart');
END $$;
