-- ============================================================================
-- Acceptance tests: Production page only for Blessing
-- (20261027140000_blessing_production_page_only.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The migration matches "blessing"; this
-- runs the same function for a test account.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('8c000000-0000-0000-0000-000000000001', 'prodonly-tester@elim.test');
INSERT INTO profiles(id, email, full_name)
SELECT '8c000000-0000-0000-0000-000000000001', 'prodonly-tester@elim.test', 'Production Only Tester'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '8c000000-0000-0000-0000-000000000001');
DELETE FROM user_roles WHERE user_id = '8c000000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT '8c000000-0000-0000-0000-000000000001', 'production', f.id FROM factories f WHERE f.code = 'water';
-- She had Quality Control granted before, and some page decided earlier.
INSERT INTO user_page_access(user_id, page_id, granted) VALUES
  ('8c000000-0000-0000-0000-000000000001', 'Quality Control › Inspections', true),
  ('8c000000-0000-0000-0000-000000000001', 'Some Old Page', true);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: only the Production page is left
DO $$
DECLARE u uuid := '8c000000-0000-0000-0000-000000000001'; msg text;
BEGIN
  msg := public._production_page_only_for('prodonly-tester');
  PERFORM pg_temp.check(msg LIKE '%now has only the Production page%', msg);
  PERFORM pg_temp.check((SELECT granted FROM user_page_access WHERE user_id = u AND page_id = 'Production › Production'),
                        'Production page allowed');
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access WHERE user_id = u AND granted) = 1,
                        'no other page allowed');
  PERFORM pg_temp.check((SELECT NOT granted FROM user_page_access WHERE user_id = u AND page_id = 'Quality Control › Inspections')
                        AND (SELECT NOT granted FROM user_page_access WHERE user_id = u AND page_id = 'Quality Control › Good bottles')
                        AND (SELECT NOT granted FROM user_page_access WHERE user_id = u AND page_id = 'Some Old Page'),
                        'Quality Control and earlier pages blocked');
  PERFORM pg_temp.check(public.has_permission(u, 'production'::module_key, 'create'::action_key), 'can post batches');
  -- Running it again changes nothing.
  msg := public._production_page_only_for('prodonly-tester');
  PERFORM pg_temp.check((SELECT count(*) FROM user_page_access WHERE user_id = u AND granted) = 1, 'idempotent');
  msg := public._production_page_only_for('nobody-matches-this');
  PERFORM pg_temp.check(msg LIKE 'Skipped: 0 accounts%', 'no match changes nothing: ' || msg);
END $$;
