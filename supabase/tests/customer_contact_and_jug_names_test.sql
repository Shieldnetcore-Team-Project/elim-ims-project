-- ============================================================================
-- Acceptance tests: 20261109120000_customer_contact_and_jug_names.sql
--   Dispenser Empty becomes Empty Jug (even beside a retired "Empty Jug"), the
--   Warehouse stocks and posts it with no jug owed, Jug + Water / prices show
--   for Accounts, and staff enter a customer's contact and address.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('a7300000-0000-0000-0000-000000000001', 'boss@cn'),
  ('a7300000-0000-0000-0000-000000000002', 'nobody@cn'),
  ('a7300000-0000-0000-0000-000000000003', 'gideon@cn');
DELETE FROM user_roles WHERE user_id::text LIKE 'a7300000-%';
INSERT INTO roles(slug, label, is_system) VALUES
  ('cn_none_test', 'No rights (test)', false),
  ('cn_wh_test', 'Warehouse (test)', false)
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'cn_wh_test', m::module_key, a::action_key
  FROM unnest(ARRAY['finished-goods', 'distribution', 'sales']) m,
       unnest(ARRAY['view', 'create']) a
ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a7300000-0000-0000-0000-000000000001', 'super_admin', (SELECT id FROM factories WHERE code = 'water')),
  ('a7300000-0000-0000-0000-000000000002', 'cn_none_test', (SELECT id FROM factories WHERE code = 'water')),
  ('a7300000-0000-0000-0000-000000000003', 'cn_wh_test', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO user_product_rules(user_id, name_pattern, label) VALUES
  ('a7300000-0000-0000-0000-000000000003', 'dispenser|jug water', 'Dispensers');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('a7200000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'HD VENTURE', true);

SELECT set_config('test.uid', 'a7300000-0000-0000-0000-000000000001', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.act(p_user text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('test.uid', 'a7300000-0000-0000-0000-00000000000' || p_user, false); END;
$$;

-- @@ Test 1: Dispenser Empty takes the name even beside a retired Empty Jug
UPDATE products SET active = false
 WHERE factory_id = (SELECT id FROM factories WHERE code = 'water') AND lower(name) = 'empty jug';
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('a7100000-0000-0000-0000-000000000002', (SELECT id FROM factories WHERE code = 'water'), 'Dispenser Empty', 'Piece', 3000, 9, 'finished');
SELECT public._adopt_empty_jug_name();
SELECT pg_temp.check(name = 'Empty Jug' AND active AND current_stock = 9 AND unit_price = 3000,
                     format('renamed: %s active=%s', name, active))
  FROM products WHERE id = 'a7100000-0000-0000-0000-000000000002';
SELECT pg_temp.check(count(*) = 1, format('active empty jugs: %s', count(*)))
  FROM products
 WHERE factory_id = (SELECT id FROM factories WHERE code = 'water') AND active
   AND (lower(name) = 'empty jug' OR lower(name) = 'dispenser empty');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM user_product_rules
                              WHERE user_id = 'a7300000-0000-0000-0000-000000000003'
                                AND 'Empty Jug' ~* name_pattern AND 'Jug + Water' ~* name_pattern),
                     'dispenser officer handles the new names');

-- @@ Test 2: line names and the price shown to Accounts
SELECT pg_temp.check(public._sale_line_name('Dispenser Water', 'permanent') = 'Jug + Water', 'permanent');
SELECT pg_temp.check(public._sale_line_name('Dispenser Water', 'swap') = 'Dispenser Water', 'swap');
SELECT pg_temp.check(public._sale_line_name('Empty Jug', NULL) = 'Empty Jug', 'empty');
SELECT pg_temp.check(public._posting_item('Empty Jug', 25, 3000) = 'Empty Jug × 25 @ 3,000',
                     public._posting_item('Empty Jug', 25, 3000));

-- @@ Test 3: the officer restocks Empty Jug; a dispenser still comes from Production
SELECT pg_temp.act('3');
SELECT public.warehouse_restock(jsonb_build_object(
  'factory_id', (SELECT id FROM factories WHERE code = 'water'),
  'product_id', 'a7100000-0000-0000-0000-000000000002', 'quantity', 11));
SELECT pg_temp.check(current_stock = 20, format('stock %s', current_stock))
  FROM products WHERE id = 'a7100000-0000-0000-0000-000000000002';
SELECT pg_temp.act('1');

-- @@ Test 4: the Empty Jug is linked to its jug type
DO $$
DECLARE t uuid;
BEGIN
  INSERT INTO container_types(factory_id, name, active)
  VALUES ((SELECT id FROM factories WHERE code = 'water'), 'CN Jug', true) RETURNING id INTO t;
  INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role)
  VALUES ('a7100000-0000-0000-0000-000000000002', t, 1, 'empty')
  ON CONFLICT (product_id, container_type_id) DO UPDATE SET jug_role = 'empty';
  PERFORM pg_temp.check(public._is_empty_jug_product('a7100000-0000-0000-0000-000000000002'), 'linked');
END $$;

-- @@ Test 5: its own row on the products report, with what it sold
SELECT pg_temp.check(r.balance = 20 AND r.qty_in >= 11, format('report in=%s bal=%s', r.qty_in, r.balance))
  FROM public.warehouse_products_report((SELECT id FROM factories WHERE code = 'water'),
                                        (now() AT TIME ZONE 'Africa/Lagos')::date,
                                        (now() AT TIME ZONE 'Africa/Lagos')::date) r
 WHERE r.product_id = 'a7100000-0000-0000-0000-000000000002';

-- @@ Test 6: Accounts sees the posted line with its price
INSERT INTO sales(id, factory_id, invoice_number, sale_date, status, customer_id, customer_name)
VALUES ('a7400000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'CN-INV-1',
        CURRENT_DATE, 'pending_approval', 'a7200000-0000-0000-0000-000000000001', 'HD VENTURE');
INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total) VALUES
  ('a7400000-0000-0000-0000-000000000001', 'a7100000-0000-0000-0000-000000000002', 2, 3000, 6000);
