-- ============================================================================
-- Acceptance tests: 20261114090000_qc_jug_holders.sql
--   QC -> Dispenser Jug -> Accountability: who still holds jugs (marketers,
--   Distributor / Office Delivery customers) and the jugs sold to them.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7800000-0000-0000-0000-000000000001', 'qjhfac', 'QJH Factory');
INSERT INTO auth.users(id, email) VALUES ('a7800000-0000-0000-0000-000000000001', 'admin@qjh');
DELETE FROM user_roles WHERE user_id = 'a7800000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a7800000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e7800000-0000-0000-0000-000000000001', 'f7800000-0000-0000-0000-000000000001', 'QJH Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7800000-0000-0000-0000-000000000001', 'f7800000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 1000, 'finished'),
  ('b7800000-0000-0000-0000-000000000002', 'f7800000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 3000, 100, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b7800000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b7800000-0000-0000-0000-000000000002', 'e7800000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d7800000-0000-0000-0000-000000000001', 'f7800000-0000-0000-0000-000000000001', 'QJH Office Delivery', true);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c7800000-0000-0000-0000-000000000001', 'f7800000-0000-0000-0000-000000000001', 'QJH Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a7800000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: distributor -- 50 supplied, 5 Jug + Water, 2 Empty Jug bought, 10 empties back
DO $$
DECLARE v jsonb; r record;
BEGIN
  v := public.create_sale(jsonb_build_object('factory_id', 'f7800000-0000-0000-0000-000000000001',
         'customer_id', 'd7800000-0000-0000-0000-000000000001', 'customer_name', 'QJH Office Delivery',
         'sale_date', (now() AT TIME ZONE 'Africa/Lagos')::date, 'payments', '[]'::jsonb,
         'items', jsonb_build_array(
           jsonb_build_object('product_id', 'b7800000-0000-0000-0000-000000000001', 'quantity', 50, 'unit_price', 1200),
           jsonb_build_object('product_id', 'b7800000-0000-0000-0000-000000000001', 'quantity', 5, 'jar_mode', 'permanent'),
           jsonb_build_object('product_id', 'b7800000-0000-0000-0000-000000000002', 'quantity', 2, 'unit_price', 3000))));
  IF v->>'status' = 'pending_approval' THEN PERFORM public._post_sale((v->>'sale_id')::uuid, 'test'); END IF;
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, quantity, source, reference)
  VALUES ('f7800000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001', 'customer',
          'd7800000-0000-0000-0000-000000000001', 'qc', 10, 'return', 'QJH-RET');

  SELECT * INTO r FROM public.qc_jug_holders('f7800000-0000-0000-0000-000000000001')
   WHERE holder_id = 'd7800000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(r.holder_kind = 'customer', 'distributor kind, got ' || r.holder_kind);
  PERFORM pg_temp.check(r.jugs_out = 52, 'out 50 + 2 empty jugs bought, got ' || r.jugs_out);
  PERFORM pg_temp.check(r.empties_back = 10, 'empties back 10, got ' || r.empties_back);
  PERFORM pg_temp.check(r.empty_not_returned = 40, 'not returned 40, got ' || r.empty_not_returned);
  PERFORM pg_temp.check(r.jugs_sold = 7, 'sold 5 Jug + Water + 2 Empty Jug, got ' || r.jugs_sold);
  PERFORM pg_temp.check(r.owing_as_sold = 0, 'no jug charge on a distributor');
  PERFORM pg_temp.check(r.last_returned IS NOT NULL, 'last returned set');
END $$;

-- @@ Test 2: marketer -- 100 Dispenser Water + 10 Jug + Water posted, 20 on the van, 50 empties back
DO $$
DECLARE r record;
BEGIN
  INSERT INTO stock_dispatches(id, factory_id, dispatch_number, dispatch_date, sales_rep_id, created_by)
  VALUES ('97800000-0000-0000-0000-0000000000d1', 'f7800000-0000-0000-0000-000000000001', 'DSP-QJH-1',
          (now() AT TIME ZONE 'Africa/Lagos')::date, 'c7800000-0000-0000-0000-000000000001',
          'a7800000-0000-0000-0000-000000000001');
  INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value, jar_mode) VALUES
    ('97800000-0000-0000-0000-0000000000d1', 'b7800000-0000-0000-0000-000000000001', 100, 1200, 120000, NULL),
    ('97800000-0000-0000-0000-0000000000d1', 'b7800000-0000-0000-0000-000000000001', 10, 4200, 42000, 'permanent');
  DELETE FROM rep_stock WHERE sales_rep_id = 'c7800000-0000-0000-0000-000000000001';
  INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
  VALUES ('c7800000-0000-0000-0000-000000000001', 'b7800000-0000-0000-0000-000000000001',
          'f7800000-0000-0000-0000-000000000001', 30);
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, quantity, source, reference)
  VALUES ('f7800000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001', 'sales_rep',
          'c7800000-0000-0000-0000-000000000001', 'qc', 50, 'return', 'QJH-RET-2');

  SELECT * INTO r FROM public.qc_jug_holders('f7800000-0000-0000-0000-000000000001')
   WHERE holder_id = 'c7800000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(r.holder_kind = 'rep', 'marketer kind');
  PERFORM pg_temp.check(r.jugs_out = 100, 'posted 100, got ' || r.jugs_out);
  PERFORM pg_temp.check(r.full_with_them = 20, '30 on van less 10 Jug + Water = 20 full, got ' || r.full_with_them);
  PERFORM pg_temp.check(r.empties_back = 50, 'empties 50, got ' || r.empties_back);
  PERFORM pg_temp.check(r.empty_not_returned = 30, '100 - 20 - 50 = 30 empties out, got ' || r.empty_not_returned);
  PERFORM pg_temp.check(r.owing_as_sold = 30, 'owing as Empty Jug 30, got ' || r.owing_as_sold);
  PERFORM pg_temp.check(r.jugs_sold = 10, 'Jug + Water 10, got ' || r.jugs_sold);
END $$;

-- @@ Test 3: refused for someone without QC / Accounts dispenser view
DO $$
BEGIN
  INSERT INTO auth.users(id, email) VALUES ('a7800000-0000-0000-0000-000000000009', 'nobody@qjh');
  DELETE FROM user_roles WHERE user_id = 'a7800000-0000-0000-0000-000000000009';
  PERFORM set_config('test.uid', 'a7800000-0000-0000-0000-000000000009', false);
  BEGIN
    PERFORM public.qc_jug_holders('f7800000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'ASSERTION FAILED: should be refused';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%Insufficient permissions%' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid', 'a7800000-0000-0000-0000-000000000001', false);
END $$;
