-- ============================================================================
-- Acceptance tests: Retail Shop receives a payment after the sale
-- (20261030110000_retail_receive_payment.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. "RRP Shop" holds 50 packs at 2,000.
--   * A walk-in buys 10 packs (20,000) and pays 5,000 at the till. Later the
--     shop's own staff (sales role, no Finance rights) receive 15,000 cash:
--     the sale is paid, the payment is stamped as collected by the shop, and
--     the day close expects 20,000 cash while credit sales stay 15,000.
--   * The same staff cannot take payment on a Warehouse (non-shop) sale.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('ad100000-0000-0000-0000-000000000001', 'admin@rrp'),
  ('ad100000-0000-0000-0000-000000000002', 'shop@rrp');
DELETE FROM user_roles WHERE user_id IN ('ad100000-0000-0000-0000-000000000001', 'ad100000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('ad100000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'ad100000-0000-0000-0000-000000000002', 'sales', id FROM factories WHERE code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT 'ae100000-0000-0000-0000-000000000001', id, 'RRP 50cl Bottle Water', 'Pack', 'finished', true, 100, 2000
  FROM factories WHERE code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'ae100000-0000-0000-0000-000000000002', id, 'RRP Shop', 'active', 'outlet' FROM factories WHERE code = 'water';
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
SELECT 'ae100000-0000-0000-0000-000000000002', 'ae100000-0000-0000-0000-000000000001', id, 50 FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the shop's staff receive the rest of a part-paid walk-in sale; the day close expects it
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r jsonb; sale uuid; s record; fig jsonb;
BEGIN
  PERFORM set_config('test.uid', 'ad100000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(NOT public.has_permission('ad100000-0000-0000-0000-000000000002'::uuid, 'payments'::module_key, 'write'::action_key)
                        AND NOT public.has_permission('ad100000-0000-0000-0000-000000000002'::uuid, 'debts'::module_key, 'write'::action_key)
                        AND public.has_permission('ad100000-0000-0000-0000-000000000002'::uuid, 'sales'::module_key, 'write'::action_key),
                        'shop staff: sales rights only');
  PERFORM set_config('test.uid', 'ad100000-0000-0000-0000-000000000002', false);
  r := public.create_sale(jsonb_build_object('factory_id', f,
    'sales_rep_id', 'ae100000-0000-0000-0000-000000000002', 'customer_name', 'Walk-in',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'ae100000-0000-0000-0000-000000000001', 'quantity', 10)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 5000, 'method', 'cash'))));
  sale := (r->>'sale_id')::uuid;
  SELECT * INTO s FROM sales WHERE id = sale;
  PERFORM pg_temp.check(s.status = 'posted' AND s.balance = 15000, 'posted, owes 15,000: ' || row_to_json(s)::text);

  r := public.record_payment(jsonb_build_object('factory_id', f, 'sale_id', sale,
    'payments', jsonb_build_array(jsonb_build_object('amount', 15000, 'method', 'cash')), 'remarks', 'Paid later'));
  SELECT * INTO s FROM sales WHERE id = sale;
  PERFORM pg_temp.check(s.balance = 0 AND s.amount_paid = 20000, 'sale paid in full: ' || row_to_json(s)::text);
  PERFORM pg_temp.check((SELECT collected_by_rep FROM payments_received WHERE sale_id = sale AND NOT at_point_of_sale)
                        = 'ae100000-0000-0000-0000-000000000002', 'collected by the shop');

  fig := public._outlet_day_figures('ae100000-0000-0000-0000-000000000002', CURRENT_DATE);
  PERFORM pg_temp.check((fig->'money'->>'cash_expected')::numeric = 20000
                        AND (fig->'money'->>'collections_cash')::numeric = 15000
                        AND (fig->'money'->>'credit_sales')::numeric = 15000
                        AND (fig->'money'->'by_method'->>'cash')::numeric = 20000,
                        'day close expects 20,000 cash: ' || (fig->'money')::text);
  -- the next day, the money not yet handed over is still the shop's
  fig := public._outlet_day_figures('ae100000-0000-0000-0000-000000000002', CURRENT_DATE + 1);
  PERFORM pg_temp.check((fig->>'unremitted_before')::numeric = 20000, 'held from earlier: ' || (fig->>'unremitted_before'));
END $$;

-- @@ Test 2: shop staff cannot take payment on a sale that is not the shop's
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r jsonb; sale uuid; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'ad100000-0000-0000-0000-000000000001', false);
  r := public.create_sale(jsonb_build_object('factory_id', f, 'customer_name', 'Walk-in',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'ae100000-0000-0000-0000-000000000001', 'quantity', 1))));
  sale := (r->>'sale_id')::uuid;
  IF (SELECT status FROM sales WHERE id = sale) <> 'posted' THEN
    PERFORM public.approve_sale(sale);
  END IF;
  PERFORM set_config('test.uid', 'ad100000-0000-0000-0000-000000000002', false);
  BEGIN
    PERFORM public.record_payment(jsonb_build_object('factory_id', f, 'sale_id', sale,
      'payments', jsonb_build_array(jsonb_build_object('amount', 1000, 'method', 'cash'))));
  EXCEPTION WHEN OTHERS THEN
    ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM pg_temp.check(ok, 'refused on a Warehouse sale');
END $$;
