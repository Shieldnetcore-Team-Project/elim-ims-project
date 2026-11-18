-- ============================================================================
-- Acceptance tests: 20261117150000_shop_product_return.sql
--   Retail Outlet -> Return Product: a customer hands back a product (any
--   product, picked from a dropdown, no invoice); it goes back into the
--   shop's stock and its value comes off the day's cash expected.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f1171000-0000-0000-0000-000000000001', 'sprfac', 'SPR Factory');
INSERT INTO auth.users(id, email) VALUES ('a1171000-0000-0000-0000-000000000001', 'shop@spr');
DELETE FROM user_roles WHERE user_id = 'a1171000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a1171000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b1171000-0000-0000-0000-000000000001', 'f1171000-0000-0000-0000-000000000001', 'SPR 35cl Bottle Water', 'Pack', 1500, 0, 'finished'),
  ('b1171000-0000-0000-0000-000000000002', 'f1171000-0000-0000-0000-000000000001', 'SPR Sachet Water', 'Bag', 300, 0, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c1171000-0000-0000-0000-000000000001', 'f1171000-0000-0000-0000-000000000001', 'SPR Shop', 'active', 'outlet'),
  ('c1171000-0000-0000-0000-000000000002', 'f1171000-0000-0000-0000-000000000001', 'SPR Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a1171000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: 2 packs of 35cl back -> shop stock +2, 3,000 off today's cash
DO $$
DECLARE
  r jsonb;
  before jsonb;
  after jsonb;
BEGIN
  before := public._outlet_day_figures('c1171000-0000-0000-0000-000000000001', public._lagos_today())->'money';
  r := public.record_shop_product_return(jsonb_build_object(
    'outlet_id', 'c1171000-0000-0000-0000-000000000001', 'reason', 'changed for 50cl',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b1171000-0000-0000-0000-000000000001', 'quantity', 2))));
  PERFORM pg_temp.check((r->>'refund')::numeric = 3000, 'refund = 2 x 1,500');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'c1171000-0000-0000-0000-000000000001'
                           AND product_id = 'b1171000-0000-0000-0000-000000000001') = 2, 'shop stock +2');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM rep_stock_movements WHERE reference = r->>'return_number'
                                   AND movement_type = 'reversal' AND quantity = 2), 'ledger line');
  after := public._outlet_day_figures('c1171000-0000-0000-0000-000000000001', public._lagos_today())->'money';
  PERFORM pg_temp.check((after->>'cash_expected')::numeric = (before->>'cash_expected')::numeric - 3000, 'cash expected -3,000');
  PERFORM pg_temp.check((after->>'refunds_cash')::numeric = 3000, 'refunds_cash');
END $$;

-- @@ Test 2: value typed by hand, by transfer, two products
DO $$
DECLARE r jsonb;
BEGIN
  r := public.record_shop_product_return(jsonb_build_object(
    'outlet_id', 'c1171000-0000-0000-0000-000000000001', 'refund_method', 'transfer',
    'items', jsonb_build_array(
      jsonb_build_object('product_id', 'b1171000-0000-0000-0000-000000000001', 'quantity', 1, 'value', 1400),
      jsonb_build_object('product_id', 'b1171000-0000-0000-0000-000000000002', 'quantity', 3))));
  PERFORM pg_temp.check((r->>'refund')::numeric = 2300, 'refund = 1,400 + 900');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM sales_returns WHERE return_number LIKE (r->>'return_number') || '-%'
                           AND refund_method = 'transfer' AND sale_id IS NULL) = 2, 'two rows, by transfer');
END $$;

-- @@ Test 3: refused -- a marketer, nothing entered, the future
DO $$
DECLARE ok boolean;
BEGIN
  BEGIN
    PERFORM public.record_shop_product_return(jsonb_build_object('outlet_id', 'c1171000-0000-0000-0000-000000000002',
      'items', jsonb_build_array(jsonb_build_object('product_id', 'b1171000-0000-0000-0000-000000000001', 'quantity', 1))));
    ok := false;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Retail Shop%';
  END;
  PERFORM pg_temp.check(ok, 'marketer refused');
  BEGIN
    PERFORM public.record_shop_product_return(jsonb_build_object('outlet_id', 'c1171000-0000-0000-0000-000000000001',
      'items', '[]'::jsonb));
    ok := false;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%how many%';
  END;
  PERFORM pg_temp.check(ok, 'empty refused');
  BEGIN
    PERFORM public.record_shop_product_return(jsonb_build_object('outlet_id', 'c1171000-0000-0000-0000-000000000001',
      'return_date', public._lagos_today() + 1,
      'items', jsonb_build_array(jsonb_build_object('product_id', 'b1171000-0000-0000-0000-000000000001', 'quantity', 1))));
    ok := false;
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%future%';
  END;
  PERFORM pg_temp.check(ok, 'future refused');
END $$;
