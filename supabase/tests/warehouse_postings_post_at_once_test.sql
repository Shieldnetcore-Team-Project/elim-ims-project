-- ============================================================================
-- Acceptance tests: Warehouse postings to distributors take stock out at once
-- (20261029140000_warehouse_postings_post_at_once.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('7a000000-0000-0000-0000-000000000001', 'boss@whpost');
INSERT INTO profiles(id, email, full_name)
SELECT '7a000000-0000-0000-0000-000000000001', 'boss@whpost', 'Boss'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '7a000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '7a000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('7a000000-0000-0000-0000-000000000001', 'super_admin', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('7d000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'WHP Sachet', 'Bag', 300, 100, 'finished');
INSERT INTO customers(id, factory_id, name, phone, registered) VALUES
  ('7c000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'WHP Distributor', '08000007001', true);

SELECT set_config('test.uid', '7a000000-0000-0000-0000-000000000001', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: posting to a distributor is posted at once; Accounts confirms afterwards
DO $$
DECLARE v jsonb; n0 int; n1 int;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '7d000000-0000-0000-0000-000000000001';
BEGIN
  n0 := public.warehouse_postings_to_confirm();
  v := public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', '7c000000-0000-0000-0000-000000000001',
         'customer_name', 'WHP Distributor', 'amount_paid', 0,
         'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 30, 'unit_price', 300))));
  PERFORM pg_temp.check(v->>'status' = 'posted', 'posted at once: ' || v::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = p) = 70, 'stock out at once');
  PERFORM pg_temp.check((SELECT status::text FROM sales WHERE id = (v->>'sale_id')::uuid) = 'posted', 'sale posted');
  n1 := public.warehouse_postings_to_confirm();
  PERFORM pg_temp.check(n1 = n0 + 1, format('waits on Accounts: %s -> %s', n0, n1));

  -- Accounts confirms it later: a check only, stock unchanged.
  PERFORM public.assess_posting('sale', (v->>'sale_id')::uuid, 'Payment confirmed');
  PERFORM pg_temp.check(public.warehouse_postings_to_confirm() = n0, 'no longer waiting');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = p) = 70, 'stock unchanged by confirm');
END $$;

-- @@ Test 2: a walk-in sale (not a Warehouse posting) still waits for approval
DO $$
DECLARE v jsonb;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '7d000000-0000-0000-0000-000000000001';
BEGIN
  v := public.create_sale(jsonb_build_object('factory_id', f, 'customer_name', 'Walk In Person',
         'items', jsonb_build_array(jsonb_build_object('product_id', p, 'quantity', 5, 'unit_price', 300))));
  PERFORM pg_temp.check(v->>'status' = 'pending_approval', 'walk-in pending: ' || v::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = p) = 70, 'walk-in stock not moved yet');
END $$;
