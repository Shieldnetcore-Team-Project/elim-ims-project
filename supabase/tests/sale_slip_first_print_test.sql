-- ============================================================================
-- Acceptance tests: sale_slip_first_print (20261102280000_sale_slip_first_print.sql)
-- A sale's first print claims it (two copies); every later print is a reprint.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f5000000-0000-0000-0000-000000000001', 'slptest', 'Slip Test Factory');
INSERT INTO auth.users(id, email) VALUES ('a5000000-0000-0000-0000-000000000001', 'admin@slip');
INSERT INTO user_roles(user_id, role, factory_id) VALUES ('a5000000-0000-0000-0000-000000000001', 'super_admin', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_name, subtotal, discount, vat,
                  grand_total, amount_paid, balance, payment_method, status)
VALUES ('55000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001', 'SLP-1', CURRENT_DATE,
        'Walk-in', 100, 0, 0, 100, 100, 0, 'cash', 'posted'),
       ('55000000-0000-0000-0000-000000000002', 'f5000000-0000-0000-0000-000000000001', 'SLP-2', CURRENT_DATE,
        'Walk-in', 100, 0, 0, 100, 100, 0, 'cash', 'posted');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: first print claims (two copies), the next is a reprint
DO $$
BEGIN
  PERFORM set_config('test.uid', 'a5000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(public.claim_sale_slips(ARRAY['55000000-0000-0000-0000-000000000001'::uuid]), 'first print');
  PERFORM pg_temp.check(NOT public.claim_sale_slips(ARRAY['55000000-0000-0000-0000-000000000001'::uuid]), 'then reprint');
END $$;

-- @@ Test 2: a combined print with one unprinted sale gives the two copies
DO $$
BEGIN
  PERFORM set_config('test.uid', 'a5000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(public.claim_sale_slips(ARRAY['55000000-0000-0000-0000-000000000001'::uuid,
                                                      '55000000-0000-0000-0000-000000000002'::uuid]), 'one new in the group');
  PERFORM pg_temp.check(NOT public.claim_sale_slips(ARRAY['55000000-0000-0000-0000-000000000002'::uuid]), 'now printed');
END $$;
