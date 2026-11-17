-- ============================================================================
-- Acceptance tests: 20261117100000_sales_report_by_party.sql
--   Every product and every party listed; marketer postings less returns;
--   Warehouse sales to distributors less returns; walk-ins as Direct Sales;
--   marketers' van sales and Retail Shop POS sales not counted.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7730000-0000-0000-0000-000000000001', 'srpfac', 'SRP Factory');
INSERT INTO auth.users(id, email) VALUES ('a7730000-0000-0000-0000-000000000001', 'admin@srp');
INSERT INTO user_roles(user_id, role) VALUES ('a7730000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7730000-0000-0000-0000-000000000001', 'f7730000-0000-0000-0000-000000000001', 'Bottle Water 75cl', 'Pack', 1500, 1000, 'finished'),
  ('b7730000-0000-0000-0000-000000000002', 'f7730000-0000-0000-0000-000000000001', 'Sachet Water', 'Bag', 300, 1000, 'finished'),
  ('b7730000-0000-0000-0000-000000000003', 'f7730000-0000-0000-0000-000000000001', 'Bottle Water 35cl', 'Pack', 900, 0, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, code, status, kind) VALUES
  ('c7730000-0000-0000-0000-000000000001', 'f7730000-0000-0000-0000-000000000001', 'SRP Marketer', 'M01', 'active', 'rep'),
  ('c7730000-0000-0000-0000-000000000002', 'f7730000-0000-0000-0000-000000000001', 'SRP Idle', 'M02', 'active', 'rep'),
  ('c7730000-0000-0000-0000-000000000003', 'f7730000-0000-0000-0000-000000000001', 'SRP Shop', 'SHOP', 'active', 'outlet');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d7730000-0000-0000-0000-000000000001', 'f7730000-0000-0000-0000-000000000001', 'SRP Distributor', true);
INSERT INTO customers(id, factory_id, name, registered, sales_rep_id) VALUES
  ('d7730000-0000-0000-0000-000000000002', 'f7730000-0000-0000-0000-000000000001', 'SRP Van Customer', true,
   'c7730000-0000-0000-0000-000000000001');
SELECT set_config('test.uid', 'a7730000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the sheet's columns and rows, quantities net of returns
DO $$
DECLARE f uuid := 'f7730000-0000-0000-0000-000000000001'; m uuid := 'c7730000-0000-0000-0000-000000000001';
  b uuid := 'b7730000-0000-0000-0000-000000000001'; s uuid := 'b7730000-0000-0000-0000-000000000002';
  c uuid := 'd7730000-0000-0000-0000-000000000001'; u uuid := 'a7730000-0000-0000-0000-000000000001';
  r record;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', b, 'quantity', 100),
                               jsonb_build_object('product_id', s, 'quantity', 50))));
  INSERT INTO rep_returns(id, factory_id, sales_rep_id, return_number, status, return_date, received_by)
  VALUES ('97730000-0000-0000-0000-000000000001', f, m, 'RR-SRP-1', 'completed', CURRENT_DATE, u);
  INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, accepted_quantity)
  VALUES ('97730000-0000-0000-0000-000000000001', b, 10, 10);

  INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, status, created_by) VALUES
    ('87730000-0000-0000-0000-000000000001', f, 'INV-SRP-1', CURRENT_DATE, c, 'SRP Distributor', 'pending_confirmation', u),
    ('87730000-0000-0000-0000-000000000002', f, 'INV-SRP-2', CURRENT_DATE, NULL, 'Mr Walk-in', 'posted', u);
  INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, sales_rep_id, status, created_by) VALUES
    ('87730000-0000-0000-0000-000000000003', f, 'INV-SRP-3', CURRENT_DATE, 'd7730000-0000-0000-0000-000000000002', m, 'posted', u),
    ('87730000-0000-0000-0000-000000000004', f, 'INV-SRP-4', CURRENT_DATE, NULL, 'c7730000-0000-0000-0000-000000000003', 'posted', u);
  INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total) VALUES
    ('87730000-0000-0000-0000-000000000001', b, 40, 1500, 60000),
    ('87730000-0000-0000-0000-000000000002', s, 3, 300, 900),
    ('87730000-0000-0000-0000-000000000003', b, 90, 1500, 135000),
    ('87730000-0000-0000-0000-000000000004', s, 5, 300, 1500);
  INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned,
                            status, accepted_quantity, received_by, return_date)
  VALUES (f, 'SR-SRP-1', '87730000-0000-0000-0000-000000000001', c, b, 4, 'completed', 4, u, CURRENT_DATE);

  SELECT
    count(*) FILTER (WHERE row_kind = 'product') AS products,
    count(*) FILTER (WHERE row_kind = 'party') AS parties,
    sum(quantity) FILTER (WHERE row_kind = 'line' AND party_type = 'marketer' AND product_name = 'Bottle Water 75cl') AS m_b,
    sum(quantity) FILTER (WHERE row_kind = 'line' AND party_type = 'marketer' AND product_name = 'Sachet Water') AS m_s,
    sum(quantity) FILTER (WHERE row_kind = 'line' AND party_type = 'distributor') AS d_b,
    sum(quantity) FILTER (WHERE row_kind = 'line' AND party_type = 'direct') AS direct,
    count(*) FILTER (WHERE row_kind = 'line' AND party_type = 'retail') AS shop_lines,
    count(*) FILTER (WHERE row_kind = 'party' AND party_name = 'SRP Van Customer') AS van_party
  INTO r FROM public.sales_report_by_party(f, CURRENT_DATE - 6, CURRENT_DATE);
  -- 3 products; parties: 2 marketers, shop, distributor, Direct Sales.
  PERFORM pg_temp.check(r.products = 3 AND r.parties = 5 AND r.m_b = 90 AND r.m_s = 50
    AND r.d_b = 36 AND r.direct = 3 AND r.shop_lines = 0 AND r.van_party = 0,
    'report: ' || row_to_json(r)::text);

  -- Outside the range: nothing.
  SELECT count(*) AS n INTO r FROM public.sales_report_by_party(f, CURRENT_DATE - 30, CURRENT_DATE - 10)
   WHERE row_kind = 'line';
  PERFORM pg_temp.check(r.n = 0, 'old range: ' || row_to_json(r)::text);
END $$;
