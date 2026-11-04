-- ============================================================================
-- Acceptance tests: commission on remittances by achievement band
-- (20261104250000_marketer_remittance_commission.sql). Runs as an admin.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9d00000-0000-0000-0000-000000000001', 'mcfac', 'MC Factory');
INSERT INTO auth.users(id, email) VALUES ('a9d00000-0000-0000-0000-000000000001', 'admin@mc');
DELETE FROM user_roles WHERE user_id = 'a9d00000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a9d00000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b9d00000-0000-0000-0000-000000000001', 'f9d00000-0000-0000-0000-000000000001', 'MC 75cl', 'Pack', 1000, 100000);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c9d00000-0000-0000-0000-000000000001', 'f9d00000-0000-0000-0000-000000000001', 'MC Abacha', 'active', 'rep');
SELECT set_config('test.uid', 'a9d00000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: posted 22,000,000; remitted 1,200,000 -> 5.45% -> nothing; 14,000,000 -> band 60%
DO $$
DECLARE r record; f uuid := 'f9d00000-0000-0000-0000-000000000001'; m uuid := 'c9d00000-0000-0000-0000-000000000001';
BEGIN
  PERFORM public.set_marketer_commission_rate(m, 5);
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b9d00000-0000-0000-0000-000000000001', 'quantity', 22000))));
  INSERT INTO rep_remittances(factory_id, sales_rep_id, amount, remittance_date, remittance_number)
  VALUES (f, m, 1200000, CURRENT_DATE, 'RM-MC-1');
  SELECT * INTO r FROM public.marketer_daily_commission(f, CURRENT_DATE, CURRENT_DATE);
  PERFORM pg_temp.check(r.target = 22000000 AND r.achievement = 5.45 AND r.band = 0 AND r.commission = 0,
                        'below 50%: ' || row_to_json(r)::text);
  INSERT INTO rep_remittances(factory_id, sales_rep_id, amount, remittance_date, remittance_number)
  VALUES (f, m, 12800000, CURRENT_DATE, 'RM-MC-2');
  SELECT * INTO r FROM public.marketer_daily_commission(f, CURRENT_DATE, CURRENT_DATE);
  PERFORM pg_temp.check(r.remitted = 14000000 AND r.band = 60 AND r.full_commission = 700000 AND r.commission = 420000,
                        '63.6% -> 60%: ' || row_to_json(r)::text);
END $$;
