-- ============================================================================
-- Acceptance tests: customer_dispenser_returns
-- (20261102120000_customer_dispenser_returns.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Own factory. A distributor bought 10
-- dispensers from the Warehouse (part paid); a marketer's customer bought 4
-- from the marketer's van. The Warehouse takes unsold ones back from both.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fd000000-0000-0000-0000-000000000001', 'cdrtest', 'CDR Test Factory');
INSERT INTO auth.users(id, email) VALUES ('ad000000-0000-0000-0000-000000000001', 'admin@cdr'),
                                         ('ad000000-0000-0000-0000-000000000002', 'nobody@cdr');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('ad000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('ad000000-0000-0000-0000-000000000002', 'production', 'fd000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;
INSERT INTO sales_reps(id, factory_id, code, full_name, status, kind) VALUES
  ('ed000000-0000-0000-0000-000000000001', 'fd000000-0000-0000-0000-000000000001', 'CD-01', 'CDR Marketer', 'active', 'rep');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('dd000000-0000-0000-0000-000000000001', 'fd000000-0000-0000-0000-000000000001', 'CDR Dispenser+Water', 'Piece', 1000, 50, 'finished'),
  ('dd000000-0000-0000-0000-000000000002', 'fd000000-0000-0000-0000-000000000001', 'CDR 75cl', 'Pack', 300, 50, 'finished');
INSERT INTO customers(id, factory_id, name, registered, sales_rep_id, outstanding_balance, credit_balance) VALUES
  ('cd000000-0000-0000-0000-000000000001', 'fd000000-0000-0000-0000-000000000001', 'CDR Distributor', true, NULL, 6000, 0),
  ('cd000000-0000-0000-0000-000000000002', 'fd000000-0000-0000-0000-000000000001', 'CDR Shop Owner', true,
   'ed000000-0000-0000-0000-000000000001', 0, 0);
-- Warehouse sale: 10 dispensers + 5 packs, 4,000 paid, 6,000 owed (on the dispensers' invoice).
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, subtotal, discount, vat,
                  grand_total, amount_paid, balance, payment_method, status, created_at)
VALUES ('5d000000-0000-0000-0000-000000000001', 'fd000000-0000-0000-0000-000000000001', 'CDR-1', CURRENT_DATE - 2,
        'cd000000-0000-0000-0000-000000000001', 'CDR Distributor', 11500, 0, 0, 11500, 5500, 6000, 'cash', 'posted',
        now() - interval '2 days');
INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, discount, line_total) VALUES
  ('5d000000-0000-0000-0000-000000000001', 'dd000000-0000-0000-0000-000000000001', 10, 1000, 0, 10000),
  ('5d000000-0000-0000-0000-000000000001', 'dd000000-0000-0000-0000-000000000002', 5, 300, 0, 1500);
INSERT INTO debts(factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status) VALUES
  ('fd000000-0000-0000-0000-000000000001', 'cd000000-0000-0000-0000-000000000001', '5d000000-0000-0000-0000-000000000001',
   11500, 5500, 6000, 'partial');
-- The marketer's van sale: 4 dispensers, fully paid.
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, subtotal, discount, vat,
                  grand_total, amount_paid, balance, payment_method, status, sales_rep_id, created_at)
VALUES ('5d000000-0000-0000-0000-000000000002', 'fd000000-0000-0000-0000-000000000001', 'CDR-2', CURRENT_DATE - 1,
        'cd000000-0000-0000-0000-000000000002', 'CDR Shop Owner', 4000, 0, 0, 4000, 4000, 0, 'cash', 'posted',
        'ed000000-0000-0000-0000-000000000001', now() - interval '1 day');
INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, discount, line_total) VALUES
  ('5d000000-0000-0000-0000-000000000002', 'dd000000-0000-0000-0000-000000000001', 4, 1000, 0, 4000);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: setup -- the dispenser carries a jug; returnable lists dispensers only
DO $$
DECLARE v uuid;
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000001', false);
  v := public.save_container_type('fd000000-0000-0000-0000-000000000001', NULL, 'CDR Jug');
  PERFORM public.set_product_jug_role('dd000000-0000-0000-0000-000000000001', v, 1, 'with_water');
  PERFORM pg_temp.check((SELECT count(*) FROM public.customer_returnable_dispensers('cd000000-0000-0000-0000-000000000001')) = 1
                        AND (SELECT returnable FROM public.customer_returnable_dispensers('cd000000-0000-0000-0000-000000000001')) = 10,
                        'distributor can return 10 dispensers, not the 75cl');
END $$;

