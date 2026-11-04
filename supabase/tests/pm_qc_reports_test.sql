-- ============================================================================
-- Acceptance tests: Production › QC Reports, ticked person by person
-- (20261104210000_pm_qc_reports.sql)
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9b00000-0000-0000-0000-000000000001', 'pqfac', 'PQ Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a9b00000-0000-0000-0000-000000000001', 'pm@pq'),
  ('a9b00000-0000-0000-0000-000000000002', 'line@pq');
DELETE FROM user_roles WHERE user_id::text LIKE 'a9b00000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a9b00000-0000-0000-0000-000000000001', 'sales', 'f9b00000-0000-0000-0000-000000000001'),
  ('a9b00000-0000-0000-0000-000000000002', 'sales', 'f9b00000-0000-0000-0000-000000000001');
INSERT INTO user_page_access(user_id, page_id, granted) VALUES
  ('a9b00000-0000-0000-0000-000000000001', 'Production › QC Reports', true);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: the ticked PM runs every QC report; someone not ticked is refused
DO $$
DECLARE q text := $q$SELECT count(*) FROM public.%s('f9b00000-0000-0000-0000-000000000001', CURRENT_DATE, CURRENT_DATE%s)$q$;
BEGIN
  PERFORM set_config('test.uid', 'a9b00000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(pg_temp.err(format(q, 'qc_preform_report', '')) IS NULL, 'preform report');
  PERFORM pg_temp.check(pg_temp.err(format(q, 'qc_bottle_report', '')) IS NULL, 'bottle report');
  PERFORM pg_temp.check(pg_temp.err(format(q, 'jug_accountability_report', ', NULL')) IS NULL, 'jugs posted & returned');
  PERFORM pg_temp.check(pg_temp.err($q$SELECT count(*) FROM public.jug_locations('f9b00000-0000-0000-0000-000000000001', CURRENT_DATE)$q$) IS NULL,
                        'where the jugs are');
  PERFORM set_config('test.uid', 'a9b00000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.err(format(q, 'qc_preform_report', '')) LIKE '%Insufficient%', 'not ticked: refused');
END $$;
