-- ============================================================================
-- Acceptance tests: adjust_sale_lines (20261029230000_adjust_sale_lines.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A distributor bought two products on one
-- invoice (75cl 10 x 1,700 = 17,000; 50cl 10 x 300 = 3,000; total 20,000),
-- paid 5,000, owes 15,000. The accountant gives 100 per pack off the 75cl
-- (1,000) and adds a 20 per pack surcharge on the 50cl (200) in one save.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('ee000000-0000-0000-0000-000000000001', 'acct@asl'),
  ('ee000000-0000-0000-0000-000000000002', 'prod@asl');
DELETE FROM user_roles WHERE user_id IN ('ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT v.u::uuid, v.r, f.id FROM factories f,
  (VALUES ('ee000000-0000-0000-0000-000000000001', 'accountant'),
          ('ee000000-0000-0000-0000-000000000002', 'production')) v(u, r)
 WHERE f.code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active)
SELECT v.id::uuid, f.id, v.name, 'Pack', 'finished', true FROM factories f,
  (VALUES ('ef000000-0000-0000-0000-000000000031', 'ASL 75cl Bottle Water'),
          ('ef000000-0000-0000-0000-000000000032', 'ASL 50cl Bottle Water')) v(id, name)
 WHERE f.code = 'water';
INSERT INTO customers(id, factory_id, name, registered, outstanding_balance)
SELECT 'ef000000-0000-0000-0000-000000000001', id, 'ASL Ambina', true, 15000 FROM factories WHERE code = 'water';
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, subtotal, grand_total,
                  amount_paid, balance, status)
SELECT v.id::uuid, f.id, v.inv, '2026-10-29', 'ef000000-0000-0000-0000-000000000001', 'ASL Ambina', v.total, v.total,
       v.paid, v.total - v.paid, 'posted'
  FROM factories f,
  (VALUES ('ef000000-0000-0000-0000-000000000011', 'ASL-1', 20000, 5000),
          ('ef000000-0000-0000-0000-000000000012', 'ASL-2', 3000, 3000)) v(id, inv, total, paid)
 WHERE f.code = 'water';
INSERT INTO sale_items(id, sale_id, product_id, quantity, unit_price, line_total) VALUES
  ('ef000000-0000-0000-0000-000000000041', 'ef000000-0000-0000-0000-000000000011', 'ef000000-0000-0000-0000-000000000031', 10, 1700, 17000),
  ('ef000000-0000-0000-0000-000000000042', 'ef000000-0000-0000-0000-000000000011', 'ef000000-0000-0000-0000-000000000032', 10, 300, 3000),
  ('ef000000-0000-0000-0000-000000000043', 'ef000000-0000-0000-0000-000000000012', 'ef000000-0000-0000-0000-000000000032', 10, 300, 3000);
INSERT INTO debts(id, factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status)
SELECT 'ef000000-0000-0000-0000-000000000021', id, 'ef000000-0000-0000-0000-000000000001',
       'ef000000-0000-0000-0000-000000000011', 20000, 5000, 15000, 'partial'
  FROM factories WHERE code = 'water';
