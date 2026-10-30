-- ============================================================================
-- Acceptance tests: warehouse_products_report (20261030140000_warehouse_products_report.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. "WPR 75cl" holds 100 packs; today the
-- Warehouse sells 3, gives 2 away (PR) and corrects the count by +10.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('b0200000-0000-0000-0000-000000000001', 'wh@wpr');
DELETE FROM user_roles WHERE user_id = 'b0200000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('b0200000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT 'b0200000-0000-0000-0000-0000000000a1', id, 'WPR 75cl', 'Pack', 'finished', true, 100, 1700
  FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the day's columns, Balance = stock now, every row adds up, yesterday closes at today's opening
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r record; bad int; s jsonb;
        today date := (now() AT TIME ZONE 'Africa/Lagos')::date; y numeric;
BEGIN
  PERFORM set_config('test.uid', 'b0200000-0000-0000-0000-000000000001', false);
  s := public.create_sale(jsonb_build_object('factory_id', f, 'customer_name', 'Walk-in',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b0200000-0000-0000-0000-0000000000a1', 'quantity', 3)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 5100, 'method', 'cash'))));
  IF s->>'status' <> 'posted' THEN PERFORM public.approve_sale((s->>'sale_id')::uuid); END IF;
  s := public.create_sale(jsonb_build_object('factory_id', f, 'customer_name', 'Walk-in', 'is_pr', true,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b0200000-0000-0000-0000-0000000000a1', 'quantity', 2))));
  IF s->>'status' <> 'posted' THEN PERFORM public.approve_sale((s->>'sale_id')::uuid); END IF;
  UPDATE products SET current_stock = current_stock + 10 WHERE id = 'b0200000-0000-0000-0000-0000000000a1';
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  SELECT f, id, 'adjusted', 10, 'WPR-COUNT', 'count', 'b0200000-0000-0000-0000-000000000001', current_stock - 10, current_stock
    FROM products WHERE id = 'b0200000-0000-0000-0000-0000000000a1';

  SELECT * INTO r FROM public.warehouse_products_report(f, today) WHERE product_id = 'b0200000-0000-0000-0000-0000000000a1';
  PERFORM pg_temp.check(r.opening = 100 AND r.qty_in = 0 AND r.total = 100 AND r.qty_out = 3 AND r.gift = 2
                        AND r.returned = 0 AND r.adjusted = 10 AND r.balance = 105,
                        'report row: ' || row_to_json(r)::text);
  PERFORM pg_temp.check(r.balance = (SELECT current_stock FROM products WHERE id = 'b0200000-0000-0000-0000-0000000000a1'),
                        'balance is the stock now');
  bad := (SELECT count(*) FROM public.warehouse_products_report(f, today) x
           WHERE x.opening + x.qty_in - x.qty_out + x.returned - x.gift + x.adjusted <> x.balance);
  PERFORM pg_temp.check(bad = 0, bad || ' rows do not add up');
  y := (SELECT x.balance FROM public.warehouse_products_report(f, today - 1) x
         WHERE x.product_id = 'b0200000-0000-0000-0000-0000000000a1');
  PERFORM pg_temp.check(y = 100, 'yesterday closes at today''s opening: ' || y);
END $$;
