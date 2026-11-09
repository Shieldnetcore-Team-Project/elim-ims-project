-- ============================================================================
-- Acceptance tests: 20261109160000_accounts_see_customer_returns.sql
--   What a distributor returns to the Warehouse reaches Accounts, one row per
--   return; a return on a marketer's sale stays on the marketer's account.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7600000-0000-0000-0000-000000000001', 'acrfac', 'ACR Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a7600000-0000-0000-0000-000000000001', 'admin@acr'),
  ('a7600000-0000-0000-0000-000000000002', 'nobody@acr');
INSERT INTO user_roles(user_id, role) VALUES ('a7600000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO roles(slug, label, is_system) VALUES ('acr_none_test', 'No rights (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a7600000-0000-0000-0000-000000000002', 'acr_none_test', 'f7600000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7600000-0000-0000-0000-000000000001', 'f7600000-0000-0000-0000-000000000001', '50cl Bottle Water', 'Pack', 1000, 100, 'finished'),
  ('b7600000-0000-0000-0000-000000000002', 'f7600000-0000-0000-0000-000000000001', 'Sachet Water', 'Bag', 300, 100, 'finished');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d7600000-0000-0000-0000-000000000001', 'f7600000-0000-0000-0000-000000000001', 'FICO', true),
  ('d7600000-0000-0000-0000-000000000002', 'f7600000-0000-0000-0000-000000000001', 'Other Office', true);
SELECT set_config('test.uid', 'a7600000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: a distributor's return reaches Accounts as one row with its products and value
DO $$
DECLARE f uuid := 'f7600000-0000-0000-0000-000000000001'; c uuid := 'd7600000-0000-0000-0000-000000000001';
  a uuid := 'b7600000-0000-0000-0000-000000000001'; b uuid := 'b7600000-0000-0000-0000-000000000002';
  s jsonb; r jsonb; x record; n int;
BEGIN
  s := public.create_sale(jsonb_build_object('factory_id', f, 'customer_id', c, 'customer_name', 'FICO', 'amount_paid', 0,
    'items', jsonb_build_array(jsonb_build_object('product_id', a, 'quantity', 10),
                               jsonb_build_object('product_id', b, 'quantity', 10))));
  IF s->>'status' = 'pending_approval' THEN PERFORM public._post_sale((s->>'sale_id')::uuid, 'test'); END IF;
  r := public.warehouse_receive_customer_return(jsonb_build_object('customer_id', c, 'all_products', true,
    'items', jsonb_build_array(jsonb_build_object('product_id', a, 'quantity', 2),
                               jsonb_build_object('product_id', b, 'quantity', 3))));

  SELECT count(*) INTO n FROM public.accounting_customer_returns(f);
  PERFORM pg_temp.check(n = 1, format('one row for the return, got %s', n));
  SELECT * INTO x FROM public.accounting_customer_returns(f);
  PERFORM pg_temp.check(x.return_number = r->>'return_number', 'number: ' || x.return_number || ' vs ' || (r->>'return_number'));
  PERFORM pg_temp.check(x.customer = 'FICO', 'customer: ' || x.customer);
  PERFORM pg_temp.check(x.value = 2 * 1000 + 3 * 300, format('value %s', x.value));
  PERFORM pg_temp.check(x.debt_reduced = 2900 AND x.credit_added = 0, format('off debt %s, credit %s', x.debt_reduced, x.credit_added));
  PERFORM pg_temp.check(x.items LIKE '%50cl Bottle Water × 2 Pack%' AND x.items LIKE '%Sachet Water × 3 Bag%', 'items: ' || x.items);
END $$;

-- @@ Test 2: filters by customer and date
DO $$
DECLARE f uuid := 'f7600000-0000-0000-0000-000000000001'; n int; d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  SELECT count(*) INTO n FROM public.accounting_customer_returns(f, NULL, NULL, 'd7600000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(n = 1, 'FICO has it');
  SELECT count(*) INTO n FROM public.accounting_customer_returns(f, NULL, NULL, 'd7600000-0000-0000-0000-000000000002');
  PERFORM pg_temp.check(n = 0, 'nobody else does');
  SELECT count(*) INTO n FROM public.accounting_customer_returns(f, d, d);
  PERFORM pg_temp.check(n = 1, 'on the day');
  SELECT count(*) INTO n FROM public.accounting_customer_returns(f, d - 5, d - 1);
  PERFORM pg_temp.check(n = 0, 'not before it');
END $$;

-- @@ Test 3: someone without Accounts or Warehouse rights is refused
DO $$
DECLARE ok boolean := false; n int;
BEGIN
  PERFORM set_config('test.uid', 'a7600000-0000-0000-0000-000000000002', false);
  BEGIN
    SELECT count(*) INTO n FROM public.accounting_customer_returns('f7600000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%'; END;
  PERFORM set_config('test.uid', 'a7600000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(ok, 'refused');
END $$;
