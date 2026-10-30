-- ============================================================================
-- Acceptance tests: warehouse_activity (20261030130000_warehouse_activity_by_date.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A direct sale and a stock correction made
-- today list on today, with who made them, and not on yesterday.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('b0100000-0000-0000-0000-000000000001', 'wh@wa');
INSERT INTO profiles(id, email, full_name) VALUES ('b0100000-0000-0000-0000-000000000001', 'wh@wa', 'Gift Warehouse')
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
DELETE FROM user_roles WHERE user_id = 'b0100000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('b0100000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT 'b0100000-0000-0000-0000-0000000000a1', id, 'WA 50cl', 'Pack', 'finished', true, 100, 2650 FROM factories WHERE code = 'water';

-- @@ Test 1: a sale and a stock correction today show with who did them; yesterday's range is empty of them
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r jsonb; n int; today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  PERFORM set_config('test.uid', 'b0100000-0000-0000-0000-000000000001', false);
  r := public.create_sale(jsonb_build_object('factory_id', f, 'customer_name', 'Walk-in',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b0100000-0000-0000-0000-0000000000a1', 'quantity', 3))));
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (f, 'b0100000-0000-0000-0000-0000000000a1', 'adjusted', -5, 'WA-COUNT', 'count', 'b0100000-0000-0000-0000-000000000001', 100, 95);

  n := (SELECT count(*) FROM public.warehouse_activity(f, today, today) w
         WHERE (w.reference = r->>'invoice_number' AND w.kind = 'sale' AND w.posted_by = 'Gift Warehouse')
            OR (w.reference = 'WA-COUNT' AND w.kind = 'adjusted' AND w.items = 'WA 50cl -5' AND w.posted_by = 'Gift Warehouse'));
  IF n <> 2 THEN RAISE EXCEPTION 'ASSERTION FAILED: today rows %', n; END IF;
  n := (SELECT count(*) FROM public.warehouse_activity(f, today - 1, today - 1) w
         WHERE w.reference IN (r->>'invoice_number', 'WA-COUNT'));
  IF n <> 0 THEN RAISE EXCEPTION 'ASSERTION FAILED: yesterday shows today''s rows'; END IF;
END $$;
