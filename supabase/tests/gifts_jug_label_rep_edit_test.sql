-- ============================================================================
-- Acceptance tests: 20261108100000_jug_dispenser_name_gifts_rep_edit.sql
--   Chairman's gift counts as Gift/Sample on the Products Report (not Qty Out)
--   and shows in warehouse_gift_details; a permanent-jar line is "Jug + ...";
--   update_rep_details changes a marketer's name / phone / address.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('8b000000-0000-0000-0000-000000000001', 'boss@gift');
INSERT INTO profiles(id, email, full_name)
SELECT '8b000000-0000-0000-0000-000000000001', 'boss@gift', 'Gift Boss'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '8b000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '8b000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('8b000000-0000-0000-0000-000000000001', 'super_admin', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO products(id, factory_id, name, unit, unit_price, cost_price, current_stock, product_type) VALUES
  ('8e000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'GFT 75cl', 'Pack', 1700, 1000, 100, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, phone, kind) VALUES
  ('8c000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'Emma Old', '0800', 'rep');

SELECT set_config('test.uid', '8b000000-0000-0000-0000-000000000001', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: a Chairman's gift of 7 is Gift/Sample, not Qty Out, and listed
SELECT public.post_chairmans_gift(jsonb_build_object(
  'factory_id', (SELECT id FROM factories WHERE code = 'water'),
  'recipient', 'Pastor Visit', 'notes', 'Church event',
  'items', jsonb_build_array(jsonb_build_object('product_id', '8e000000-0000-0000-0000-000000000001', 'quantity', 7))));
SELECT pg_temp.check(r.gift = 7 AND r.qty_out = 0 AND r.balance = 93,
         format('report gift=%s out=%s bal=%s', r.gift, r.qty_out, r.balance))
  FROM public.warehouse_products_report((SELECT id FROM factories WHERE code = 'water'),
                                        (now() AT TIME ZONE 'Africa/Lagos')::date) r
 WHERE r.product_id = '8e000000-0000-0000-0000-000000000001';
SELECT pg_temp.check(count(*) = 1 AND max(g.quantity) = 7 AND max(g.given_to) = 'Pastor Visit'
                     AND max(g.kind) = 'Chairman''s gift' AND max(g.value) = 11900
                     AND max(g.posted_by) IN ('Gift Boss', 'boss@gift'), 'gift details line ' || COALESCE(json_agg(g)::text, 'none'))
  FROM public.warehouse_gift_details((SELECT id FROM factories WHERE code = 'water'),
                                     (now() AT TIME ZONE 'Africa/Lagos')::date,
                                     (now() AT TIME ZONE 'Africa/Lagos')::date) g
 WHERE g.product_id = '8e000000-0000-0000-0000-000000000001';

-- @@ Test 2: a permanent-jar line reads "Jug + ..."
INSERT INTO sales(id, factory_id, invoice_number, sale_date, status)
VALUES ('8d000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'GFT-INV-1', CURRENT_DATE, 'posted');
INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total, jar_mode) VALUES
  ('8d000000-0000-0000-0000-000000000001', '8e000000-0000-0000-0000-000000000001', 1, 4000, 4000, 'permanent'),
  ('8d000000-0000-0000-0000-000000000001', '8e000000-0000-0000-0000-000000000001', 1, 1000, 1000, 'swap');
SELECT pg_temp.check(
  (SELECT array_agg(product_name ORDER BY line_total DESC) FROM public.sale_invoice_lines(ARRAY['8d000000-0000-0000-0000-000000000001'::uuid]))
    = ARRAY['Jug + GFT 75cl', 'GFT 75cl'], 'Jug + label');

-- @@ Test 3: update_rep_details
SELECT public.update_rep_details('8c000000-0000-0000-0000-000000000001', 'Emmanuel', '0803', 'Lugbe, Abuja', NULL);
SELECT pg_temp.check(full_name = 'Emmanuel' AND phone = '0803' AND address = 'Lugbe, Abuja', 'rep edited')
  FROM sales_reps WHERE id = '8c000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  PERFORM public.update_rep_details('8c000000-0000-0000-0000-000000000001', '  ', NULL, NULL, NULL);
  RAISE EXCEPTION 'ASSERTION FAILED: blank name accepted';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'ASSERTION FAILED%' THEN RAISE; END IF;
END $$;

-- @@ Test 4: the From / To products report exists and counts the gift
SELECT pg_temp.check(r.opening = 100 AND r.gift = 7 AND r.qty_out = 0 AND r.balance = 93,
         format('range op=%s gift=%s out=%s bal=%s', r.opening, r.gift, r.qty_out, r.balance))
  FROM public.warehouse_products_report((SELECT id FROM factories WHERE code = 'water'),
                                        (now() AT TIME ZONE 'Africa/Lagos')::date - 7,
                                        (now() AT TIME ZONE 'Africa/Lagos')::date) r
 WHERE r.product_id = '8e000000-0000-0000-0000-000000000001';

-- @@ Test 5: a marketer's customer is read and edited through the functions
INSERT INTO customers(id, factory_id, name, phone)
VALUES ('8f000000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'AINA STORES', NULL);
SELECT public.update_marketer_customer('8f000000-0000-0000-0000-000000000001', 'Aina Stores Ltd', '0805', 'Wuse 2', NULL);
SELECT pg_temp.check(d.name = 'Aina Stores Ltd' AND d.phone = '0805' AND d.address = 'Wuse 2', 'customer edited')
  FROM public.marketer_customer_details('8f000000-0000-0000-0000-000000000001') d;
