-- ============================================================================
-- Acceptance tests: returns on the Warehouse Activity Log
-- (20261119090000_returns_in_activity_log.sql). A distributor's return keyed
-- in today for yesterday shows on yesterday, all its products on one row;
-- a marketer's return shows too.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3500000-0000-0000-0000-000000000001', 'ralfac', 'Activity Factory');
INSERT INTO auth.users(id, email) VALUES ('a3500000-0000-0000-0000-000000000001', 'admin@ral');
INSERT INTO user_roles(user_id, role) VALUES ('a3500000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3500000-0000-0000-0000-000000000001', 'f3500000-0000-0000-0000-000000000001', 'RAL 75cl', 'Pack', 300, 100, 'finished'),
  ('b3500000-0000-0000-0000-000000000002', 'f3500000-0000-0000-0000-000000000001', 'RAL 50cl', 'Pack', 250, 100, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3500000-0000-0000-0000-000000000001', 'f3500000-0000-0000-0000-000000000001', 'RAL Marketer', 'active', 'rep');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d3500000-0000-0000-0000-000000000001', 'f3500000-0000-0000-0000-000000000001', 'RAL Medix', true);
SELECT set_config('test.uid', 'a3500000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: distributor return for yesterday -> one 'customer_return' row on yesterday
DO $$
DECLARE v jsonb; y date := public._lagos_today() - 1; n text; r record; c int;
BEGIN
  v := public.warehouse_receive_customer_return(jsonb_build_object(
         'customer_id', 'd3500000-0000-0000-0000-000000000001', 'all_products', true, 'return_date', y,
         'items', jsonb_build_array(
           jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000001', 'quantity', 50),
           jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000002', 'quantity', 3))));
  n := v->>'return_number';
  SELECT count(*) INTO c FROM public.warehouse_activity('f3500000-0000-0000-0000-000000000001', y, y)
   WHERE kind = 'customer_return';
  PERFORM pg_temp.check(c = 1, 'one customer_return row on yesterday, got ' || c);
  SELECT * INTO r FROM public.warehouse_activity('f3500000-0000-0000-0000-000000000001', y, y)
   WHERE kind = 'customer_return';
  PERFORM pg_temp.check(r.reference = n, 'reference is the return number ' || n || ', got ' || r.reference);
  PERFORM pg_temp.check(r.party = 'RAL Medix', 'party is the distributor');
  PERFORM pg_temp.check(r.quantity = 53 AND r.items LIKE '%RAL 75cl × 50%', 'items ' || r.items);
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.warehouse_activity('f3500000-0000-0000-0000-000000000001',
                          public._lagos_today(), public._lagos_today()) WHERE kind = 'customer_return'),
                        'not on today');
END $$;

-- @@ Test 2: marketer return -> 'returned' row
DO $$
DECLARE c int;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f3500000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3500000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000001', 'quantity', 10))));
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', 'f3500000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c3500000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3500000-0000-0000-0000-000000000001', 'quantity_returned', 2))));
  SELECT count(*) INTO c FROM public.warehouse_activity('f3500000-0000-0000-0000-000000000001',
                                public._lagos_today(), public._lagos_today())
   WHERE kind = 'returned' AND party = 'RAL Marketer' AND quantity = 2;
  PERFORM pg_temp.check(c = 1, 'marketer return listed, got ' || c);
END $$;
