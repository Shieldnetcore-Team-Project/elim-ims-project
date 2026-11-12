-- ============================================================================
-- Acceptance tests: 20261112110000_correction_keeps_jug_type.sql
--   Correcting a distributor posting keeps Jug + Water / Dispenser Water, and
--   postings corrected before the fix get their type and their jugs back
--   right (user, 2026-11-12: H MEDIX's corrected invoice showed "Dispenser
--   Water 19 @ 4,200").
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7600000-0000-0000-0000-000000000001', 'cjtfac', 'CJT Factory');
INSERT INTO auth.users(id, email) VALUES ('a7600000-0000-0000-0000-000000000001', 'admin@cjt');
INSERT INTO user_roles(user_id, role) VALUES ('a7600000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e7600000-0000-0000-0000-000000000001', 'f7600000-0000-0000-0000-000000000001', 'CJT Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7600000-0000-0000-0000-000000000001', 'f7600000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 500, 'finished'),
  ('b7600000-0000-0000-0000-000000000002', 'f7600000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 3000, 0, 'finished'),
  ('b7600000-0000-0000-0000-000000000003', 'f7600000-0000-0000-0000-000000000001', '75cl Bottle Water', 'Pack', 1700, 500, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b7600000-0000-0000-0000-000000000001', 'e7600000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b7600000-0000-0000-0000-000000000002', 'e7600000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d7600000-0000-0000-0000-000000000001', 'f7600000-0000-0000-0000-000000000001', 'CJT Medix', true);
SELECT set_config('test.uid', 'a7600000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
-- Jugs the customer is down as owing back.
CREATE OR REPLACE FUNCTION pg_temp.owed() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(sum(CASE WHEN to_type = 'customer' AND to_id = 'd7600000-0000-0000-0000-000000000001' THEN quantity
                           WHEN from_type = 'customer' AND from_id = 'd7600000-0000-0000-0000-000000000001' THEN -quantity
                           ELSE 0 END), 0)
    FROM container_movements;
$$;
CREATE OR REPLACE FUNCTION pg_temp.post(p_items jsonb, p_remarks text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := public.create_sale(jsonb_build_object('factory_id', 'f7600000-0000-0000-0000-000000000001',
         'customer_id', 'd7600000-0000-0000-0000-000000000001', 'customer_name', 'CJT Medix',
         'sale_date', (now() AT TIME ZONE 'Africa/Lagos')::date, 'payments', '[]'::jsonb,
         'remarks', p_remarks, 'items', p_items));
  IF v->>'status' = 'pending_approval' THEN
    PERFORM public._post_sale((v->>'sale_id')::uuid, 'test');
  END IF;
  RETURN (v->>'sale_id')::uuid;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.lines(p_sale uuid) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(public._sale_line_name(p.name, si.jar_mode) || ' ' || si.quantity::int || ' @ ' || si.unit_price::int, '; '
                    ORDER BY si.unit_price DESC)
    FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = p_sale;
$$;

-- @@ Test 1: a correction keeps each line's type even when the app doesn't send it
DO $$
DECLARE s1 uuid; v jsonb; s2 uuid;
  w uuid := 'b7600000-0000-0000-0000-000000000001'; b uuid := 'b7600000-0000-0000-0000-000000000003';
BEGIN
  s1 := pg_temp.post(jsonb_build_array(
          jsonb_build_object('product_id', w, 'quantity', 19, 'jar_mode', 'permanent'),
          jsonb_build_object('product_id', w, 'quantity', 14, 'unit_price', 1200, 'jar_mode', 'swap'),
          jsonb_build_object('product_id', b, 'quantity', 50, 'unit_price', 1700)));
  PERFORM pg_temp.check(pg_temp.lines(s1) = 'Jug + Water 19 @ 4200; 75cl Bottle Water 50 @ 1700; Dispenser Water 14 @ 1200',
                        'posted: ' || pg_temp.lines(s1));
  PERFORM pg_temp.check(pg_temp.owed() = 0, 'nothing owed after posting, got ' || pg_temp.owed());
  -- The old window sent no types; 75cl changed 50 -> 40.
  v := public.correct_warehouse_posting(s1, jsonb_build_object('reason', 'wrong input', 'items', jsonb_build_array(
          jsonb_build_object('product_id', w, 'quantity', 19, 'unit_price', 4200),
          jsonb_build_object('product_id', w, 'quantity', 14, 'unit_price', 1200),
          jsonb_build_object('product_id', b, 'quantity', 40, 'unit_price', 1700))));
  s2 := (v->>'sale_id')::uuid;
  PERFORM pg_temp.check(pg_temp.lines(s2) = 'Jug + Water 19 @ 4200; 75cl Bottle Water 40 @ 1700; Dispenser Water 14 @ 1200',
                        'corrected: ' || pg_temp.lines(s2));
  PERFORM pg_temp.check(pg_temp.owed() = 0, 'still nothing owed after the correction, got ' || pg_temp.owed());
  -- Stock: one dispenser stock, 33 out once.
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = w) = 500 - 33, 'dispenser stock 467');
END $$;

-- @@ Test 2: a posting corrected before the fix is repaired -- type and jugs
DO $$
DECLARE s1 uuid; s2 uuid; inv1 text; n int; ok boolean := false;
  w uuid := 'b7600000-0000-0000-0000-000000000001'; b uuid := 'b7600000-0000-0000-0000-000000000003';
  stock_before numeric;
BEGIN
  s1 := pg_temp.post(jsonb_build_array(
          jsonb_build_object('product_id', w, 'quantity', 19, 'jar_mode', 'permanent'),
          jsonb_build_object('product_id', w, 'quantity', 140, 'unit_price', 1200, 'jar_mode', 'swap'),
          jsonb_build_object('product_id', b, 'quantity', 50, 'unit_price', 1700)));
  inv1 := (SELECT invoice_number FROM sales WHERE id = s1);
  -- What the old correction did: reverse, then repost the lines without types
  -- (before the price check on new lines existed).
  ALTER TABLE sale_items DISABLE TRIGGER trg_sale_item_type_from_price;
  PERFORM public._reverse_posted_sale(s1, 'Corrected: wrong input');
  s2 := pg_temp.post(jsonb_build_array(
          jsonb_build_object('product_id', w, 'quantity', 140, 'unit_price', 1200),
          jsonb_build_object('product_id', w, 'quantity', 19, 'unit_price', 4200),
          jsonb_build_object('product_id', b, 'quantity', 50, 'unit_price', 1700)),
        'Correction of ' || inv1 || ': wrong input');
  PERFORM pg_temp.check(pg_temp.lines(s2) = 'Dispenser Water 19 @ 4200; 75cl Bottle Water 50 @ 1700; Dispenser Water 140 @ 1200',
                        'broken as on the live invoice: ' || pg_temp.lines(s2));
  ALTER TABLE sale_items ENABLE TRIGGER trg_sale_item_type_from_price;
  PERFORM pg_temp.check(pg_temp.owed() = 159, '159 jugs wrongly owed, got ' || pg_temp.owed());
  stock_before := (SELECT current_stock FROM products WHERE id = w);

  n := public._restore_corrected_jug_types();
  PERFORM pg_temp.check(n = 2, 'two lines repaired, got ' || n);
  PERFORM pg_temp.check(pg_temp.lines(s2) = 'Jug + Water 19 @ 4200; 75cl Bottle Water 50 @ 1700; Dispenser Water 140 @ 1200',
                        'repaired: ' || pg_temp.lines(s2));
  PERFORM pg_temp.check(pg_temp.owed() = 0, 'no jugs owed after repair, got ' || pg_temp.owed());
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM container_movements WHERE sale_id = s2 AND source = 'jar_sold' AND quantity = 19),
                        '19 jugs recorded as sold');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = w) = stock_before, 'stock untouched');
  PERFORM pg_temp.check((SELECT grand_total FROM sales WHERE id = s2) = 19 * 4200 + 140 * 1200 + 50 * 1700, 'amount untouched');

  -- Running it again changes nothing.
  n := public._restore_corrected_jug_types();
  PERFORM pg_temp.check(n = 0 AND pg_temp.owed() = 0, 'second run: nothing to do');

  -- Reversing the repaired posting later still nets every jug entry to nothing.
  PERFORM public._reverse_posted_sale(s2, 'test reversal');
  PERFORM pg_temp.check(pg_temp.owed() = 0, 'after reversal nothing owed, got ' || pg_temp.owed());
  PERFORM pg_temp.check((SELECT COALESCE(sum(CASE WHEN to_type = 'external' THEN quantity WHEN from_type = 'external' THEN -quantity END), 0)
                           FROM container_movements WHERE sale_id = s2) = 0, 'sold jugs undone with the sale');
