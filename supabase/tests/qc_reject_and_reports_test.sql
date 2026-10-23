-- ============================================================================
-- Acceptance tests: QC rejects a Store issue; QC preform and bottle reports
-- (20261023210000_qc_reject_and_reports.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test. The report figures are row 2 of the factory's printed preform report
-- (Preform 29mm, Prima 16.5g, 2026-09-02 to 2026-10-01).
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('7f000000-0000-0000-0000-000000000001', 'qcrr', 'QC Reports Factory');
INSERT INTO auth.users(id, email) VALUES
  ('7a000000-0000-0000-0000-000000000001', 'store@qcrr'),
  ('7a000000-0000-0000-0000-000000000002', 'qc@qcrr');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '7a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '7a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('7a000000-0000-0000-0000-000000000001', 'store_keeper', '7f000000-0000-0000-0000-000000000001'),
  ('7a000000-0000-0000-0000-000000000002', 'qc_officer', '7f000000-0000-0000-0000-000000000001');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform) VALUES
  ('7c000000-0000-0000-0000-000000000001', '7f000000-0000-0000-0000-000000000001', 'Caps QCRR', 'Piece', 1000, 10000, 10, NULL, false),
  ('7c000000-0000-0000-0000-000000000002', '7f000000-0000-0000-0000-000000000001', 'Preform 29mm', 'Piece', 0, 0, 1, 1152, true);
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('7d000000-0000-0000-0000-000000000001', '7f000000-0000-0000-0000-000000000001', '75cl bottles', 'Piece', 0, 0, 'finished');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '7a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: QC rejects a Store issue with a reason; it goes back into the Store
DO $$
DECLARE e text; rid uuid;
BEGIN
  PERFORM pg_temp.as_user('1');
  PERFORM public.issue_raw_material('{"material_id":"7c000000-0000-0000-0000-000000000001","quantity":200,"purpose":"general","issued_to_department":"quality_control"}');
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = '7c000000-0000-0000-0000-000000000001') = 800, 'issued 200');
  SELECT id INTO rid FROM qc_store_receipts WHERE material_id = '7c000000-0000-0000-0000-000000000001';
  e := pg_temp.err(format('SELECT public.qc_reject_store_receipt(%L, %L)', rid, 'Wrong caps'));
  PERFORM pg_temp.check(e LIKE '%Insufficient%' OR e LIKE '%You issued%', 'the Store cannot reject for QC: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format('SELECT public.qc_reject_store_receipt(%L, %L)', rid, ''));
  PERFORM pg_temp.check(e LIKE '%reason%', 'a reason is required: ' || COALESCE(e, 'no error'));
  PERFORM public.qc_reject_store_receipt(rid, 'Wrong caps, 28mm not 29mm');
  PERFORM pg_temp.check((SELECT status = 'rejected' AND reject_reason = 'Wrong caps, 28mm not 29mm'
                           AND rejected_by = '7a000000-0000-0000-0000-000000000002' FROM qc_store_receipts WHERE id = rid),
                        'rejected with reason');
  PERFORM pg_temp.check((SELECT current_stock = 1000 AND current_value = 10000 FROM raw_materials
                          WHERE id = '7c000000-0000-0000-0000-000000000001'), 'back in the Store at cost');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM raw_material_movements WHERE material_id = '7c000000-0000-0000-0000-000000000001'
                                  AND movement_type = 'returned' AND reason LIKE 'Rejected by Quality Control: Wrong caps%'),
                        'ledger shows the return and why');
  -- Confirming it afterwards changes nothing.
  PERFORM pg_temp.err(format('SELECT public.qc_confirm_store_receipt(%L)', rid));
  PERFORM pg_temp.check((SELECT status FROM qc_store_receipts WHERE id = rid) = 'rejected', 'stays rejected');
  e := pg_temp.err($q$SELECT public.qc_record_store_usage('{"material_id":"7c000000-0000-0000-0000-000000000001","quantity":1,"reason":"x"}')$q$);
  PERFORM pg_temp.check(e LIKE '%Only 0%', 'a rejected issue is never QC stock: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 2: the preform report matches the printed one
DO $$
DECLARE r record;
  op uuid := '7a000000-0000-0000-0000-000000000002';
  m uuid := '7c000000-0000-0000-0000-000000000002';
  f uuid := '7f000000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO preform_movements(factory_id, operator_id, material_id, movement_type, quantity, quantity_before, quantity_after, effective_date) VALUES
    (f, op, m, 'issue_in',          42624,      0,  42624, '2026-08-30'),   -- opening
    (f, op, m, 'issue_in',         787968,  42624, 830592, '2026-09-05'),   -- 684 bags x 1152
    (f, op, m, 'good_bottles',    -752118, 830592,  78474, '2026-09-20'),
    (f, op, m, 'damaged_bottles',   -2442,  78474,  76032, '2026-09-20'),
    (f, op, m, 'issue_in',            999,  76032,  77031, '2026-10-05');   -- after the period
  PERFORM pg_temp.as_user('2');
  SELECT * INTO r FROM public.qc_preform_report(f, '2026-09-02', '2026-10-01') WHERE material_id = m;
  PERFORM pg_temp.check(r.received_bags = 684 AND r.pieces_per_bag = 1152 AND r.opening = 42624 AND r.total = 830592
                        AND r.blown = 754560 AND r.damages = 2442 AND r.expected_bottles = 752118 AND r.balance = 76032,
                        'printed figures: ' || row_to_json(r)::text);
END $$;

-- @@ Test 3: the bottles report -- opening, in (good bottles stocked), released (sent to production), balance
DO $$
DECLARE r record; sr uuid;
  f uuid := '7f000000-0000-0000-0000-000000000001';
  p uuid := '7d000000-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO preform_shift_records(factory_id, reference, operator_id, material_id, production_date, shift, status, good_bottles)
  VALUES (f, 'QCRR-SR-1', '7a000000-0000-0000-0000-000000000002', '7c000000-0000-0000-0000-000000000002', '2026-09-20', 'day', 'completed', 752118)
  RETURNING id INTO sr;
  INSERT INTO preform_stockings(factory_id, reference, shift_record_id, product_id, expected_qty, counted_qty, accepted_qty, status, sent_at, received_at) VALUES
    (f, 'QCRR-ST-0', sr, p, 100, 100, 100, 'accepted', '2026-08-20 10:00+01', '2026-08-20 10:00+01'),        -- before: opening
    (f, 'QCRR-ST-1', sr, p, 751848, 751848, 751848, 'accepted', '2026-09-20 10:00+01', '2026-09-20 10:00+01'),
    (f, 'QCRR-ST-2', sr, p, 50, 50, NULL, 'rejected', '2026-09-21 10:00+01', '2026-09-21 10:00+01');       -- not stocked
  INSERT INTO bottle_transfers(factory_id, reference, product_id, to_department, quantity_sent, status, sent_at) VALUES
    (f, 'QCRR-BT-1', p, 'production', 751848, 'received', '2026-09-25 10:00+01'),
    (f, 'QCRR-BT-2', p, 'production', 40, 'cancelled', '2026-09-26 10:00+01');
  PERFORM pg_temp.as_user('2');
  SELECT * INTO r FROM public.qc_bottle_report(f, '2026-09-02', '2026-10-01') WHERE product_id = p;
  PERFORM pg_temp.check(r.opening = 100 AND r.quantity_in = 751848 AND r.total = 751948 AND r.released = 751848 AND r.balance = 100,
                        'bottles: ' || row_to_json(r)::text);
END $$;