SELECT pg_temp.check(items = 'Empty Jug × 2 @ 3,000', items)
  FROM public.accounting_postings((SELECT id FROM factories WHERE code = 'water'), 1000)
 WHERE reference = 'CN-INV-1';

-- @@ Test 6b: sold outright, the buyer owes no jug
UPDATE sales SET status = 'posted' WHERE id = 'a7400000-0000-0000-0000-000000000001';
SELECT pg_temp.check(public._jug_customer_balance('a7200000-0000-0000-0000-000000000001',
                       (SELECT id FROM container_types WHERE name = 'CN Jug')) = 0, 'no jug owed');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM container_movements
                              WHERE sale_id = 'a7400000-0000-0000-0000-000000000001'
                                AND to_type = 'external' AND quantity = 2), 'jug left the ledger');

-- @@ Test 7: contact details are trimmed, audited and reach the invoice
SELECT public.update_customer_contact('a7200000-0000-0000-0000-000000000001', ' 0803 111 ', '  Kubwa, Abuja ');
SELECT pg_temp.check(phone = '0803 111' AND address = 'Kubwa, Abuja', 'saved')
  FROM customers WHERE id = 'a7200000-0000-0000-0000-000000000001';
SELECT pg_temp.check(EXISTS (SELECT 1 FROM audit_logs
                              WHERE entity = 'customers'
                                AND entity_id = 'a7200000-0000-0000-0000-000000000001'
                                AND new_value->>'phone' = '0803 111'), 'audited');
SELECT pg_temp.check(p->'customer'->>'phone' = '0803 111' AND p->'customer'->>'address' = 'Kubwa, Abuja', p::text)
  FROM public.sale_invoice_party('a7400000-0000-0000-0000-000000000001') p;

-- @@ Test 8: Warehouse may enter them; someone with no customer work may not
SELECT pg_temp.act('3');
SELECT public.update_customer_contact('a7200000-0000-0000-0000-000000000001', '0809', NULL);
SELECT pg_temp.check(phone = '0809' AND address IS NULL, 'blank clears')
  FROM public.customer_contact('a7200000-0000-0000-0000-000000000001');
SELECT pg_temp.act('2');
DO $$ BEGIN
  PERFORM public.update_customer_contact('a7200000-0000-0000-0000-000000000001', '1', '2');
  RAISE EXCEPTION 'ASSERTION FAILED: no-rights user saved';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'ASSERTION FAILED%' THEN RAISE; END IF;
  PERFORM pg_temp.check(SQLERRM = 'Insufficient permissions', SQLERRM);
END $$;
SELECT pg_temp.act('1');
