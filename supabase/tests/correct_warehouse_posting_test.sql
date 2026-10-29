-- ============================================================================
-- Acceptance tests: the Warehouse corrects a posting to a distributor
-- (20261029170000_correct_warehouse_posting.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('7b000000-0000-0000-0000-000000000001', 'boss@whcorr');
INSERT INTO profiles(id, email, full_name)
SELECT '7b000000-0000-0000-0000-000000000001', 'boss@whcorr', 'Boss'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '7b000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '7b000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('7b000000-0000-0000-0000-000000000001', 'super_admin', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('7e000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'WHC 50cl', 'Pack', 2650, 100, 'finished'),
  ('7e000000-0000-0000-0000-000000000002', (SELECT id FROM factories WHERE code = 'water'), 'WHC 75cl', 'Pack', 1700, 100, 'finished');
INSERT INTO customers(id, factory_id, name, phone, registered) VALUES
  ('7f000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'WHC Distributor', '08000007101', true);

SELECT set_config('test.uid', '7b000000-0000-0000-0000-000000000001', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p uuid) RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM products WHERE id = p $$;

-- @@ Test 1: 30 x 50cl posted (10,000 paid) corrected to 20 x 50cl + 5 x 75cl
DO $$
DECLARE v jsonb; c jsonb; s sales%ROWTYPE; cust customers%ROWTYPE;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p50 uuid := '7e000000-0000-0000-0000-000000000001';
  p75 uuid := '7e000000-0000-0000-0000-000000000002';
BEGIN
  v := public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', '7f000000-0000-0000-0000-000000000001',
         'customer_name', 'WHC Distributor',
         'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10000)),
         'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 30, 'unit_price', 2650))));
  PERFORM pg_temp.check(v->>'status' = 'posted' AND pg_temp.stock(p50) = 70, 'posted: ' || v::text);

  c := public.correct_warehouse_posting((v->>'sale_id')::uuid, jsonb_build_object(
         'reason', 'typed 30 instead of 20, forgot 75cl',
         'items', jsonb_build_array(
           jsonb_build_object('product_id', p50, 'quantity', 20, 'unit_price', 2650),
           jsonb_build_object('product_id', p75, 'quantity', 5, 'unit_price', 1700))));
  PERFORM pg_temp.check(c->>'status' = 'posted' AND c->>'replaced' = v->>'invoice_number', 'reposted: ' || c::text);
  PERFORM pg_temp.check(pg_temp.stock(p50) = 80 AND pg_temp.stock(p75) = 95, 'stock follows the correction');
  PERFORM pg_temp.check((SELECT deleted_at IS NOT NULL FROM sales WHERE id = (v->>'sale_id')::uuid), 'old one gone');

  -- The 10,000 paid on the old one is applied to the new one.
  SELECT * INTO s FROM sales WHERE id = (c->>'sale_id')::uuid;
  PERFORM pg_temp.check(s.grand_total = 61500 AND s.credit_applied = 10000 AND s.balance = 51500,
                        format('new invoice: total %s credit %s balance %s', s.grand_total, s.credit_applied, s.balance));
  SELECT * INTO cust FROM customers WHERE id = '7f000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(cust.credit_balance = 0 AND cust.outstanding_balance = 51500,
                        format('account: credit %s owing %s', cust.credit_balance, cust.outstanding_balance));
END $$;

-- @@ Test 2: refused without a reason, for more than is in stock (nothing changes), and for walk-ins
DO $$
DECLARE v jsonb; e text; w jsonb;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p50 uuid := '7e000000-0000-0000-0000-000000000001';
BEGIN
  v := public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', '7f000000-0000-0000-0000-000000000001',
         'customer_name', 'WHC Distributor',
         'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 10, 'unit_price', 2650))));
  BEGIN
    PERFORM public.correct_warehouse_posting((v->>'sale_id')::uuid, jsonb_build_object('reason', ' ',
      'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 5))));
  EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
  PERFORM pg_temp.check(e LIKE '%what was wrong%', 'reason: ' || COALESCE(e, 'none'));

  e := NULL;
  BEGIN
    PERFORM public.correct_warehouse_posting((v->>'sale_id')::uuid, jsonb_build_object('reason', 'more',
      'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 5000))));
  EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
  PERFORM pg_temp.check(e LIKE '%Insufficient stock%', 'stock: ' || COALESCE(e, 'none'));
  PERFORM pg_temp.check(pg_temp.stock(p50) = 70 AND (SELECT deleted_at IS NULL FROM sales WHERE id = (v->>'sale_id')::uuid),
                        'nothing changed after a refusal');

  w := public.create_sale(jsonb_build_object('factory_id', f, 'customer_name', 'Walk In',
         'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 1, 'unit_price', 2650))));
  e := NULL;
  BEGIN
    PERFORM public.correct_warehouse_posting((w->>'sale_id')::uuid, jsonb_build_object('reason', 'x',
      'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 1))));
  EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
  PERFORM pg_temp.check(e LIKE '%isn''t a Warehouse posting%', 'walk-in: ' || COALESCE(e, 'none'));
END $$;
