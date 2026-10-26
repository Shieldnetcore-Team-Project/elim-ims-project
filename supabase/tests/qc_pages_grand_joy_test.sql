-- ============================================================================
-- Acceptance test: every Quality Control tab for Grand Joy
-- (20261026090000_qc_pages_grand_joy.sql)
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('8f000000-0000-0000-0000-000000000001', 'qcgj', 'QC GJ Factory');
INSERT INTO auth.users(id, email) VALUES
  ('8a000000-0000-0000-0000-000000000001', 'grandjoy@qcgj'),
  ('8a000000-0000-0000-0000-000000000002', 'other@qcgj');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, CASE WHEN u.email LIKE 'grand%' THEN 'Grand Joy' ELSE 'Someone Else' END FROM auth.users u
 WHERE u.id::text LIKE '8a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
UPDATE profiles SET full_name = 'Grand Joy' WHERE id = '8a000000-0000-0000-0000-000000000001';
DELETE FROM user_roles WHERE user_id::text LIKE '8a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('8a000000-0000-0000-0000-000000000001', 'qc_officer', '8f000000-0000-0000-0000-000000000001'),
  ('8a000000-0000-0000-0000-000000000002', 'qc_officer', '8f000000-0000-0000-0000-000000000001');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: Grand Joy gets the three QC pages and their view rights; nobody else changes; safe to run again
DO $$
DECLARE gj uuid := '8a000000-0000-0000-0000-000000000001'; msg text;
BEGIN
  msg := public._grant_qc_pages_for('grand joy');
  PERFORM pg_temp.check(msg LIKE 'Grand Joy now has%', msg);
  msg := public._grant_qc_pages_for('grand joy');
  PERFORM pg_temp.check(msg LIKE 'Grand Joy now has%', 'runs twice: ' || msg);
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access WHERE user_id = gj AND granted
                          AND page_id IN ('Quality Control › Inspections', 'Quality Control › Good bottles',
                                          'Quality Control › Bottle tracking')) = 3, 'three pages');
  PERFORM pg_temp.check(public.has_permission(gj, 'goods-receiving'::module_key, 'view'::action_key)
                    AND public.has_permission(gj, 'preform-production'::module_key, 'view'::action_key)
                    AND public.has_permission(gj, 'distribution'::module_key, 'view'::action_key), 'view rights');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM user_page_access WHERE user_id = '8a000000-0000-0000-0000-000000000002'),
                        'other QC account untouched');
  PERFORM pg_temp.check(public._grant_qc_pages_for('nobody-by-this-name') LIKE 'Skipped: 0 accounts%', 'no match, no change');
END $$;