END $$;

-- @@ Test 3: a line whose type can't be told is left alone and listed
DO $$
DECLARE s uuid; n int;
  w uuid := 'b7600000-0000-0000-0000-000000000001';
BEGIN
  s := pg_temp.post(jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 5, 'unit_price', 1000)),
                    'Correction of NO-SUCH-INVOICE: test');
  n := public._restore_corrected_jug_types();
  PERFORM pg_temp.check(n = 0, 'nothing repaired');
  PERFORM pg_temp.check((SELECT jar_mode FROM sale_items WHERE sale_id = s) IS NULL, 'type left as it is');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public._jug_type_repair_20261112 x
                                 JOIN sale_items si ON si.id = x.sale_item_id
                                WHERE si.sale_id = s AND x.type_set IS NULL), 'listed as unchanged');
END $$;

-- @@ Test 4: Emeka Orji -- a 1,200 line the first repair took as Jug + Water is Dispenser Water
DO $$
DECLARE s uuid; it uuid; n int;
  w uuid := 'b7600000-0000-0000-0000-000000000001';
BEGIN
  s := pg_temp.post(jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 7, 'unit_price', 1200, 'jar_mode', 'swap')));
  it := (SELECT id FROM sale_items WHERE sale_id = s);
  -- What the first repair (20261112110000) left on the live system.
  UPDATE sale_items SET jar_mode = 'permanent', jar_unit_price = 3000 WHERE id = it;
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, sale_id, product_id, notes)
  VALUES ('f7600000-0000-0000-0000-000000000001', 'e7600000-0000-0000-0000-000000000001', 'warehouse', NULL,
          'external', NULL, 7, 'jar_sold', (SELECT invoice_number FROM sales WHERE id = s), s, w, 'Jar sold with the water');
  PERFORM pg_temp.check(pg_temp.lines(s) = 'Jug + Water 7 @ 1200', 'as on the live list: ' || pg_temp.lines(s));

  n := public._fix_sale_types_by_price();
  PERFORM pg_temp.check(n >= 1, 'put right');
  PERFORM pg_temp.check(pg_temp.lines(s) = 'Dispenser Water 7 @ 1200', 'now: ' || pg_temp.lines(s));
  PERFORM pg_temp.check((SELECT jar_mode FROM sale_items WHERE id = it) = 'swap', 'empty handed in');
  PERFORM pg_temp.check((SELECT COALESCE(sum(CASE WHEN to_type = 'external' THEN quantity WHEN from_type = 'external' THEN -quantity END), 0)
                           FROM container_movements WHERE sale_id = s) = 0, 'jug sale taken back');
  PERFORM pg_temp.check(pg_temp.owed() = 5, 'only Test 3''s 5 still owed, got ' || pg_temp.owed());
  PERFORM pg_temp.check(public._fix_sale_types_by_price() = 0, 'second run: nothing to do');
