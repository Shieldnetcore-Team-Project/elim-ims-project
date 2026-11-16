-- ============================================================================
-- Acceptance tests: 20261116110000_jugs_sold_report.sql
--   Jugs sold in a period, once each, where they leave the company: marketer
--   postings (incl. marked Jug + Water) less returns, Retail Shop POS sales,
--   Warehouse sales less returns; marketers' van sales not counted twice.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7720000-0000-0000-0000-000000000001', 'jsrfac', 'JSR Factory');
INSERT INTO auth.users(id, email) VALUES ('a7720000-0000-0000-0000-000000000001', 'admin@jsr');
INSERT INTO user_roles(user_id, role) VALUES ('a7720000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e7720000-0000-0000-0000-000000000001', 'f7720000-0000-0000-0000-000000000001', 'JSR Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7720000-0000-0000-0000-000000000001', 'f7720000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 500, 'finished'),
  ('b7720000-0000-0000-0000-000000000002', 'f7720000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 3000, 50, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b7720000-0000-0000-0000-000000000001', 'e7720000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b7720000-0000-0000-0000-000000000002', 'e7720000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO sales_reps(id, factory_id, full_name, code, status, kind) VALUES
  ('c7720000-0000-0000-0000-000000000001', 'f7720000-0000-0000-0000-000000000001', 'JSR Marketer', 'M01', 'active', 'rep'),
  ('c7720000-0000-0000-0000-000000000002', 'f7720000-0000-0000-0000-000000000001', 'JSR Shop', 'SHOP', 'active', 'outlet');
INSERT INTO customers(id, factory_id, name) VALUES
  ('d7720000-0000-0000-0000-000000000001', 'f7720000-0000-0000-0000-000000000001', 'JSR Distributor');
SELECT set_config('test.uid', 'a7720000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: marketer -- 100 posted, 40 marked Jug + Water, 5 Empty Jug, 1 Empty Jug back
DO $$
DECLARE f uuid := 'f7720000-0000-0000-0000-000000000001'; m uuid := 'c7720000-0000-0000-0000-000000000001';
  w uuid := 'b7720000-0000-0000-0000-000000000001'; e uuid := 'b7720000-0000-0000-0000-000000000002';
  r record;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 100),
                               jsonb_build_object('product_id', e, 'quantity', 5))));
  PERFORM public.set_rep_jug_water_sold(m, w, CURRENT_DATE, 40, 'test');
  INSERT INTO rep_returns(id, factory_id, sales_rep_id, return_number, status, return_date, received_by)
  VALUES ('97720000-0000-0000-0000-000000000001', f, m, 'RR-JSR-1', 'completed', CURRENT_DATE,
          'a7720000-0000-0000-0000-000000000001');
  INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, accepted_quantity)
  VALUES ('97720000-0000-0000-0000-000000000001', e, 1, 1);

  SELECT sum(jug_water) AS jw, sum(empty_jug) AS ej, max(buyer_kind) AS k, max(buyer_name) AS n INTO r
    FROM public.jugs_sold_report(f, CURRENT_DATE - 5, CURRENT_DATE);
  PERFORM pg_temp.check(r.jw = 40 AND r.ej = 4 AND r.k = 'rep' AND r.n = 'JSR Marketer', 'marketer: ' || row_to_json(r)::text);
END $$;

-- @@ Test 2: Warehouse sale, shop POS sale, marketer van sale (not counted again), a return
DO $$
DECLARE f uuid := 'f7720000-0000-0000-0000-000000000001';
  w uuid := 'b7720000-0000-0000-0000-000000000001'; e uuid := 'b7720000-0000-0000-0000-000000000002';
  c uuid := 'd7720000-0000-0000-0000-000000000001'; r record;
BEGIN
  INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, status, created_by) VALUES
    ('87720000-0000-0000-0000-000000000001', f, 'INV-JSR-1', CURRENT_DATE, c, 'posted', 'a7720000-0000-0000-0000-000000000001');
  INSERT INTO sales(id, factory_id, invoice_number, sale_date, sales_rep_id, status, created_by) VALUES
    ('87720000-0000-0000-0000-000000000002', f, 'INV-JSR-2', CURRENT_DATE, 'c7720000-0000-0000-0000-000000000002', 'posted', 'a7720000-0000-0000-0000-000000000001'),
    ('87720000-0000-0000-0000-000000000003', f, 'INV-JSR-3', CURRENT_DATE, 'c7720000-0000-0000-0000-000000000001', 'posted', 'a7720000-0000-0000-0000-000000000001');
  INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total, jar_mode) VALUES
    ('87720000-0000-0000-0000-000000000001', w, 10, 4200, 42000, 'permanent'),
    ('87720000-0000-0000-0000-000000000001', e, 3, 3000, 9000, NULL),
    ('87720000-0000-0000-0000-000000000002', w, 7, 4200, 29400, 'permanent'),
    ('87720000-0000-0000-0000-000000000002', w, 9, 1200, 10800, 'swap'),
    ('87720000-0000-0000-0000-000000000003', w, 20, 4200, 84000, 'permanent');
  -- The distributor sends 2 Jug + Water back on that invoice.
  INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned,
                            status, accepted_quantity, received_by, return_date)
  VALUES (f, 'SR-JSR-1', '87720000-0000-0000-0000-000000000001', c, w, 2, 'completed', 2,
          'a7720000-0000-0000-0000-000000000001', CURRENT_DATE);

  SELECT sum(jug_water) FILTER (WHERE buyer_kind = 'customer') AS cjw,
         sum(empty_jug) FILTER (WHERE buyer_kind = 'customer') AS cej,
         sum(jug_water) FILTER (WHERE buyer_kind = 'shop') AS sjw,
         sum(jug_water) FILTER (WHERE buyer_kind = 'rep') AS mjw,
         sum(jug_water) + sum(empty_jug) AS total
    INTO r FROM public.jugs_sold_report(f, CURRENT_DATE, CURRENT_DATE);
  PERFORM pg_temp.check(r.cjw = 8 AND r.cej = 3 AND r.sjw = 7 AND r.mjw = 40 AND r.total = 8 + 3 + 7 + 40 + 4,
                        'all: ' || row_to_json(r)::text);
  -- Out of range: nothing.
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.jugs_sold_report(f, CURRENT_DATE - 10, CURRENT_DATE - 9)),
                        'empty range');
END $$;