SELECT public._customer_ledger_post(
  (SELECT id FROM factories WHERE code = 'water'), 'ef000000-0000-0000-0000-000000000001', 'SALE', 'sale',
  'ef000000-0000-0000-0000-000000000011', 'ef000000-0000-0000-0000-000000000011', NULL,
  'ef000000-0000-0000-0000-000000000021', 20000, 5000, 0, 0, 15000, NULL, 'Sale ASL-1', NULL, NULL, NULL, NULL);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.fails(p_sql text, p_like text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE p_like THEN RAISE NOTICE 'unexpected error: %', SQLERRM; RETURN false; END IF;
  RETURN true;
END;
$$;

-- @@ Test 1: discount on one product and surcharge on another, in one save
DO $$
DECLARE s record; a record; b record; d record; c record; t record; l record;
BEGIN
  PERFORM set_config('test.uid', 'ee000000-0000-0000-0000-000000000001', false);
  PERFORM public.adjust_sale_lines('ef000000-0000-0000-0000-000000000011', jsonb_build_array(
    jsonb_build_object('item_id', 'ef000000-0000-0000-0000-000000000041', 'discount', 100),
    jsonb_build_object('item_id', 'ef000000-0000-0000-0000-000000000042', 'surcharge', 20)));
  SELECT * INTO a FROM sale_items WHERE id = 'ef000000-0000-0000-0000-000000000041';
  SELECT * INTO b FROM sale_items WHERE id = 'ef000000-0000-0000-0000-000000000042';
  PERFORM pg_temp.check(a.unit_discount = 100 AND a.discount = 1000 AND a.surcharge = 0 AND a.line_total = 16000, '75cl: ' || row_to_json(a)::text);
  PERFORM pg_temp.check(b.unit_surcharge = 20 AND b.discount = 0 AND b.surcharge = 200 AND b.line_total = 3200, '50cl: ' || row_to_json(b)::text);
  SELECT * INTO s FROM sales WHERE id = 'ef000000-0000-0000-0000-000000000011';
  PERFORM pg_temp.check(s.subtotal = 19200 AND s.grand_total = 19200 AND s.balance = 14200 AND s.amount_paid = 5000,
                        'sale: ' || row_to_json(s)::text);
  SELECT * INTO d FROM debts WHERE id = 'ef000000-0000-0000-0000-000000000021';
  PERFORM pg_temp.check(d.total_amount = 19200 AND d.outstanding = 14200 AND d.status = 'partial', 'debt: ' || row_to_json(d)::text);
  SELECT * INTO c FROM customers WHERE id = 'ef000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(c.outstanding_balance = 14200, 'customer owes 14,200');
  SELECT * INTO t FROM customer_account_transactions
   WHERE customer_id = 'ef000000-0000-0000-0000-000000000001' ORDER BY seq DESC LIMIT 1;
  PERFORM pg_temp.check(t.txn_type = 'CREDIT_ADJUSTMENT' AND t.debt_delta = -800 AND t.debt_after = 14200,
                        'ledger: ' || row_to_json(t)::text);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'sale_line_adjustment'
                                   AND entity_id = 'ef000000-0000-0000-0000-000000000011'
                                   AND (new_value->>'discount')::numeric = 1000 AND (new_value->>'surcharge')::numeric = 200
                                   AND jsonb_array_length(new_value->'lines') = 2), 'audit trail');
  SELECT * INTO l FROM public.sale_invoice_lines(ARRAY['ef000000-0000-0000-0000-000000000011'::uuid])
   WHERE item_id = 'ef000000-0000-0000-0000-000000000041';
  PERFORM pg_temp.check(l.unit_discount = 100 AND l.discount = 1000 AND l.line_total = 16000 AND l.product_name = 'ASL 75cl Bottle Water',
                        'invoice line: ' || row_to_json(l)::text);
END $$;

-- @@ Test 2: a surcharge on a fully paid invoice opens a debt for the extra
DO $$
DECLARE s record; d record; c record;
BEGIN
  PERFORM set_config('test.uid', 'ee000000-0000-0000-0000-000000000001', false);
  PERFORM public.adjust_sale_lines('ef000000-0000-0000-0000-000000000012', jsonb_build_array(
    jsonb_build_object('item_id', 'ef000000-0000-0000-0000-000000000043', 'surcharge', 50)), 'Delivery');
  SELECT * INTO s FROM sales WHERE id = 'ef000000-0000-0000-0000-000000000012';
  PERFORM pg_temp.check(s.grand_total = 3500 AND s.balance = 500, 'sale: ' || row_to_json(s)::text);
  SELECT * INTO d FROM debts WHERE sale_id = 'ef000000-0000-0000-0000-000000000012';
  PERFORM pg_temp.check(d.outstanding = 500 AND d.status = 'unpaid' AND d.customer_id IS NOT NULL, 'debt: ' || row_to_json(d)::text);
  SELECT * INTO c FROM customers WHERE id = 'ef000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(c.outstanding_balance = 14700, 'customer owes 14,700');
END $$;

-- @@ Test 3: too much discount, a line from another invoice, nothing entered, and no payment rights are refused
DO $$
BEGIN
  PERFORM set_config('test.uid', 'ee000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.adjust_sale_lines('ef000000-0000-0000-0000-000000000012',
    '[{"item_id":"ef000000-0000-0000-0000-000000000043","discount":100}]')$q$, '%more than the balance%'),
    'discount over balance refused');
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.adjust_sale_lines('ef000000-0000-0000-0000-000000000011',
    '[{"item_id":"ef000000-0000-0000-0000-000000000041","discount":99999}]')$q$, '%more than its price per pack%'),
    'line below 0 refused');
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.adjust_sale_lines('ef000000-0000-0000-0000-000000000011',
    '[{"item_id":"ef000000-0000-0000-0000-000000000043","discount":10}]')$q$, '%not found%'), 'other invoice line refused');
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.adjust_sale_lines('ef000000-0000-0000-0000-000000000011',
    '[{"item_id":"ef000000-0000-0000-0000-000000000041"}]')$q$, '%at least one product%'), 'nothing entered refused');
  PERFORM set_config('test.uid', 'ee000000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.adjust_sale_lines('ef000000-0000-0000-0000-000000000011',
    '[{"item_id":"ef000000-0000-0000-0000-000000000041","discount":10}]')$q$, '%Insufficient permissions%'),
    'production refused');
END $$;