END $$;

-- @@ Test 5: from now on the price decides the type of every new line
DO $$
DECLARE s uuid; v jsonb; s2 uuid;
  w uuid := 'b7600000-0000-0000-0000-000000000001'; e uuid := 'b7600000-0000-0000-0000-000000000002';
BEGIN
  UPDATE products SET current_stock = 50 WHERE id = e;
  -- 4,200 typed on a line chosen as Dispenser Water / with no type -> Jug + Water;
  -- 1,200 stays Dispenser Water; Empty Jug stays Empty Jug at 3,000.
  s := pg_temp.post(jsonb_build_array(
         jsonb_build_object('product_id', w, 'quantity', 3, 'unit_price', 4200, 'jar_mode', 'swap'),
         jsonb_build_object('product_id', w, 'quantity', 4, 'unit_price', 4200),
         jsonb_build_object('product_id', w, 'quantity', 5, 'unit_price', 1200, 'jar_mode', 'swap'),
         jsonb_build_object('product_id', e, 'quantity', 2, 'unit_price', 3000)));
  PERFORM pg_temp.check(pg_temp.lines(s) = 'Jug + Water 3 @ 4200; Jug + Water 4 @ 4200; Empty Jug 2 @ 3000; Dispenser Water 5 @ 1200',
                        'typed by price: ' || pg_temp.lines(s));
  PERFORM pg_temp.check(pg_temp.owed() = 5, 'no new jugs owed (bought or swapped), got ' || pg_temp.owed());
  -- Correcting Jug + Water down to 1,200 with the old window makes it Dispenser Water.
  v := public.correct_warehouse_posting(s, jsonb_build_object('reason', 'price', 'items', jsonb_build_array(
         jsonb_build_object('product_id', w, 'quantity', 7, 'unit_price', 1200))));
  s2 := (v->>'sale_id')::uuid;
  PERFORM pg_temp.check(pg_temp.lines(s2) = 'Dispenser Water 7 @ 1200', 'corrected: ' || pg_temp.lines(s2));
  -- The Accountant's window and the invoice lines say the same.
  PERFORM pg_temp.check((SELECT string_agg(x.product_name || ' ' || x.quantity::int || ' @ ' || x.unit_price::int, '; ')
                           FROM public.party_postings_and_returns('f7600000-0000-0000-0000-000000000001', NULL, 'CJT Medix') x
                          WHERE x.id = s2) = 'Dispenser Water 7 @ 1200', 'Accounts window');
  PERFORM pg_temp.check((SELECT string_agg(l.product_name, '; ') FROM public.sale_invoice_lines(ARRAY[s2]) l) = 'Dispenser Water',
                        'printed invoice');
