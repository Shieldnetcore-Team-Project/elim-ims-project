-- ============================================================================
-- Acceptance tests: qc_jugs_to_dispenser_production
-- (20261102290000_qc_jugs_to_dispenser_production.sql)
-- Good jugs QC verified are confirmed by dispenser production only.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f6000000-0000-0000-0000-000000000001', 'qjdtest', 'QJD Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a6000000-0000-0000-0000-000000000001', 'bottles@qjd'),
  ('a6000000-0000-0000-0000-000000000002', 'dispensers@qjd'),
  ('a6000000-0000-0000-0000-000000000003', 'qc@qjd');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a6000000-0000-0000-0000-000000000001', 'production', 'f6000000-0000-0000-0000-000000000001'),
  ('a6000000-0000-0000-0000-000000000002', 'production', 'f6000000-0000-0000-0000-000000000001'),
  ('a6000000-0000-0000-0000-000000000003', 'super_admin', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO user_product_rules(user_id, name_pattern) VALUES
  ('a6000000-0000-0000-0000-000000000001', 'bottle water'),
  ('a6000000-0000-0000-0000-000000000002', 'dispenser|jug water'),
  ('a6000000-0000-0000-0000-000000000002', 'sachet');
INSERT INTO qc_jug_batches(id, factory_id, reference, jug_kind, status, quantity_sent, sent_by,
                           quantity_accepted, quantity_good, quantity_damaged, accepted_at, verified_at)
VALUES ('b6000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', 'QJD-1', 'old', 'verified',
        10, 'a6000000-0000-0000-0000-000000000003', 10, 9, 1, now(), now());

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: who handles dispensers
DO $$
BEGIN
  PERFORM pg_temp.check(NOT public._user_handles_dispensers('a6000000-0000-0000-0000-000000000001'), 'bottles: no');
  PERFORM pg_temp.check(public._user_handles_dispensers('a6000000-0000-0000-0000-000000000002'), 'dispensers: yes');
  PERFORM pg_temp.check(public._user_handles_dispensers('a6000000-0000-0000-0000-000000000003'), 'admin: yes');
END $$;

-- @@ Test 2: bottle production cannot confirm the jugs
DO $$
BEGIN
  PERFORM set_config('test.uid', 'a6000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(pg_temp.err($q$UPDATE qc_jug_batches SET status = 'received', received_at = now()
                                       WHERE id = 'b6000000-0000-0000-0000-000000000001'$q$)
                        LIKE '%dispenser production%', 'bottle production refused');
END $$;

-- @@ Test 3: dispenser production confirms them
DO $$
BEGIN
  PERFORM set_config('test.uid', 'a6000000-0000-0000-0000-000000000002', false);
  UPDATE qc_jug_batches SET status = 'received', received_at = now() WHERE id = 'b6000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check((SELECT status FROM qc_jug_batches WHERE id = 'b6000000-0000-0000-0000-000000000001') = 'received', 'received');
END $$;
