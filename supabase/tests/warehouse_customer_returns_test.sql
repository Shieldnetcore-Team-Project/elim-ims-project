-- ============================================================================
-- Acceptance tests: customer_return_manual_lines
-- Same cases against the new names (20261102270000_warehouse_customer_returns.sql).
-- (20261102240000_customer_return_manual_lines.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Own factory. A distributor owes 5,000
-- brought forward from the old system (a debt on no sale) and bought 2 packs
-- of 75cl in this system. Products are returned by hand.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fe000000-0000-0000-0000-000000000001', 'crmtest', 'CRM Test Factory');
INSERT INTO auth.users(id, email) VALUES ('ae000000-0000-0000-0000-000000000001', 'admin@crm');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('ae000000-0000-0000-0000-000000000001', 'super_admin', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('de000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'CRM 75cl', 'Pack', 300, 50, 'finished'),
  ('de000000-0000-0000-0000-000000000002', 'fe000000-0000-0000-0000-000000000001', 'CRM Dispenser+Water', 'Piece', 1000, 50, 'finished');
INSERT INTO customers(id, factory_id, name, registered, sales_rep_id, outstanding_balance, credit_balance) VALUES
  ('ce000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'CRM Distributor', true, NULL, 5000, 0);
INSERT INTO debts(factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status) VALUES
  ('fe000000-0000-0000-0000-000000000001', 'ce000000-0000-0000-0000-000000000001', NULL, 5000, 0, 5000, 'unpaid');
-- Paid sale in this system: 2 packs.
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, subtotal, discount, vat,
                  grand_total, amount_paid, balance, payment_method, status, created_at)
VALUES ('5e000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'CRM-1', CURRENT_DATE - 1,
        'ce000000-0000-0000-0000-000000000001', 'CRM Distributor', 600, 0, 0, 600, 600, 0, 'cash', 'posted',
        now() - interval '1 day');
INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, discount, line_total) VALUES
  ('5e000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-000000000001', 2, 300, 0, 600);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: 10 packs by hand -- 2 against the sale (paid: credit), 8 on no sale off the b/f debt
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
  r := public.warehouse_receive_customer_return(jsonb_build_object(
         'customer_id', 'ce000000-0000-0000-0000-000000000001', 'all_products', true,
         'items', jsonb_build_array(jsonb_build_object('product_id', 'de000000-0000-0000-0000-000000000001', 'quantity', 10))));
  -- 2 × 300 on the paid sale = 600 credit; 8 × 300 = 2,400 off the 5,000 b/f.
  PERFORM pg_temp.check((r->>'value')::numeric = 3000 AND (r->>'debt_reduced')::numeric = 2400
                        AND (r->>'credit_added')::numeric = 600, 'money: ' || r::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'de000000-0000-0000-0000-000000000001') = 60, 'stock +10');
  PERFORM pg_temp.check((SELECT outstanding FROM debts WHERE customer_id = 'ce000000-0000-0000-0000-000000000001' AND sale_id IS NULL) = 2600
                        AND (SELECT status FROM debts WHERE customer_id = 'ce000000-0000-0000-0000-000000000001' AND sale_id IS NULL) = 'partial',
                        'b/f debt 2,600 left');
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'ce000000-0000-0000-0000-000000000001') = 2600
                        AND (SELECT credit_balance FROM customers WHERE id = 'ce000000-0000-0000-0000-000000000001') = 600, 'customer');
  PERFORM pg_temp.check((SELECT count(*) FROM sales_returns WHERE customer_id = 'ce000000-0000-0000-0000-000000000001' AND sale_id IS NULL) = 1
                        AND (SELECT count(*) FROM sales_returns WHERE customer_id = 'ce000000-0000-0000-0000-000000000001' AND sale_id IS NOT NULL) = 1,
                        'one return row on the sale, one on no sale');
  PERFORM pg_temp.check((SELECT debt_after FROM customer_account_transactions
                          WHERE customer_id = 'ce000000-0000-0000-0000-000000000001' ORDER BY seq DESC LIMIT 1) IS NOT NULL, 'ledger posted');