END $$;

-- @@ Test 6: the user's example -- 140 Jug + Water and 50 Dispenser Water print as exactly that
DO $$
DECLARE s uuid; lines text;
  w uuid := 'b7600000-0000-0000-0000-000000000001';
BEGIN
  UPDATE products SET current_stock = 1000 WHERE id = w;
  s := pg_temp.post(jsonb_build_array(
         jsonb_build_object('product_id', w, 'quantity', 140, 'jar_mode', 'permanent'),
         jsonb_build_object('product_id', w, 'quantity', 50, 'unit_price', 1200, 'jar_mode', 'swap')));
  -- What the printed invoice reads (sale_invoice_lines).
  lines := (SELECT string_agg(l.product_name || ' x ' || l.quantity::int || ' @ ' || l.unit_price::int, '; '
                              ORDER BY l.unit_price DESC)
              FROM public.sale_invoice_lines(ARRAY[s]) l);
  PERFORM pg_temp.check(lines = 'Jug + Water x 140 @ 4200; Dispenser Water x 50 @ 1200', 'invoice: ' || lines);
  -- What the Accountant's window lists.
  lines := (SELECT string_agg(x.product_name || ' x ' || x.quantity::int || ' @ ' || x.unit_price::int, '; '
                              ORDER BY x.unit_price DESC)
              FROM public.party_postings_and_returns('f7600000-0000-0000-0000-000000000001', NULL, 'CJT Medix') x
             WHERE x.id = s);
  PERFORM pg_temp.check(lines = 'Jug + Water x 140 @ 4200; Dispenser Water x 50 @ 1200', 'Accounts: ' || lines);
  PERFORM pg_temp.check((SELECT grand_total FROM sales WHERE id = s) = 140 * 4200 + 50 * 1200, 'total 648,000');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = w) = 1000 - 190, 'both from the one dispenser stock');
END $$;
