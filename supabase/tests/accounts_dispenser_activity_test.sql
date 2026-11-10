-- ============================================================================
-- Acceptance tests: the Accountant sees every dispenser / jug activity, QC's
-- included (20261110280000_accounts_dispenser_activity.sql). The Warehouse
-- records 6 empties from a marketer, QC counts 6 and posts them to the PM
-- (1 damaged). An accountant with Finance view only reads it all.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3900000-0000-0000-0000-000000000001', 'adfac', 'AD Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a3900000-0000-0000-0000-000000000001', 'wh@ad'),
  ('a3900000-0000-0000-0000-000000000002', 'qc@ad'),
  ('a3900000-0000-0000-0000-000000000003', 'acc@ad'),
  ('a3900000-0000-0000-0000-000000000004', 'none@ad');
INSERT INTO roles(slug, label, is_system) VALUES
  ('ad_wh_test', 'Warehouse (test)', false), ('ad_qc_test', 'QC (test)', false),
  ('ad_acc_test', 'Accountant (test)', false), ('ad_none_test', 'Nothing (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action) VALUES
  ('ad_wh_test', 'distribution', 'view'), ('ad_wh_test', 'distribution', 'create'),
  ('ad_wh_test', 'finished-goods', 'view'),
  ('ad_qc_test', 'goods-receiving', 'view'), ('ad_qc_test', 'goods-receiving', 'submit'),
  ('ad_acc_test', 'finance', 'view'),
  ('ad_none_test', 'expenses', 'view')
ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a3900000-0000-0000-0000-000000000001', 'ad_wh_test', 'f3900000-0000-0000-0000-000000000001'),
  ('a3900000-0000-0000-0000-000000000002', 'ad_qc_test', 'f3900000-0000-0000-0000-000000000001'),
  ('a3900000-0000-0000-0000-000000000003', 'ad_acc_test', 'f3900000-0000-0000-0000-000000000001'),
  ('a3900000-0000-0000-0000-000000000004', 'ad_none_test', 'f3900000-0000-0000-0000-000000000001');
INSERT INTO container_types(id, factory_id, name, jar_price, with_jar_price) VALUES
  ('e3900000-0000-0000-0000-000000000001', 'f3900000-0000-0000-0000-000000000001', 'AD New Jug', 3000, 4200);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3900000-0000-0000-0000-000000000001', 'f3900000-0000-0000-0000-000000000001', 'AD Ada', 'active', 'rep');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: returned, counted by QC, posted to the PM -- the accountant sees it all
DO $$
DECLARE v jsonb; a jsonb; p record;
  f uuid := 'f3900000-0000-0000-0000-000000000001'; r uuid := 'c3900000-0000-0000-0000-000000000001';
  d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000001', false);
  v := public.record_jug_return(jsonb_build_object('sales_rep_id', r,
    'container_type_id', 'e3900000-0000-0000-0000-000000000001', 'quantity', 6));
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000002', false);
  PERFORM public.verify_jug_return((v->>'id')::uuid, 6, NULL);
  PERFORM public.qc_post_jugs_to_pm(f, 1, 'Cracked', NULL, NULL, NULL);

  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000003', false);
  a := public.accounts_jug_activity(f, d, d);
  PERFORM pg_temp.check((a->>'with_qc')::numeric = 0, 'nothing left with QC: ' || (a->>'with_qc'));
  PERFORM pg_temp.check(jsonb_array_length(a->'postings') = 1, 'one posting: ' || (a->'postings')::text);
  PERFORM pg_temp.check((a->'postings'->0->>'good')::numeric = 5, '5 good posted');
  PERFORM pg_temp.check((a->'postings'->0->>'damaged')::numeric = 1, '1 damaged');
  PERFORM pg_temp.check(a->'postings'->0->>'status' = 'verified', 'waiting for PM');
  PERFORM pg_temp.check(a->'postings'->0->>'sources' = 'AD Ada', 'from AD Ada');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM jsonb_array_elements(a->'movements') m
                                 WHERE m->>'source' = 'return' AND m->>'from_name' = 'AD Ada'
                                   AND m->>'to_name' = 'Quality Control' AND (m->>'quantity')::numeric = 6),
                        'return to QC in movements: ' || (a->'movements')::text);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM jsonb_array_elements(a->'movements') m
                                 WHERE m->>'source' = 'qc_damaged' AND (m->>'quantity')::numeric = 1),
                        'damaged at QC in movements');

  SELECT * INTO p FROM public.qc_jug_collections(f, d, d) WHERE holder_id = r;
  PERFORM pg_temp.check(p.collected = 6, 'collected 6 seen by accountant');
  PERFORM pg_temp.check(p.posted_to_pm = 5, 'posted 5 seen by accountant');
  PERFORM pg_temp.check((SELECT count(*) FROM public.qc_jug_collection_lines(f, d, d)) >= 1, 'lines seen');
END $$;

-- @@ Test 2: someone without dispenser access is refused
DO $$
DECLARE ok boolean := false; d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000004', false);
  BEGIN
    PERFORM public.accounts_jug_activity('f3900000-0000-0000-0000-000000000001', d, d);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM pg_temp.check(ok, 'refused');
END $$;

-- @@ Test 3: the accountant sees what the Warehouse took in (20261110290000)
DO $$
DECLARE w record; d date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  PERFORM set_config('test.uid', 'a3900000-0000-0000-0000-000000000003', false);
  SELECT * INTO w FROM public.accounts_warehouse_jug_returns('f3900000-0000-0000-0000-000000000001', d, d);
  PERFORM pg_temp.check(w.holder_name = 'AD Ada', 'from AD Ada');
  PERFORM pg_temp.check(w.recorded = 6 AND w.counted = 6, 'recorded 6, counted 6');
  PERFORM pg_temp.check(w.good = 5 AND w.damaged = 1, '5 good, 1 damaged');
  PERFORM pg_temp.check(w.stage = 'posted_to_pm', 'posted to PM: ' || w.stage);
  PERFORM pg_temp.check(w.recorded_by = 'wh@ad', 'recorded by the Warehouse: ' || COALESCE(w.recorded_by, 'null'));
END $$;