END $$;

-- @@ Test 2: more than they owe -- the b/f debt is cleared, the rest is credit
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
  r := public.warehouse_receive_customer_return(jsonb_build_object(
         'customer_id', 'ce000000-0000-0000-0000-000000000001', 'all_products', true,
         'items', jsonb_build_array(jsonb_build_object('product_id', 'de000000-0000-0000-0000-000000000002', 'quantity', 3))));
  -- 3,000: 2,600 clears the debt, 400 credit.
  PERFORM pg_temp.check((r->>'debt_reduced')::numeric = 2600 AND (r->>'credit_added')::numeric = 400, 'money: ' || r::text);
  PERFORM pg_temp.check((SELECT status FROM debts WHERE customer_id = 'ce000000-0000-0000-0000-000000000001' AND sale_id IS NULL) = 'paid', 'debt paid');
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'ce000000-0000-0000-0000-000000000001') = 0
                        AND (SELECT credit_balance FROM customers WHERE id = 'ce000000-0000-0000-0000-000000000001') = 1000, 'customer');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'de000000-0000-0000-0000-000000000002') = 53, 'dispensers +3');
END $$;

-- @@ Test 3: the dispenser-only return still takes only what was bought
DO $$
BEGIN
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.warehouse_receive_customer_return(jsonb_build_object(
         'customer_id', 'ce000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'de000000-0000-0000-0000-000000000002', 'quantity', 1))))$q$)
         IS NOT NULL, 'refused without all_products');
END $$;

-- @@ Test 4: "Dispenser Jug" -- a finished product supplied to customers -- comes back as a dispenser (20261102250000)
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
  INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
    ('de000000-0000-0000-0000-000000000003', 'fe000000-0000-0000-0000-000000000001', 'Dispenser Jug', 'Piece', 1000, 0, 'finished');
  INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, subtotal, discount, vat,
                    grand_total, amount_paid, balance, payment_method, status, created_at)
  VALUES ('5e000000-0000-0000-0000-000000000002', 'fe000000-0000-0000-0000-000000000001', 'CRM-2', CURRENT_DATE,
          'ce000000-0000-0000-0000-000000000001', 'CRM Distributor', 17000, 0, 0, 17000, 17000, 0, 'cash', 'posted', now());
  INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, discount, line_total) VALUES
    ('5e000000-0000-0000-0000-000000000002', 'de000000-0000-0000-0000-000000000003', 17, 1000, 0, 17000);
  PERFORM pg_temp.check((SELECT returnable FROM public.warehouse_customer_returnable('ce000000-0000-0000-0000-000000000001')
                          WHERE name = 'Dispenser Jug') = 17, 'listed: 17 can come back');
  r := public.warehouse_receive_customer_return(jsonb_build_object(
         'customer_id', 'ce000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'de000000-0000-0000-0000-000000000003', 'quantity', 6))));
  PERFORM pg_temp.check((r->>'value')::numeric = 6000, 'six back: ' || r::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'de000000-0000-0000-0000-000000000003') = 6, 'stock +6');
END $$;

-- @@ Test 5: NNOLI's case -- 6 Dispenser Jug back WITHOUT all_products (the old "not a dispenser" refusal is gone)
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
  -- Even if the name test said no, the return goes through.
  UPDATE products SET name = 'Dispenser Jug', product_type = 'semi_finished' WHERE id = 'de000000-0000-0000-0000-000000000003';
  r := public.warehouse_receive_customer_return(jsonb_build_object(
         'customer_id', 'ce000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'de000000-0000-0000-0000-000000000003', 'quantity', 6))));
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'de000000-0000-0000-0000-000000000003') = 12, 'stock +6 again');
  -- Never more than bought: 17 bought, 12 back so far, 6 more refused.
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.warehouse_receive_customer_return(jsonb_build_object(
         'customer_id', 'ce000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'de000000-0000-0000-0000-000000000003', 'quantity', 6))))$q$)
         LIKE '%bought only%', 'capped at 17');
END $$;
