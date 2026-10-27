-- ============================================================================
-- Acceptance tests: no Quality Control, Warehouse or Store pages for Ruth
-- (20261027150000_ruth_no_qc_store_warehouse.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration matches "ruth"; this runs
-- the same function for a test account.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('8d000000-0000-0000-0000-000000000001', 'noqcsw-tester@elim.test');
INSERT INTO profiles(id, email, full_name)
SELECT '8d000000-0000-0000-0000-000000000001', 'noqcsw-tester@elim.test', 'No QC Store Warehouse Tester'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '8d000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '8d000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT '8d000000-0000-0000-0000-000000000001', 'accountant', f.id FROM factories f WHERE f.code = 'water';
INSERT INTO user_page_access(user_id, page_id, granted) VALUES
  ('8d000000-0000-0000-0000-000000000001', 'Quality Control › Inspections', true),
  ('8d000000-0000-0000-0000-000000000001', 'Finance Overview', true);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: QC, Warehouse and Store blocked, other pages kept
DO $$
DECLARE u uuid := '8d000000-0000-0000-0000-000000000001'; msg text;
BEGIN
  msg := public._no_qc_store_warehouse_for('noqcsw-tester');
  PERFORM pg_temp.check(msg LIKE '%no longer has the Quality Control, Warehouse or Store pages%', msg);
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM user_page_access WHERE user_id = u AND granted
                                     AND (page_id LIKE 'Quality Control › %' OR page_id LIKE 'Store › %'
                                          OR page_id LIKE 'Warehouse › %')),
                        'no QC, Store or Warehouse page allowed');
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access WHERE user_id = u AND NOT granted) = 17,
                        'all 17 pages blocked');
  PERFORM pg_temp.check((SELECT granted FROM user_page_access WHERE user_id = u AND page_id = 'Finance Overview'),
                        'other pages kept');
  msg := public._no_qc_store_warehouse_for('noqcsw-tester');
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access WHERE user_id = u AND NOT granted) = 17, 'idempotent');
  msg := public._no_qc_store_warehouse_for('nobody-matches-this');
  PERFORM pg_temp.check(msg LIKE 'Skipped: 0 accounts%', 'no match changes nothing: ' || msg);
END $$;
