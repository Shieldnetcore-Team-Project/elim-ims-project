-- ============================================================================
-- Acceptance tests: QC jug verification (20261021100000_qc_jug_register.sql)
--
-- Same harness as preform_inventory_test.sql (supabase/tests/pglite/README.md).
-- Uses its own factory and users; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f8000000-0000-0000-0000-000000000001', 'qjtest', 'QC Jug Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a8000000-0000-0000-0000-000000000002', 'warehouse@qj'),
  ('a8000000-0000-0000-0000-000000000003', 'qc@qj'),
  ('a8000000-0000-0000-0000-000000000005', 'pm@qj'),
  ('a8000000-0000-0000-0000-000000000007', 'auditor@qj');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'a8000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a8000000-0000-0000-0000-000000000002', 'store_officer', 'f8000000-0000-0000-0000-000000000001'),
  ('a8000000-0000-0000-0000-000000000003', 'qc_officer', 'f8000000-0000-0000-0000-000000000001'),
  ('a8000000-0000-0000-0000-000000000005', 'production', 'f8000000-0000-0000-0000-000000000001'),
  ('a8000000-0000-0000-0000-000000000007', 'auditor', 'f8000000-0000-0000-0000-000000000001');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'a8000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
GRANT ALL ON ids TO authenticated;
CREATE OR REPLACE FUNCTION pg_temp.send(p_kind text, p_qty int) RETURNS uuid LANGUAGE sql AS $$
  SELECT (public.send_jugs_to_qc(jsonb_build_object('factory_id', 'f8000000-0000-0000-0000-000000000001',
            'jug_kind', p_kind, 'quantity', p_qty))->>'id')::uuid
$$;

-- @@ Test 1: Warehouse sends, QC accepts and verifies, good ones go to the PM
DO $$
DECLARE e text; r record; d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  PERFORM pg_temp.as_user('7');
  e := pg_temp.err($q$SELECT pg_temp.send('new', 10)$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'auditor cannot send: ' || COALESCE(e, 'no error'));

  PERFORM pg_temp.as_user('2');
  INSERT INTO ids VALUES ('new1', pg_temp.send('new', 100)), ('old1', pg_temp.send('old', 40));
  e := pg_temp.err(format($q$SELECT public.accept_qc_jugs('%s', 100)$q$, pg_temp.id('new1')));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'Warehouse cannot accept for QC: ' || COALESCE(e, 'no error'));

  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.accept_qc_jugs('%s', 101)$q$, pg_temp.id('new1')));
  PERFORM pg_temp.check(e LIKE '%only 100 were sent%', 'more than sent refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format($q$SELECT public.accept_qc_jugs('%s', 98)$q$, pg_temp.id('new1')));
  PERFORM pg_temp.check(e LIKE '%Explain%', 'shortfall needs a note: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format($q$SELECT public.verify_qc_jugs('%s', 90, 10, 'cracked')$q$, pg_temp.id('new1')));
  PERFORM pg_temp.check(e LIKE '%not waiting for verification%', 'cannot verify before accepting');
  PERFORM public.accept_qc_jugs(pg_temp.id('new1'), 98, '2 missing on arrival');
  PERFORM public.accept_qc_jugs(pg_temp.id('old1'), 40);

  e := pg_temp.err(format($q$SELECT public.verify_qc_jugs('%s', 90, 10, 'cracked')$q$, pg_temp.id('new1')));
  PERFORM pg_temp.check(e LIKE '%must equal%', 'good + damaged must equal accepted: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format($q$SELECT public.verify_qc_jugs('%s', 90, 8)$q$, pg_temp.id('new1')));
  PERFORM pg_temp.check(e LIKE '%damaged jugs%', 'damage needs a reason: ' || COALESCE(e, 'no error'));
  PERFORM public.verify_qc_jugs(pg_temp.id('new1'), 90, 8, 'Cracked handles');

  -- Register: new jugs in 98, out 98 (90 good + 8 damaged); old jugs 40 still at QC.
  SELECT * INTO r FROM public.qc_jug_report('f8000000-0000-0000-0000-000000000001', d, d) WHERE jug_kind = 'new';
  PERFORM pg_temp.check(r.jug_name = 'New Jug' AND r.balance_bf = 0 AND r.quantity_in = 98 AND r.total = 98
                        AND r.quantity_good = 90 AND r.quantity_damaged = 8 AND r.quantity_out = 98 AND r.balance = 0,
                        format('new jug row: %s', r));
  SELECT * INTO r FROM public.qc_jug_report('f8000000-0000-0000-0000-000000000001', d, d) WHERE jug_kind = 'old';
  PERFORM pg_temp.check(r.quantity_in = 40 AND r.quantity_out = 0 AND r.balance = 40, format('old jug row: %s', r));

  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.receive_qc_jugs('%s')$q$, pg_temp.id('new1')));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'QC cannot confirm for the PM: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('5');
  PERFORM public.receive_qc_jugs(pg_temp.id('new1'));
  PERFORM pg_temp.check((SELECT status = 'received' AND received_by IS NOT NULL FROM qc_jug_batches WHERE id = pg_temp.id('new1')),
                        'PM confirmed the good jugs');
END $$;

-- @@ Test 2: a send can be withdrawn only before QC accepts it, and not by its own sender in QC
DO $$
DECLARE e text;
BEGIN
  PERFORM pg_temp.as_user('2');
  INSERT INTO ids VALUES ('new2', pg_temp.send('new', 5));
  PERFORM public.cancel_jugs_to_qc(pg_temp.id('new2'), 'Sent the wrong pallet');
  PERFORM pg_temp.check((SELECT status = 'cancelled' FROM qc_jug_batches WHERE id = pg_temp.id('new2')), 'withdrawn');
  e := pg_temp.err(format($q$SELECT public.cancel_jugs_to_qc('%s', 'again')$q$, pg_temp.id('old1')));
  PERFORM pg_temp.check(e LIKE '%already accepted%', 'cannot withdraw once accepted: ' || COALESCE(e, 'no error'));
END $$;
