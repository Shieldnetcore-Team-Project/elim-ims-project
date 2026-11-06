-- First Warehouse print claims the two-copy slip; later prints are reprints.
INSERT INTO factories(id, code, name) VALUES
  ('f9e30000-0000-0000-0000-000000000001', 'wspfac', 'WS Print Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a9e30000-0000-0000-0000-000000000001', 'admin@wsp');
DELETE FROM user_roles WHERE user_id = 'a9e30000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES
  ('a9e30000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c9e30000-0000-0000-0000-000000000001',
   'f9e30000-0000-0000-0000-000000000001', 'WS Marketer', 'active', 'rep');
INSERT INTO stock_dispatches(id, factory_id, dispatch_number, sales_rep_id) VALUES
  ('d9e30000-0000-0000-0000-000000000001',
   'f9e30000-0000-0000-0000-000000000001', 'WS-DSP-1',
   'c9e30000-0000-0000-0000-000000000001');
INSERT INTO sales(id, factory_id, invoice_number) VALUES
  ('e9e30000-0000-0000-0000-000000000001',
   'f9e30000-0000-0000-0000-000000000001', 'WS-SALE-1');
SELECT set_config('test.uid', 'a9e30000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF;
END;
$$;

DO $$
DECLARE f uuid := 'f9e30000-0000-0000-0000-000000000001';
BEGIN
  PERFORM pg_temp.check(public.claim_warehouse_slip(f, 'dispatch', 'WS-DSP-1'),
                        'first dispatch print');
  PERFORM pg_temp.check(NOT public.claim_warehouse_slip(f, 'dispatch', 'WS-DSP-1'),
                        'dispatch reprint');
  PERFORM pg_temp.check(public.claim_warehouse_slip(f, 'sale', 'WS-SALE-1'),
                        'first sale print');
  PERFORM pg_temp.check(NOT public.claim_warehouse_slip(f, 'sale', 'WS-SALE-1'),
                        'sale reprint');
END $$;