-- @@ Test 2: a distributor's unsold dispensers: owed first, Warehouse stock back, jugs back
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000001', false);
  r := public.receive_customer_dispenser_return(jsonb_build_object(
         'customer_id', 'cd000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'dd000000-0000-0000-0000-000000000001', 'quantity', 7))));
  -- Worth 7,000: 6,000 owed cleared, 1,000 already paid kept as credit.
  PERFORM pg_temp.check((r->>'value')::numeric = 7000 AND (r->>'debt_reduced')::numeric = 6000
                        AND (r->>'credit_added')::numeric = 1000, 'money: ' || r::text);
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'cd000000-0000-0000-0000-000000000001') = 0
                        AND (SELECT credit_balance FROM customers WHERE id = 'cd000000-0000-0000-0000-000000000001') = 1000, 'customer');
  PERFORM pg_temp.check((SELECT grand_total FROM sales WHERE id = '5d000000-0000-0000-0000-000000000001') = 4500
                        AND (SELECT balance FROM sales WHERE id = '5d000000-0000-0000-0000-000000000001') = 0, 'sale');
  PERFORM pg_temp.check((SELECT status FROM debts WHERE sale_id = '5d000000-0000-0000-0000-000000000001') = 'paid', 'debt');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'dd000000-0000-0000-0000-000000000001') = 57, 'stock back');
  PERFORM pg_temp.check((SELECT sum(quantity) FROM container_movements WHERE source = 'sales_return'
                          AND from_type = 'customer' AND to_type = 'warehouse'
                          AND from_id = 'cd000000-0000-0000-0000-000000000001') = 7, 'jugs back to the Warehouse');
  PERFORM pg_temp.check((SELECT returnable FROM public.customer_returnable_dispensers('cd000000-0000-0000-0000-000000000001')) = 3, '3 left');
  -- More than bought is refused.
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.receive_customer_dispenser_return(jsonb_build_object(
         'customer_id', 'cd000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'dd000000-0000-0000-0000-000000000001', 'quantity', 4))))$q$)
         LIKE '%bought only%', 'over-return refused');
END $$;

-- @@ Test 3: a marketer's customer: through the marketer's stock into the Warehouse, marketer credited
DO $$
DECLARE r jsonb; rr uuid;
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000001', false);
  r := public.receive_customer_dispenser_return(jsonb_build_object(
         'customer_id', 'cd000000-0000-0000-0000-000000000002',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'dd000000-0000-0000-0000-000000000001', 'quantity', 3))));
  PERFORM pg_temp.check((r->>'credit_added')::numeric = 3000 AND jsonb_array_length(r->'rep_returns') = 1, r::text);
  PERFORM pg_temp.check((SELECT credit_balance FROM customers WHERE id = 'cd000000-0000-0000-0000-000000000002') = 3000, 'paid -> credit');
  PERFORM pg_temp.check(COALESCE((SELECT quantity FROM rep_stock WHERE sales_rep_id = 'ed000000-0000-0000-0000-000000000001'
                          AND product_id = 'dd000000-0000-0000-0000-000000000001'), 0) = 0, 'not left on the van');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'dd000000-0000-0000-0000-000000000001') = 60, 'into Warehouse');
  rr := (SELECT id FROM rep_returns WHERE sales_rep_id = 'ed000000-0000-0000-0000-000000000001' AND status = 'completed');
  PERFORM pg_temp.check(rr IS NOT NULL AND (SELECT accepted_quantity FROM rep_return_items WHERE rep_return_id = rr) = 3,
                        'marketer credited by a return');
  -- Jugs: customer -> marketer -> Warehouse.
  PERFORM pg_temp.check((SELECT sum(quantity) FROM container_movements WHERE source = 'sales_return'
                          AND from_id = 'cd000000-0000-0000-0000-000000000002' AND to_type = 'sales_rep') = 3
                        AND (SELECT sum(quantity) FROM container_movements WHERE rep_return_id = rr
                              AND from_type = 'sales_rep' AND to_type = 'warehouse') = 3, 'jugs');
END $$;

-- @@ Test 4: no rights, refused
DO $$
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.err($q$SELECT * FROM public.customer_returnable_dispensers('cd000000-0000-0000-0000-000000000001')$q$)
                        LIKE '%Insufficient%', 'read refused');
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.receive_customer_dispenser_return(jsonb_build_object(
         'customer_id', 'cd000000-0000-0000-0000-000000000001', 'items', '[]'::jsonb))$q$) LIKE '%Insufficient%', 'write refused');
END $$;

-- @@ Test 5: Warehouse → Returns: any product from a Distributor/Office Delivery customer
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', 'ad000000-0000-0000-0000-000000000001', false);
  -- Without all_products the 75cl is refused; with it, it comes back.
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.receive_customer_dispenser_return(jsonb_build_object(
         'customer_id', 'cd000000-0000-0000-0000-000000000001',
         'items', jsonb_build_array(jsonb_build_object('product_id', 'dd000000-0000-0000-0000-000000000002', 'quantity', 2))))$q$)
         LIKE '%not a dispenser%', 'dispensers-only by default');
  PERFORM pg_temp.check((SELECT returnable FROM public.customer_returnable_dispensers('cd000000-0000-0000-0000-000000000001', true)
                          WHERE name = 'CDR 75cl') = 5, '75cl listed with p_all');
  r := public.receive_customer_dispenser_return(jsonb_build_object(
         'customer_id', 'cd000000-0000-0000-0000-000000000001', 'all_products', true,
         'items', jsonb_build_array(jsonb_build_object('product_id', 'dd000000-0000-0000-0000-000000000002', 'quantity', 2))));
  PERFORM pg_temp.check((r->>'value')::numeric = 600 AND (r->>'credit_added')::numeric = 600, r::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'dd000000-0000-0000-0000-000000000002') = 52, '75cl back');
  PERFORM pg_temp.check((SELECT credit_balance FROM customers WHERE id = 'cd000000-0000-0000-0000-000000000001') = 1600, 'credit');
END $$;
