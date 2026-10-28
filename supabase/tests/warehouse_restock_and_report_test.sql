-- ============================================================================
-- Acceptance tests: Warehouse restock and products report
-- (20261028130000_warehouse_restock_and_products_report.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Uses its own factory, products and
-- marketer; ledger lines are dated in the report period by hand.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f6000000-0000-0000-0000-000000000001', 'wrpt', 'Report Factory');
INSERT INTO auth.users(id, email) VALUES ('a6000000-0000-0000-0000-000000000001', 'admin@wrpt');
DELETE FROM user_roles WHERE user_id = 'a6000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a6000000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO product_categories(id, factory_id, name) VALUES
  ('e6000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', 'Bottle Water');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type, category_id) VALUES
  ('b6000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', '35cl Bottle Water', 'Pack', 2550, 1057, 'finished', 'e6000000-0000-0000-0000-000000000001'),
  ('b6000000-0000-0000-0000-000000000002', 'f6000000-0000-0000-0000-000000000001', 'Sachet Water', 'Bag', 350, 62, 'finished', NULL),
  ('b6000000-0000-0000-0000-000000000003', 'f6000000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1000, 1, 'finished', NULL),
  ('b6000000-0000-0000-0000-000000000004', 'f6000000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 1500, 100, 'finished', NULL);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c6000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', 'Report Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a6000000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: restock Sachet Water; Bottle Water refused
DO $$
DECLARE f uuid := 'f6000000-0000-0000-0000-000000000001'; ok boolean := false; r jsonb;
BEGIN
  r := public.warehouse_restock(jsonb_build_object('factory_id', f, 'product_id', 'b6000000-0000-0000-0000-000000000002',
                                                   'quantity', 5661, 'notes', 'From sachet line'));
  PERFORM pg_temp.check((r->>'stock')::numeric = 5723, 'sachet 62 + 5661');
  BEGIN
    PERFORM public.warehouse_restock(jsonb_build_object('factory_id', f, 'product_id', 'b6000000-0000-0000-0000-000000000001', 'quantity', 10));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%comes from Production%';
  END;
  PERFORM pg_temp.check(ok, 'bottle water refused');
END $$;

-- @@ Test 2: report columns add up like the factory sheet
DO $$
DECLARE f uuid := 'f6000000-0000-0000-0000-000000000001'; r record; d jsonb; v jsonb;
  p35 uuid := 'b6000000-0000-0000-0000-000000000001'; sachet uuid := 'b6000000-0000-0000-0000-000000000002';
  disp uuid := 'b6000000-0000-0000-0000-000000000003'; jug uuid := 'b6000000-0000-0000-0000-000000000004';
  rep uuid := 'c6000000-0000-0000-0000-000000000001';
BEGIN
  -- 35cl: 577 in from Production, 433 posted out, 1 returned -> 1202.
  UPDATE products SET current_stock = current_stock + 577 WHERE id = p35;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, quantity_before, quantity_after)
  VALUES (f, p35, 'produced', 577, 'REL-T', 'Production release accepted by Warehouse', 1057, 1634);
  d := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', rep,
         'items', jsonb_build_array(jsonb_build_object('product_id', p35, 'quantity', 433))));
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', rep,
            'items', jsonb_build_array(jsonb_build_object('product_id', p35, 'quantity_returned', 1))));
  -- A posting made by mistake and reversed: not out, not a return.
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', rep,
         'items', jsonb_build_array(jsonb_build_object('product_id', p35, 'quantity', 50))));
  PERFORM public.reverse_stock_dispatch((v->>'id')::uuid, 'wrong figure');
  -- Sachet: 5686 out, 37 as a Chairman's gift (issued) -> 0.
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', rep,
         'items', jsonb_build_array(jsonb_build_object('product_id', sachet, 'quantity', 5686))));
  UPDATE products SET current_stock = current_stock - 37 WHERE id = sachet;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, quantity_before, quantity_after)
  VALUES (f, sachet, 'issued', 37, 'GFT-T', 'Chairman''s gift', 37, 0);
  -- Empty jugs: 53 out, shown on the Dispenser row.
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', rep,
         'items', jsonb_build_array(jsonb_build_object('product_id', jug, 'quantity', 53))));

  SELECT * INTO r FROM public.warehouse_products_report(f, CURRENT_DATE, CURRENT_DATE) WHERE product_id = p35;
  PERFORM pg_temp.check(r.opening = 1057 AND r.qty_in = 577 AND r.qty_out = 433 AND r.returned = 1
                        AND r.sold = 432 AND r.gift = 0 AND r.balance = 1202,
                        format('35cl row: %s', to_jsonb(r)));
  SELECT * INTO r FROM public.warehouse_products_report(f, CURRENT_DATE, CURRENT_DATE) WHERE product_id = sachet;
  PERFORM pg_temp.check(r.opening = 62 AND r.qty_in = 5661 AND r.qty_out = 5686 AND r.gift = 37 AND r.balance = 0,
                        format('sachet row: %s', to_jsonb(r)));
  SELECT * INTO r FROM public.warehouse_products_report(f, CURRENT_DATE, CURRENT_DATE) WHERE product_id = disp;
  PERFORM pg_temp.check(r.empty_jug_sold = 53, format('dispenser row: %s', to_jsonb(r)));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.warehouse_products_report(f, CURRENT_DATE, CURRENT_DATE)
                                     WHERE product_id = jug), 'no Empty Jug row');
  -- Yesterday: nothing moved, opening = balance = stock before today.
  SELECT * INTO r FROM public.warehouse_products_report(f, CURRENT_DATE - 1, CURRENT_DATE - 1) WHERE product_id = p35;
  PERFORM pg_temp.check(r.opening = 1057 AND r.balance = 1057 AND r.qty_out = 0, format('yesterday: %s', to_jsonb(r)));
END $$;
