-- ============================================================================
-- Acceptance tests: sale_invoice_lines (20261029220000_sale_invoice_lines.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. An accountant (no finished-goods rights)
-- prints an invoice: the product lines must come back with their names.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('de000000-0000-0000-0000-000000000001', 'acct@sil'),
  ('de000000-0000-0000-0000-000000000002', 'prod@sil');
DELETE FROM user_roles WHERE user_id IN ('de000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT v.u::uuid, v.r, f.id FROM factories f,
  (VALUES ('de000000-0000-0000-0000-000000000001', 'accountant'),
          ('de000000-0000-0000-0000-000000000002', 'production')) v(u, r)
 WHERE f.code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active)
SELECT 'df000000-0000-0000-0000-000000000001', id, 'SIL Sachet Water', 'Bag', 'finished', true
  FROM factories WHERE code = 'water';
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_name, subtotal, grand_total, amount_paid, balance, status)
SELECT 'df000000-0000-0000-0000-000000000011', id, 'SIL-1', '2026-10-29', 'SIL Ambina', 2500, 2500, 0, 2500, 'pending_approval'
  FROM factories WHERE code = 'water';
INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total)
VALUES ('df000000-0000-0000-0000-000000000011', 'df000000-0000-0000-0000-000000000001', 10, 250, 2500);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the accountant can't read the product directly, but gets the named line
DO $$
DECLARE r record;
BEGIN
  PERFORM set_config('test.uid', 'de000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(NOT public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key),
                        'accountant has no finished-goods rights (the case being fixed)');
  SELECT * INTO r FROM public.sale_invoice_lines(ARRAY['df000000-0000-0000-0000-000000000011'::uuid]);
  PERFORM pg_temp.check(r.product_name = 'SIL Sachet Water' AND r.unit = 'Bag' AND r.quantity = 10
                        AND r.unit_price = 250 AND r.line_total = 2500, 'line: ' || row_to_json(r)::text);
END $$;

-- @@ Test 2: a user without sales or finance rights is refused
DO $$
DECLARE ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'de000000-0000-0000-0000-000000000002', false);
  BEGIN
    PERFORM public.sale_invoice_lines(ARRAY['df000000-0000-0000-0000-000000000011'::uuid]);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM pg_temp.check(ok, 'production user refused');
END $$;
