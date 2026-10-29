-- ============================================================================
-- Tests: Warehouse postings to distributors are confirmed by Accounts
-- (20261028280000_warehouse_postings_to_accounts.sql). Same harness as
-- payments_recorded_final_test.sql; never run against production.
-- ============================================================================
INSERT INTO factories(id, code, name) VALUES ('f4000000-0000-0000-0000-000000000001', 'wpatest', 'Posting Test Factory');
INSERT INTO auth.users(id, email) VALUES ('a4000000-0000-0000-0000-000000000001', 'acct@wpa'), ('a4000000-0000-0000-0000-000000000002', 'admin@wpa');
INSERT INTO user_roles(user_id, role) VALUES ('a4000000-0000-0000-0000-000000000001', 'accountant'), ('a4000000-0000-0000-0000-000000000002', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'WPA Sachet', 'bag', 500, 100);
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d4000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'WPA Distributor', true);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END; $$;
CREATE OR REPLACE FUNCTION pg_temp.post(p_customer uuid, p_qty int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('test.uid', 'a4000000-0000-0000-0000-000000000002', false);
  v := public.create_sale(jsonb_build_object('factory_id', 'f4000000-0000-0000-0000-000000000001', 'customer_id', p_customer,
        'items', jsonb_build_array(jsonb_build_object('product_id', 'b4000000-0000-0000-0000-000000000001', 'quantity', p_qty, 'unit_price', 500))));
  RETURN (v->>'sale_id')::uuid;
END; $$;

-- @@ A distributor posting is posted at once; Accounts confirms it later (20261029140000)
DO $$
DECLARE v_id uuid := pg_temp.post('d4000000-0000-0000-0000-000000000001', 10); n int;
BEGIN
  PERFORM pg_temp.check((SELECT public.is_warehouse_posting(s) FROM sales s WHERE s.id = v_id), 'is a warehouse posting');
  PERFORM pg_temp.check((SELECT status FROM sales WHERE id = v_id) = 'posted', 'posted at once');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b4000000-0000-0000-0000-000000000001') = 90, 'stock 100 - 10');
  PERFORM set_config('test.uid', 'a4000000-0000-0000-0000-000000000001', false);
  n := public.warehouse_postings_to_confirm();
  PERFORM pg_temp.check(n = 1, 'one waits on the accountant: ' || n);
  PERFORM public.assess_posting('sale', v_id, 'checked');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM posting_assessments WHERE posting_kind = 'sale' AND posting_id = v_id), 'marked confirmed');
  PERFORM pg_temp.check(public.warehouse_postings_to_confirm() = 0, 'nothing left to confirm');
END $$;
SELECT 'ok' AS result;

-- @@ A posted posting can't be rejected (it is reversed by deletion); walk-in sales aren't Accounts'
DO $$
DECLARE v_id uuid := pg_temp.post('d4000000-0000-0000-0000-000000000001', 5); w_id uuid := pg_temp.post(NULL, 1); ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'a4000000-0000-0000-0000-000000000001', false);
  BEGIN PERFORM public.reject_warehouse_posting(v_id, ' ');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%reason is required%'; END;
  PERFORM pg_temp.check(ok, 'reason required');
  ok := false;
  BEGIN PERFORM public.reject_warehouse_posting(v_id, 'Wrong price');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%posted -> rejected%'; END;
  PERFORM pg_temp.check(ok, 'posted not rejectable');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b4000000-0000-0000-0000-000000000001') = 85, 'stock out at once: 90 - 5, got ' || (SELECT current_stock FROM products WHERE id = 'b4000000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check(NOT (SELECT public.is_warehouse_posting(s) FROM sales s WHERE s.id = w_id), 'walk-in is not');
  ok := false;
  BEGIN PERFORM public.confirm_warehouse_posting(w_id, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%isn''t a Warehouse posting%'; END;
  PERFORM pg_temp.check(ok, 'walk-in refused');
END $$;
SELECT 'ok' AS result;

-- @@ Whoever recorded it can't confirm it, and the bell list still works
DO $$
DECLARE v jsonb; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'a4000000-0000-0000-0000-000000000001', false);
  BEGIN
    v := public.create_sale(jsonb_build_object('factory_id', 'f4000000-0000-0000-0000-000000000001', 'customer_id', 'd4000000-0000-0000-0000-000000000001',
          'items', jsonb_build_array(jsonb_build_object('product_id', 'b4000000-0000-0000-0000-000000000001', 'quantity', 1, 'unit_price', 500))));
    PERFORM public.confirm_warehouse_posting((v->>'sale_id')::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%someone other than%' OR SQLERRM LIKE '%Insufficient permissions%'; END;
  PERFORM pg_temp.check(ok, 'self-confirm refused');
  PERFORM count(*) FROM public.my_open_notifications('f4000000-0000-0000-0000-000000000001', 30);
END $$;
SELECT 'ok' AS result;
