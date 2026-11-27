-- Acceptance tests for the Warehouse returns report
-- (20261124110000_warehouse_returns_report.sql).

INSERT INTO factories(id, code, name)
VALUES ('f3600000-0000-0000-0000-000000000001', 'wrpt', 'Warehouse Returns Report');
INSERT INTO auth.users(id, email)
VALUES ('a3600000-0000-0000-0000-000000000001', 'wrpt@example.test');
INSERT INTO profiles(id, email, full_name)
VALUES ('a3600000-0000-0000-0000-000000000001', 'wrpt@example.test', 'Report Receiver')
ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
INSERT INTO user_roles(user_id, role)
VALUES ('a3600000-0000-0000-0000-000000000001', 'super_admin')
ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3600000-0000-0000-0000-000000000001', 'f3600000-0000-0000-0000-000000000001', 'WR 50cl Bottled Water', 'Pack', 0, 0, 'finished'),
  ('b3600000-0000-0000-0000-000000000002', 'f3600000-0000-0000-0000-000000000001', 'WR Dispenser Water', 'Piece', 0, 0, 'finished'),
  ('b3600000-0000-0000-0000-000000000003', 'f3600000-0000-0000-0000-000000000001', 'WR Sachet Water', 'Bag', 0, 0, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
VALUES ('c3600000-0000-0000-0000-000000000001', 'f3600000-0000-0000-0000-000000000001', 'Report Marketer', 'active', 'rep');
INSERT INTO customers(id, factory_id, name, registered)
VALUES ('d3600000-0000-0000-0000-000000000001', 'f3600000-0000-0000-0000-000000000001', 'Report Customer', true);
INSERT INTO container_types(id, factory_id, name)
VALUES ('e3600000-0000-0000-0000-000000000001', 'f3600000-0000-0000-0000-000000000001', 'Report Dispenser Jug');
SELECT set_config('test.uid', 'a3600000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF;
END;
$$;

-- @@ Test 1: counts accepted bottle/dispenser returns and reports empty-jug claim vs count
DO $$
DECLARE
  f uuid := 'f3600000-0000-0000-0000-000000000001';
  d date := public._lagos_today() - 1;
  n int;
BEGIN
  INSERT INTO sales_returns(
    factory_id, return_number, customer_id, product_id, quantity_returned, unit,
    status, accepted_quantity, damaged_quantity, rejected_quantity, received_by, return_date
  ) VALUES (
    f, 'WRPT-CUSTOMER-1', 'd3600000-0000-0000-0000-000000000001',
    'b3600000-0000-0000-0000-000000000001', 5, 'Pack',
    'completed', 3, 1, 1, auth.uid(), d
  );
  INSERT INTO sales_returns(
    factory_id, return_number, customer_id, product_id, quantity_returned, unit,
    status, accepted_quantity, received_by, return_date
  ) VALUES (
    f, 'WRPT-SACHET-1', 'd3600000-0000-0000-0000-000000000001',
    'b3600000-0000-0000-0000-000000000003', 20, 'Bag',
    'completed', 20, auth.uid(), d
  );

  INSERT INTO rep_returns(id, factory_id, return_number, sales_rep_id, return_date, status, received_by)
  VALUES (
    'c3610000-0000-0000-0000-000000000001', f, 'WRPT-MARKETER-1',
    'c3600000-0000-0000-0000-000000000001', d, 'completed', auth.uid()
  );
  INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price, accepted_quantity)
  VALUES (
    'c3610000-0000-0000-0000-000000000001',
    'b3600000-0000-0000-0000-000000000002', 7, 0, 4
  );

  INSERT INTO jug_returns(
    id, factory_id, reference, sales_rep_id, container_type_id, quantity_claimed,
    status, recorded_by, recorded_at, quantity_received, verified_by, verified_at
  ) VALUES (
    'e3610000-0000-0000-0000-000000000001', f, 'WRPT-JUG-1',
    'c3600000-0000-0000-0000-000000000001', 'e3600000-0000-0000-0000-000000000001',
    6, 'verified', auth.uid(), (d + time '17:00') AT TIME ZONE 'Africa/Lagos',
    5, auth.uid(), now()
  );

  SELECT count(*) INTO n FROM public.warehouse_returns_report(f, d, d);
  PERFORM pg_temp.check(n = 3, 'only bottle, dispenser and empty-jug returns included; got ' || n);
  PERFORM pg_temp.check(
    (SELECT quantity = 3 FROM public.warehouse_returns_report(f, d, d)
      WHERE category = 'bottled_water' AND reference = 'WRPT-CUSTOMER-1'),
    'bottle report uses accepted quantity'
  );
  PERFORM pg_temp.check(
    (SELECT quantity = 4 FROM public.warehouse_returns_report(f, d, d)
      WHERE category = 'dispenser' AND reference = 'WRPT-MARKETER-1'),
    'dispenser report uses accepted quantity'
  );
  PERFORM pg_temp.check(
    (SELECT quantity = 6 AND quantity_received = 5
       FROM public.warehouse_returns_report(f, d, d) WHERE category = 'empty_jug'),
    'empty jug report separates claimed and Warehouse-counted quantities'
  );
END $$;
