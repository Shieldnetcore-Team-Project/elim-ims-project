-- ============================================================================
-- Acceptance tests: retail_activity (20261102130000_retail_activity.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Own factory and shop: a posting, a sale,
-- a customer return, a later payment and cash handed in, all listed with
-- product names; a marketer's id is refused; no rights, refused.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fa000000-0000-0000-0000-000000000001', 'ratest', 'RA Test Factory');
INSERT INTO auth.users(id, email) VALUES ('aa000000-0000-0000-0000-000000000001', 'admin@ra'),
                                         ('aa000000-0000-0000-0000-000000000002', 'nobody@ra');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('aa000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('aa000000-0000-0000-0000-000000000002', 'production', 'fa000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;
INSERT INTO sales_reps(id, factory_id, code, full_name, status, kind) VALUES
  ('ea000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001', 'RA-SHOP', 'RA Shop', 'active', 'outlet'),
  ('ea000000-0000-0000-0000-000000000002', 'fa000000-0000-0000-0000-000000000001', 'RA-01', 'RA Marketer', 'active', 'rep');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('da000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001', 'RA 75cl', 'Pack', 300, 50, 'finished');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('ca000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001', 'RA Buyer', false);
INSERT INTO stock_dispatches(id, factory_id, dispatch_number, dispatch_date, sales_rep_id, total_value)
VALUES ('9a000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001', 'RA-DSP-1', CURRENT_DATE,
        'ea000000-0000-0000-0000-000000000001', 3000);
INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value)
VALUES ('9a000000-0000-0000-0000-000000000001', 'da000000-0000-0000-0000-000000000001', 10, 300, 3000);
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, subtotal, discount, vat,
                  grand_total, amount_paid, balance, payment_method, status, sales_rep_id)
VALUES ('5a000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001', 'RA-INV-1', CURRENT_DATE,
        'ca000000-0000-0000-0000-000000000001', 'RA Buyer', 900, 0, 0, 900, 600, 300, 'cash', 'posted',
        'ea000000-0000-0000-0000-000000000001');
INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, discount, line_total)
VALUES ('5a000000-0000-0000-0000-000000000001', 'da000000-0000-0000-0000-000000000001', 3, 300, 0, 900);
INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned, unit, status,
                          accepted_quantity, received_by, return_date, sales_rep_id, value, credit_added)
VALUES ('fa000000-0000-0000-0000-000000000001', 'RA-SR-1', '5a000000-0000-0000-0000-000000000001',
        'ca000000-0000-0000-0000-000000000001', 'da000000-0000-0000-0000-000000000001', 1, 'Pack', 'completed', 1,
        'aa000000-0000-0000-0000-000000000001', CURRENT_DATE, 'ea000000-0000-0000-0000-000000000001', 300, 300);
INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date,
                              collected_by_rep, status)
VALUES ('fa000000-0000-0000-0000-000000000001', 'RA-RCP-1', 'ca000000-0000-0000-0000-000000000001',
        '5a000000-0000-0000-0000-000000000001', 200, 'transfer', CURRENT_DATE,
        'ea000000-0000-0000-0000-000000000001', 'posted');
INSERT INTO rep_remittances(factory_id, remittance_number, sales_rep_id, amount, payment_method, remittance_date)
VALUES ('fa000000-0000-0000-0000-000000000001', 'RA-REM-1', 'ea000000-0000-0000-0000-000000000001', 600, 'cash', CURRENT_DATE);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: the shop's day, every kind, with products
DO $$
DECLARE k text;
BEGIN
  PERFORM set_config('test.uid', 'aa000000-0000-0000-0000-000000000001', false);
  FOR k IN SELECT unnest(ARRAY['Posting', 'Sale', 'Customer return', 'Payment', 'Cash remitted']) LOOP
    PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.retail_activity('ea000000-0000-0000-0000-000000000001',
                                   CURRENT_DATE, CURRENT_DATE) a WHERE a.kind = k), 'has ' || k);
  END LOOP;
  PERFORM pg_temp.check((SELECT details FROM public.retail_activity('ea000000-0000-0000-0000-000000000001', CURRENT_DATE, CURRENT_DATE) a
                          WHERE a.kind = 'Posting') LIKE 'RA 75cl × 10 Pack%', 'posting products');
  PERFORM pg_temp.check((SELECT paid FROM public.retail_activity('ea000000-0000-0000-0000-000000000001', CURRENT_DATE, CURRENT_DATE) a
                          WHERE a.kind = 'Sale') = 600, 'sale paid');
  PERFORM pg_temp.check(pg_temp.err($q$SELECT * FROM public.retail_activity('ea000000-0000-0000-0000-000000000002', CURRENT_DATE, CURRENT_DATE)$q$)
                        LIKE '%Retail outlet not found%', 'a marketer is not the shop');
  PERFORM set_config('test.uid', 'aa000000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.err($q$SELECT * FROM public.retail_activity('ea000000-0000-0000-0000-000000000001', CURRENT_DATE, CURRENT_DATE)$q$)
                        LIKE '%Insufficient%', 'no rights');
END $$;
