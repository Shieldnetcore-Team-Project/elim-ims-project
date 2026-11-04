-- ============================================================================
-- Acceptance tests: day_postings (20261104100000_day_postings_report.sql)
-- ============================================================================
INSERT INTO factories(id, code, name) VALUES ('f9300000-0000-0000-0000-000000000001', 'dpfac', 'DP Factory');
INSERT INTO auth.users(id, email) VALUES ('a4300000-0000-0000-0000-000000000001', 'acct@dp');
INSERT INTO roles(slug, label, is_system) VALUES ('dp_acct_test', 'Accounts (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action) VALUES ('dp_acct_test', 'finance', 'view') ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id)
VALUES ('a4300000-0000-0000-0000-000000000001', 'dp_acct_test', 'f9300000-0000-0000-0000-000000000001');
SELECT set_config('test.uid', 'a4300000-0000-0000-0000-000000000001', false);

-- @@ a day with nothing posted returns no rows
DO $$ BEGIN
  IF (SELECT count(*) FROM public.day_postings('f9300000-0000-0000-0000-000000000001', '2026-11-04')) <> 0 THEN
    RAISE EXCEPTION 'expected no rows';
  END IF;
END $$;

-- @@ an end date before the start is refused
DO $$ BEGIN
  PERFORM * FROM public.day_postings('f9300000-0000-0000-0000-000000000001', '2026-11-04', '2026-11-01');
  RAISE EXCEPTION 'should have failed';
EXCEPTION WHEN others THEN
  IF SQLERRM NOT LIKE '%before the start%' THEN RAISE; END IF;
END $$;

-- @@ someone without finance / distribution view is refused
DO $$ BEGIN
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000ff', false);
  PERFORM * FROM public.day_postings('f9300000-0000-0000-0000-000000000001', '2026-11-04');
  RAISE EXCEPTION 'should have failed';
EXCEPTION WHEN others THEN
  IF SQLERRM NOT LIKE '%Insufficient%' THEN RAISE; END IF;
END $$;
