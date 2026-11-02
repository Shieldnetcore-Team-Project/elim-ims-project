-- ============================================================================
-- Acceptance tests: warehouse_transactions (20261102160000_warehouse_transactions.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Own factory: a posting and a return for a
-- marketer, empty jugs recorded back, a distributor's sale -- each row names
-- its party; p_party narrows to one.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fe000000-0000-0000-0000-000000000001', 'wttest', 'WT Test Factory');
INSERT INTO auth.users(id, email) VALUES ('ae000000-0000-0000-0000-0000000000a1', 'admin@wt');
INSERT INTO user_roles(user_id, role, factory_id) VALUES ('ae000000-0000-0000-0000-0000000000a1', 'super_admin', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO sales_reps(id, factory_id, code, full_name, status, kind) VALUES
  ('ee000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'WT-01', 'WT Marketer', 'active', 'rep');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('de000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'WT 75cl', 'Pack', 300, 50, 'finished');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('ce000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'WT Distributor', true);
INSERT INTO stock_dispatches(id, factory_id, dispatch_number, dispatch_date, sales_rep_id, total_value)
VALUES ('9e000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'WT-DSP-1', CURRENT_DATE,
        'ee000000-0000-0000-0000-000000000001', 3000);
INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value)
VALUES ('9e000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-000000000001', 10, 300, 3000);
INSERT INTO rep_returns(id, factory_id, return_number, sales_rep_id, return_date, status, received_by)
VALUES ('9e000000-0000-0000-0000-000000000002', 'fe000000-0000-0000-0000-000000000001', 'WT-RRN-1',
        'ee000000-0000-0000-0000-000000000001', CURRENT_DATE, 'completed', 'ae000000-0000-0000-0000-0000000000a1');
INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price, accepted_quantity)
VALUES ('9e000000-0000-0000-0000-000000000002', 'de000000-0000-0000-0000-000000000001', 3, 300, 3);
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, subtotal, discount, vat,
                  grand_total, amount_paid, balance, payment_method, status)
VALUES ('5e000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'WT-INV-1', CURRENT_DATE,
        'ce000000-0000-0000-0000-000000000001', 'WT Distributor', 600, 0, 0, 600, 0, 600, 'cash', 'posted');
INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, discount, line_total)
VALUES ('5e000000-0000-0000-0000-000000000001', 'de000000-0000-0000-0000-000000000001', 2, 300, 0, 600);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: every kind names its party; one party at a time
DO $$
DECLARE t uuid;
BEGIN
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-0000000000a1', false);
  t := public.save_container_type('fe000000-0000-0000-0000-000000000001', NULL, 'WT Jug');
  INSERT INTO jug_returns(factory_id, reference, sales_rep_id, container_type_id, quantity_claimed, recorded_by)
  VALUES ('fe000000-0000-0000-0000-000000000001', 'WT-JR-1', 'ee000000-0000-0000-0000-000000000001', t, 2,
          'ae000000-0000-0000-0000-0000000000a1');
  PERFORM pg_temp.check((SELECT count(*) FROM public.warehouse_transactions('fe000000-0000-0000-0000-000000000001', 100, NULL)) = 4, 'four rows');
  PERFORM pg_temp.check((SELECT array_agg(kind ORDER BY kind) FROM public.warehouse_transactions('fe000000-0000-0000-0000-000000000001', 100,
                          'ee000000-0000-0000-0000-000000000001')) = ARRAY['jugs_returned', 'marketer', 'returned'], 'marketer rows');
  PERFORM pg_temp.check((SELECT party_type FROM public.warehouse_transactions('fe000000-0000-0000-0000-000000000001', 100,
                          'ce000000-0000-0000-0000-000000000001')) = 'distributor', 'distributor row');
  PERFORM pg_temp.check((SELECT items FROM public.warehouse_transactions('fe000000-0000-0000-0000-000000000001', 100, NULL)
                          WHERE kind = 'returned') = 'WT 75cl × 3', 'return products');
END $$;
