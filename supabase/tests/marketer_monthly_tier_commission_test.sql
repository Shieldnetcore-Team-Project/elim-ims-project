-- Acceptance tests for monthly marketer tier commission.
INSERT INTO factories(id, code, name) VALUES
  ('f9d10000-0000-0000-0000-000000000001', 'mtfac', 'MT Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a9d10000-0000-0000-0000-000000000001', 'admin@mt');
DELETE FROM user_roles WHERE user_id = 'a9d10000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES
  ('a9d10000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b9d10000-0000-0000-0000-000000000001',
   'f9d10000-0000-0000-0000-000000000001', 'MT 75cl', 'Pack', 1000, 100000);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind, commission_tier) VALUES
  ('c9d10000-0000-0000-0000-000000000001',
   'f9d10000-0000-0000-0000-000000000001', 'MT Status A', 'active', 'rep', 'A'),
  ('c9d10000-0000-0000-0000-000000000002',
   'f9d10000-0000-0000-0000-000000000001', 'MT Status B', 'active', 'rep', 'B');
SELECT set_config('test.uid', 'a9d10000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF;
END;
$$;

SELECT public.create_stock_dispatch(jsonb_build_object(
  'factory_id', 'f9d10000-0000-0000-0000-000000000001',
  'sales_rep_id', 'c9d10000-0000-0000-0000-000000000001',
  'items', jsonb_build_array(jsonb_build_object(
    'product_id', 'b9d10000-0000-0000-0000-000000000001', 'quantity', 22000
  ))
));
SELECT public.create_stock_dispatch(jsonb_build_object(
  'factory_id', 'f9d10000-0000-0000-0000-000000000001',
  'sales_rep_id', 'c9d10000-0000-0000-0000-000000000002',
  'items', jsonb_build_array(jsonb_build_object(
    'product_id', 'b9d10000-0000-0000-0000-000000000001', 'quantity', 11000
  ))
));

INSERT INTO rep_remittances(factory_id, sales_rep_id, amount, remittance_date, remittance_number) VALUES
  ('f9d10000-0000-0000-0000-000000000001',
   'c9d10000-0000-0000-0000-000000000001', 21999999, CURRENT_DATE, 'MT-A-1'),
  ('f9d10000-0000-0000-0000-000000000001',
   'c9d10000-0000-0000-0000-000000000002', 11000000, CURRENT_DATE, 'MT-B-1');

DO $$
DECLARE
  a record;
  b record;
  f uuid := 'f9d10000-0000-0000-0000-000000000001';
BEGIN
  SELECT * INTO a FROM public.marketer_monthly_tier_commission(f, CURRENT_DATE, CURRENT_DATE)
   WHERE sales_rep_id = 'c9d10000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(a.target = 22000000 AND a.eligible_value = 21999999 AND a.commission = 0,
                        'Status A below target: ' || row_to_json(a)::text);

  INSERT INTO rep_remittances(factory_id, sales_rep_id, amount, remittance_date, remittance_number)
  VALUES (f, 'c9d10000-0000-0000-0000-000000000001', 1, CURRENT_DATE, 'MT-A-2');
  SELECT * INTO a FROM public.marketer_monthly_tier_commission(f, CURRENT_DATE, CURRENT_DATE)
   WHERE sales_rep_id = 'c9d10000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(a.commission = 200000, 'Status A target reached: ' || row_to_json(a)::text);

  SELECT * INTO b FROM public.marketer_monthly_tier_commission(f, CURRENT_DATE, CURRENT_DATE)
   WHERE sales_rep_id = 'c9d10000-0000-0000-0000-000000000002';
  PERFORM pg_temp.check(b.target = 11000000 AND b.commission = 90000,
                        'Status B target reached: ' || row_to_json(b)::text);
END $$;

DO $$
DECLARE
  total_amount numeric;
  entry_count bigint;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0)
    INTO entry_count, total_amount
    FROM public.marketer_remittance_activity(
      'f9d10000-0000-0000-0000-000000000001',
      CURRENT_DATE,
      CURRENT_DATE
    );
  PERFORM pg_temp.check(entry_count = 3 AND total_amount = 33000000,
                        'Account remittance activity: ' || entry_count || ' entries, ' || total_amount);
END $$;
