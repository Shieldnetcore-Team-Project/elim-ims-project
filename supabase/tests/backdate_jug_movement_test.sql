-- ============================================================================
-- Acceptance tests: Record movement takes a date
-- (20261104160000_backdate_jug_movement_abiodun.sql)
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9700000-0000-0000-0000-000000000001', 'bjfac', 'BJ Factory');
INSERT INTO auth.users(id, email) VALUES ('a9700000-0000-0000-0000-000000000001', 'admin@bj');
DELETE FROM user_roles WHERE user_id = 'a9700000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('a9700000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e9700000-0000-0000-0000-000000000001', 'f9700000-0000-0000-0000-000000000001', 'Old Jug');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c9700000-0000-0000-0000-000000000001', 'f9700000-0000-0000-0000-000000000001', 'BJ Ade', 'active', 'rep');
SELECT set_config('test.uid', 'a9700000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: an issue three days ago and a return yesterday land on those days; the future is refused
DO $$
DECLARE id1 uuid; id2 uuid; t date := (now() AT TIME ZONE 'Africa/Lagos')::date; r record;
  f uuid := 'f9700000-0000-0000-0000-000000000001'; ty uuid := 'e9700000-0000-0000-0000-000000000001';
  rep uuid := 'c9700000-0000-0000-0000-000000000001';
BEGIN
  id1 := public.record_container_movement(jsonb_build_object('factory_id', f, 'container_type_id', ty, 'kind', 'issue',
           'holder_type', 'sales_rep', 'holder_id', rep, 'quantity', 5, 'movement_date', t - 3));
  id2 := public.record_container_movement(jsonb_build_object('factory_id', f, 'container_type_id', ty, 'kind', 'return',
           'holder_type', 'sales_rep', 'holder_id', rep, 'quantity', 5, 'movement_date', t - 1));
  PERFORM pg_temp.check(public._jug_day((SELECT created_at FROM container_movements WHERE id = id1)) = t - 3, 'issue on its day');
  PERFORM pg_temp.check(public._jug_day((SELECT created_at FROM container_movements WHERE id = id2)) = t - 1, 'return on its day');
  SELECT * INTO r FROM public.jug_accountability_report(f, t - 1, t - 1) WHERE sales_rep_id = rep;
  PERFORM pg_temp.check(r.opening = 5 AND r.received = 5 AND r.outstanding = 0,
                        'yesterday: opening 5, received 5, outstanding 0');
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.record_container_movement(%L)$q$,
    jsonb_build_object('factory_id', f, 'container_type_id', ty, 'kind', 'return', 'holder_type', 'sales_rep',
                       'holder_id', rep, 'quantity', 1, 'movement_date', t + 1))) LIKE '%future%', 'no future dates');
END $$;
