-- ============================================================================
-- Acceptance tests: 20261114110000_gifts_in_warehouse_lists.sql
--   Every Chairman's gift shows on the Warehouse's Recent activity
--   (warehouse_transactions) and Activity Log (warehouse_activity), on its
--   own gift date, with who posted it.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('8b100000-0000-0000-0000-000000000001', 'boss@giftlist');
INSERT INTO profiles(id, email, full_name)
SELECT '8b100000-0000-0000-0000-000000000001', 'boss@giftlist', 'List Boss'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '8b100000-0000-0000-0000-000000000001');
UPDATE profiles SET full_name = 'List Boss' WHERE id = '8b100000-0000-0000-0000-000000000001';
DELETE FROM user_roles WHERE user_id = '8b100000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('8b100000-0000-0000-0000-000000000001', 'super_admin', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO products(id, factory_id, name, unit, unit_price, cost_price, current_stock, product_type) VALUES
  ('8e100000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'GL 75cl', 'Pack', 1700, 1000, 100, 'finished');
SELECT set_config('test.uid', '8b100000-0000-0000-0000-000000000001', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: a gift today shows on Recent activity and the Activity Log
DO $$
DECLARE v jsonb; r record; f uuid := (SELECT id FROM factories WHERE code = 'water');
  today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  v := public.post_chairmans_gift(jsonb_build_object('factory_id', f, 'recipient', 'Pastor Visit',
         'items', jsonb_build_array(jsonb_build_object('product_id', '8e100000-0000-0000-0000-000000000001', 'quantity', 7))));
  SELECT * INTO r FROM public.warehouse_transactions(f, 200) t WHERE t.reference = v->>'gift_number';
  PERFORM pg_temp.check(FOUND, 'gift on Recent activity');
  PERFORM pg_temp.check(r.kind = 'gift' AND r.party = 'Chairman''s gift — Pastor Visit', 'kind / party: ' || r.party);
  PERFORM pg_temp.check(r.items = 'GL 75cl × 7' AND r.quantity = 7, 'items: ' || r.items);
  SELECT * INTO r FROM public.warehouse_activity(f, today, today) a WHERE a.reference = v->>'gift_number';
  PERFORM pg_temp.check(FOUND, 'gift on the Activity Log');
  PERFORM pg_temp.check(r.kind = 'gift' AND r.posted_by = 'List Boss', 'posted by: ' || COALESCE(r.posted_by, 'null'));
  -- Not in a marketer's / distributor's own window.
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.warehouse_transactions(f, 200, gen_random_uuid()) t
                                     WHERE t.kind = 'gift'), 'not in a party window');
END $$;

-- @@ Test 2: a back-dated gift sits on its gift date
DO $$
DECLARE v jsonb; f uuid := (SELECT id FROM factories WHERE code = 'water');
  d date := (now() AT TIME ZONE 'Africa/Lagos')::date - 3;
BEGIN
  v := public.post_chairmans_gift(jsonb_build_object('factory_id', f, 'gift_date', d,
         'items', jsonb_build_array(jsonb_build_object('product_id', '8e100000-0000-0000-0000-000000000001', 'quantity', 2))));
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.warehouse_activity(f, d, d) a WHERE a.reference = v->>'gift_number'),
                        'on its gift date');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.warehouse_activity(f, d + 3, d + 3) a
                                     WHERE a.reference = v->>'gift_number'), 'not on the day it was entered');
  PERFORM pg_temp.check((SELECT a.party FROM public.warehouse_activity(f, d, d) a WHERE a.reference = v->>'gift_number')
                        = 'Chairman''s gift', 'no recipient: plain label');
END $$;
