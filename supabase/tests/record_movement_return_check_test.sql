-- ============================================================================
-- Acceptance tests: empty jug returns are never refused; the extra above what
-- the person holds is booked as their opening balance
-- (20261110130000_jug_returns_accept_extra.sql, replacing the limit of
-- 20261110110000) and the QC "Jugs collected" report
-- (20261110120000_qc_jug_collections.sql).
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9900000-0000-0000-0000-000000000001', 'rcfac', 'RC Factory');
INSERT INTO auth.users(id, email) VALUES ('a9900000-0000-0000-0000-000000000001', 'admin@rc'),
                                         ('a9900000-0000-0000-0000-000000000002', 'wh@rc');
DELETE FROM user_roles WHERE user_id IN ('a9900000-0000-0000-0000-000000000001', 'a9900000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('a9900000-0000-0000-0000-000000000001', 'super_admin'),
                                             ('a9900000-0000-0000-0000-000000000002', 'super_admin');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'Old Dispenser Jug'),
  ('e9900000-0000-0000-0000-000000000002', 'f9900000-0000-0000-0000-000000000001', 'New Dispenser Jug'),
  ('e9900000-0000-0000-0000-000000000003', 'f9900000-0000-0000-0000-000000000001', 'Crate');
INSERT INTO products(id, factory_id, name, unit, unit_price, product_type) VALUES
  ('d9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'RC Dispenser Water', 'Piece', 1200, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('d9900000-0000-0000-0000-000000000001', 'e9900000-0000-0000-0000-000000000002', 1, 'with_water');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'RC Marketer', 'active', 'rep'),
  ('c9900000-0000-0000-0000-000000000002', 'f9900000-0000-0000-0000-000000000001', 'RC Marketer Two', 'active', 'rep');
INSERT INTO customers(id, factory_id, name) VALUES
  ('b9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 'RC Customer');
SELECT set_config('test.uid', 'a9900000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
-- 'issue' or 'return' of p_q for a holder; the error text, or NULL if it saved.
CREATE OR REPLACE FUNCTION pg_temp.mv(p_kind text, p_ht text, p_hid uuid, p_type int, p_q numeric) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.err(format('SELECT public.record_container_movement(%L)', jsonb_build_object(
    'factory_id', 'f9900000-0000-0000-0000-000000000001',
    'container_type_id', 'e9900000-0000-0000-0000-00000000000' || p_type,
    'kind', p_kind, 'holder_type', p_ht, 'holder_id', p_hid, 'quantity', p_q)));
$$;
-- Jugs (Old + New) a holder has on the ledger.
CREATE OR REPLACE FUNCTION pg_temp.held(p_ht text, p_hid uuid) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(CASE WHEN to_type = p_ht AND to_id = p_hid THEN quantity ELSE -quantity END), 0)
    FROM container_movements
   WHERE container_type_id IN ('e9900000-0000-0000-0000-000000000001', 'e9900000-0000-0000-0000-000000000002')
     AND ((to_type = p_ht AND to_id = p_hid) OR (from_type = p_ht AND from_id = p_hid));
$$;
CREATE OR REPLACE FUNCTION pg_temp.opened(p_hid uuid) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(quantity), 0) FROM container_movements
   WHERE to_id = p_hid AND source = 'issue' AND reference = 'OPENING-BALANCE';
$$;

-- @@ Test 1: Record movement takes every return; the extra is an opening balance, nobody below 0
DO $$
DECLARE
  c uuid := 'b9900000-0000-0000-0000-000000000001';
  r uuid := 'c9900000-0000-0000-0000-000000000001';
BEGIN
  -- Nothing held: saved, 1 booked as opening, figure 0.
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 1) IS NULL, 'nothing held still saves');
  PERFORM pg_temp.check(pg_temp.opened(c) = 1, 'the jug is booked as an opening balance');
  PERFORM pg_temp.check(pg_temp.held('customer', c) = 0, 'customer at 0');
  PERFORM pg_temp.check((SELECT bool_and(created_at < now() - interval '11 hours') FROM container_movements
                          WHERE to_id = c AND reference = 'OPENING-BALANCE'), 'opening dated the day before');

  -- Holds 10: returning 10 books no opening; 11 books exactly 1.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 10) IS NULL, 'issue 10');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 10) IS NULL, 'return what is held');
  PERFORM pg_temp.check(pg_temp.opened(c) = 1, 'no opening when held');
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 10) IS NULL, 'issue 10 again');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 11) IS NULL, 'one more than held saves');
  PERFORM pg_temp.check(pg_temp.opened(c) = 2, 'just the 1 extra opened');
  PERFORM pg_temp.check(pg_temp.held('customer', c) = 0, 'still 0');

  -- Old and New count as one.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 6) IS NULL, 'issue 6 New');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 1, 6) IS NULL, 'Old returned against New held');
  PERFORM pg_temp.check(pg_temp.opened(c) = 2, 'Old + New as one, no opening');

  -- A marketer's posted Dispenser Water still "full" on their stock (Accounts
  -- haven't recorded the sale): the empties come back anyway, no opening.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'sales_rep', r, 2, 5) IS NULL, 'issue 5 to marketer');
  INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
  VALUES (r, 'd9900000-0000-0000-0000-000000000001', 'f9900000-0000-0000-0000-000000000001', 5);
  PERFORM pg_temp.check(pg_temp.mv('return', 'sales_rep', r, 2, 5) IS NULL, 'empties back before sales are recorded');
  PERFORM pg_temp.check(pg_temp.opened(r) = 0, 'no opening for the marketer');

  -- Walk-in has no per-person figure; never an opening.
  PERFORM pg_temp.check(pg_temp.mv('return', 'walk_in', NULL, 2, 4) IS NULL, 'walk-in saves');
  PERFORM pg_temp.check((SELECT count(*) FROM container_movements WHERE to_type = 'walk_in' AND source = 'issue') = 0,
                        'no walk-in opening');
END $$;

-- @@ Test 2: Warehouse claim is not limited; QC's count books the extra; the collections report
DO $$
DECLARE
  r uuid := 'c9900000-0000-0000-0000-000000000002';
  v jsonb;
  s record;
  l record;
BEGIN
  -- Supplied 3, brings back 8 (5 held from before tracking).
  PERFORM pg_temp.check(pg_temp.mv('issue', 'sales_rep', r, 2, 3) IS NULL, 'issue 3');
  PERFORM set_config('test.uid', 'a9900000-0000-0000-0000-000000000002', false);
  v := public.record_jug_return(jsonb_build_object('sales_rep_id', r,
         'container_type_id', 'e9900000-0000-0000-0000-000000000001', 'quantity', 8));
  PERFORM set_config('test.uid', 'a9900000-0000-0000-0000-000000000001', false);

  SELECT * INTO s FROM public.qc_jug_collections('f9900000-0000-0000-0000-000000000001', current_date - 1, current_date)
   WHERE holder_id = r;
  PERFORM pg_temp.check(s.awaiting_count = 8, 'claim waits for the QC count');
  PERFORM pg_temp.check(s.not_returned = 0, 'claimed jugs are not "not returned"');

  PERFORM public.verify_jug_return((v->>'id')::uuid, 8, NULL);
  PERFORM pg_temp.check(pg_temp.opened(r) = 5, 'QC count books the 5 extra');
  PERFORM pg_temp.check(pg_temp.held('sales_rep', r) = 0, 'marketer at 0');

  SELECT * INTO s FROM public.qc_jug_collections('f9900000-0000-0000-0000-000000000001', current_date - 1, current_date)
   WHERE holder_id = r;
  PERFORM pg_temp.check(s.collected = 8 AND s.at_qc = 8 AND s.awaiting_count = 0, 'counted: 8 collected, 8 at QC');
  PERFORM pg_temp.check(s.holder_name = 'RC Marketer Two' AND s.holder_kind = 'rep', 'named, a marketer');

  SELECT * INTO l FROM public.qc_jug_collection_lines('f9900000-0000-0000-0000-000000000001', current_date - 1, current_date)
   WHERE reference = v->>'reference';
  PERFORM pg_temp.check(l.stage = 'at_qc' AND l.counted = 8, 'line at QC');

  -- QC verifies: 7 good to the PM, 1 damaged.
  PERFORM public.verify_qc_jugs((SELECT id FROM qc_jug_batches WHERE jug_return_id = (v->>'id')::uuid), 7, 1, 'cracked');
  SELECT * INTO s FROM public.qc_jug_collections('f9900000-0000-0000-0000-000000000001', current_date - 1, current_date)
   WHERE holder_id = r;
  PERFORM pg_temp.check(s.at_qc = 0 AND s.posted_to_pm = 7 AND s.damaged = 1, 'posted to the PM');

  -- A Record movement return shows as direct (no QC count).
  SELECT * INTO l FROM public.qc_jug_collection_lines('f9900000-0000-0000-0000-000000000001', current_date - 1, current_date)
   WHERE holder_type = 'walk_in' LIMIT 1;
  PERFORM pg_temp.check(l.stage = 'at_qc', 'Record movement return is with QC');

  -- A marketer holding jugs shows them as not returned.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'sales_rep', r, 2, 4) IS NULL, 'issue 4 more');
  SELECT * INTO s FROM public.qc_jug_collections('f9900000-0000-0000-0000-000000000001', current_date - 1, current_date)
   WHERE holder_id = r;
  PERFORM pg_temp.check(s.not_returned = 4, 'owes 4 back');
END $$;

-- @@ Test 3: returned jugs go to QC (never the Warehouse); QC posts them all to the PM at once; the PM confirms
DO $$
DECLARE
  c uuid := 'b9900000-0000-0000-0000-000000000001';
  f uuid := 'f9900000-0000-0000-0000-000000000001';
  v jsonb;
  p record;
  qc_before numeric;
BEGIN
  -- Clear what earlier tests left with QC.
  UPDATE qc_jug_batches SET status = 'cancelled', cancelled_by = 'a9900000-0000-0000-0000-000000000001',
         cancelled_at = now(), cancel_reason = 'test reset', accepted_at = NULL
   WHERE factory_id = f AND status = 'accepted';
  qc_before := COALESCE((SELECT SUM(CASE WHEN to_type = 'qc' THEN quantity ELSE -quantity END) FROM container_movements
                          WHERE factory_id = f AND (to_type = 'qc' OR from_type = 'qc')), 0);

  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 10) IS NULL, 'issue 10');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 6) IS NULL, 'return 6');
  PERFORM pg_temp.check((SELECT to_type FROM container_movements WHERE from_id = c AND source = 'return'
                          ORDER BY created_at DESC LIMIT 1) = 'qc', 'jugs back go to QC, not the Warehouse');
  PERFORM pg_temp.check((SELECT count(*) FROM qc_jug_batches WHERE factory_id = f AND status = 'accepted'
                          AND collected AND from_id = c AND quantity_accepted = 6) = 1, 'a QC consignment opened');
  -- A crate back still goes to the Warehouse, no consignment.
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 3, 2) IS NULL, 'issue 2 crates');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 3, 2) IS NULL, 'crates back');
  PERFORM pg_temp.check((SELECT to_type FROM container_movements WHERE from_id = c AND source = 'return'
                          AND container_type_id = 'e9900000-0000-0000-0000-000000000003') = 'warehouse', 'crates to the Warehouse');

  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 1, 4) IS NULL, 'return 4 Old');
  -- Post all 10 to the PM, 1 damaged.
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.qc_post_jugs_to_pm(%L, 1)', f)) LIKE '%what is wrong%', 'damaged needs a reason');
  v := public.qc_post_jugs_to_pm(f, 1, 'cracked');
  PERFORM pg_temp.check((v->>'total')::numeric = 10 AND (v->>'good')::numeric = 9, 'one posting of everything at QC');
  PERFORM pg_temp.check((SELECT count(*) FROM qc_jug_batches WHERE pm_posting = v->>'reference') = 2, 'both consignments in it');
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.qc_post_jugs_to_pm(%L, 0)', f)) LIKE '%no jugs with QC%', 'nothing left to post');

  SELECT * INTO p FROM public.qc_pm_jug_postings(f, current_date, current_date) WHERE posting = v->>'reference';
  PERFORM pg_temp.check(p.good = 9 AND p.damaged = 1 AND p.status = 'verified' AND p.sources = 'RC Customer', 'listed for the PM');

  PERFORM public.receive_qc_jug_posting(f, v->>'reference');
  SELECT * INTO p FROM public.qc_pm_jug_postings(f, current_date, current_date) WHERE posting = v->>'reference';
  PERFORM pg_temp.check(p.status = 'received', 'PM confirmed the posting');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM container_movements WHERE source = 'qc_to_production'
                          AND reference IN (SELECT reference FROM qc_jug_batches WHERE pm_posting = v->>'reference')) = 9,
                        '9 good jugs to Production');
  PERFORM pg_temp.check(COALESCE((SELECT SUM(CASE WHEN to_type = 'qc' THEN quantity ELSE -quantity END) FROM container_movements
                          WHERE factory_id = f AND (to_type = 'qc' OR from_type = 'qc')), 0) = qc_before, 'QC back where it was');
  PERFORM pg_temp.check((SELECT at_production FROM public.jug_overview(f, current_date, current_date)
                          WHERE container_type_id = 'e9900000-0000-0000-0000-000000000002') > 0, 'overview shows jugs at Production');
END $$;

-- @@ Test 4: every empty QC enters shows on the accounts (rep_account_summary, account_jugs)
DO $$
DECLARE
  r uuid := 'c9900000-0000-0000-0000-000000000002';
  c uuid := 'b9900000-0000-0000-0000-000000000001';
  f uuid := 'f9900000-0000-0000-0000-000000000001';
  before numeric;
  a record;
BEGIN
  before := COALESCE((public.rep_account_summary(r) ->> 'jugs_returned')::numeric, 0);
  PERFORM pg_temp.check(pg_temp.mv('issue', 'sales_rep', r, 2, 3) IS NULL, 'issue 3');
  -- QC enters 3 empties back herself (Record movement), Old Jug against New held.
  PERFORM pg_temp.check(pg_temp.mv('return', 'sales_rep', r, 1, 3) IS NULL, 'QC records 3 back');
  PERFORM pg_temp.check((public.rep_account_summary(r) ->> 'jugs_returned')::numeric = before + 3,
                        'the marketer account counts QC''s own returns');

  SELECT * INTO a FROM public.account_jugs(f) WHERE holder_id = r;
  PERFORM pg_temp.check(a.returned >= 3 AND a.holder_kind = 'rep', 'account_jugs: marketer returns');
  SELECT * INTO a FROM public.account_jugs(f) WHERE holder_id = c;
  PERFORM pg_temp.check(a.holder_type = 'customer' AND a.returned > 0, 'account_jugs: distributor returns');
  PERFORM pg_temp.check(a.with_them >= 0, 'never below 0');
END $$;

-- @@ Test 5: "Dispenser Jug+Water" becomes "Jug + Water" and stays on the lists
DO $$
DECLARE f uuid := 'f9900000-0000-0000-0000-000000000001'; p record;
BEGIN
  INSERT INTO products(id, factory_id, name, unit, unit_price, product_type, active, current_stock) VALUES
    ('d9900000-0000-0000-0000-000000000009', f, 'Dispenser Jug+Water', 'Piece', 4200, 'finished', true, 0);
  -- The migration's step, run again here (it is safe to re-run).
  UPDATE products SET name = 'Jug + Water'
   WHERE regexp_replace(lower(name), '\s', '', 'g') = 'dispenserjug+water';
  SELECT * INTO p FROM products WHERE id = 'd9900000-0000-0000-0000-000000000009';
  PERFORM pg_temp.check(p.name = 'Jug + Water' AND p.active, 'renamed, still active');
  PERFORM pg_temp.check('Jug + Water' ~* 'dispenser|jug\s*\+?\s*water', 'dispenser assignment matches Jug + Water');
  PERFORM pg_temp.check('Dispenser+Water' ~* 'dispenser|jug\s*\+?\s*water', 'still matches dispensers');
  PERFORM pg_temp.check(NOT ('50cl Bottle Water' ~* 'dispenser|jug\s*\+?\s*water'), 'not bottles');
END $$;

-- @@ Test 6: Jugs posted & returned -- QC's own returns count as Returned (no gap with Received)
DO $$
DECLARE r uuid := 'c9900000-0000-0000-0000-000000000001'; ret numeric; rcv numeric; pend numeric;
BEGIN
  -- Marketer RC Marketer: empties entered by QC with Record movement only.
  SELECT SUM(returned), SUM(received), SUM(pending_claims) INTO ret, rcv, pend
    FROM public.jug_accountability_report('f9900000-0000-0000-0000-000000000001', current_date - 1, current_date)
   WHERE sales_rep_id = r;
  PERFORM pg_temp.check(rcv > 0, 'there are returns to compare: ' || COALESCE(rcv, 0));
  PERFORM pg_temp.check(ret - COALESCE(pend, 0) = rcv,
                        format('Returned %s matches Received %s', ret, rcv));
END $$;

-- @@ Test 7: QC posts part of what she holds; the rest stays with QC
DO $$
DECLARE
  c uuid := 'b9900000-0000-0000-0000-000000000001';
  f uuid := 'f9900000-0000-0000-0000-000000000001';
  v jsonb; qc_before numeric; qc_after numeric; v2 jsonb;
BEGIN
  UPDATE qc_jug_batches SET status = 'cancelled', cancelled_by = 'a9900000-0000-0000-0000-000000000001',
         cancelled_at = now(), cancel_reason = 'test reset', accepted_at = NULL
   WHERE factory_id = f AND status = 'accepted';
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 10) IS NULL, 'issue 10');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 6) IS NULL, 'return 6');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 4) IS NULL, 'return 4');
  qc_before := (SELECT SUM(CASE WHEN to_type = 'qc' THEN quantity ELSE -quantity END) FROM container_movements
                 WHERE factory_id = f AND (to_type = 'qc' OR from_type = 'qc'));

  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.qc_post_jugs_to_pm(%L, 0, NULL, 11)', f)) LIKE '%more than the 10 jugs%', 'not more than held');
  v := public.qc_post_jugs_to_pm(f, 1, 'cracked', 3);
  PERFORM pg_temp.check((v->>'good')::numeric = 3 AND (v->>'damaged')::numeric = 1 AND (v->>'kept')::numeric = 6, 'posted 3 good + 1 damaged, 6 kept');
  PERFORM pg_temp.check((SELECT SUM(quantity_good) FROM qc_jug_batches WHERE pm_posting = v->>'reference') = 3, 'posting holds 3 good');
  PERFORM pg_temp.check((SELECT SUM(quantity_accepted) FROM qc_jug_batches WHERE factory_id = f AND status = 'accepted') = 6, '6 still with QC');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM qc_jug_batches WHERE factory_id = f AND status = 'accepted' AND reference LIKE '%-R1' AND from_id = c AND quantity_accepted = 2), 'the split rest (2) keeps its sender');
  qc_after := (SELECT SUM(CASE WHEN to_type = 'qc' THEN quantity ELSE -quantity END) FROM container_movements
                WHERE factory_id = f AND (to_type = 'qc' OR from_type = 'qc'));
  PERFORM pg_temp.check(qc_after = qc_before - 1, 'only the damaged one left QC on the ledger so far');

  PERFORM public.receive_qc_jug_posting(f, v->>'reference');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM container_movements WHERE source = 'qc_to_production'
                          AND reference IN (SELECT reference FROM qc_jug_batches WHERE pm_posting = v->>'reference')) = 3,
                        'PM received 3');
  -- The rest goes in a later posting (all of it by default).
  v2 := public.qc_post_jugs_to_pm(f, 0, NULL, NULL);
  PERFORM pg_temp.check((v2->>'good')::numeric = 6 AND (v2->>'kept')::numeric = 0, 'the 6 posted later');
END $$;

-- @@ Test 8: QC corrects an entry -- quantity, sender, a split part, removal; everything follows
DO $$
DECLARE
  c uuid := 'b9900000-0000-0000-0000-000000000001';
  r uuid := 'c9900000-0000-0000-0000-000000000002';
  f uuid := 'f9900000-0000-0000-0000-000000000001';
  b record; ret_c numeric; ret_r numeric; v jsonb; part record;
BEGIN
  UPDATE qc_jug_batches SET status = 'cancelled', cancelled_by = 'a9900000-0000-0000-0000-000000000001',
         cancelled_at = now(), cancel_reason = 'test reset', accepted_at = NULL
   WHERE factory_id = f AND status = 'accepted';
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 20) IS NULL, 'issue 20');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 1, 9) IS NULL, 'return 9');
  SELECT * INTO b FROM qc_jug_batches WHERE factory_id = f AND status = 'accepted' ORDER BY accepted_at DESC LIMIT 1;
  ret_c := (SELECT returned FROM public.account_jugs(f) WHERE holder_id = c);

  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.correct_qc_jug_entry(%L, 7, %L)', b.id, '')) LIKE '%Say why%', 'reason required');
  -- 9 was wrong: it was 7.
  PERFORM public.correct_qc_jug_entry(b.id, 7, 'miscounted');
  PERFORM pg_temp.check((SELECT quantity_accepted FROM qc_jug_batches WHERE id = b.id) = 7, 'entry now 7');
  PERFORM pg_temp.check((SELECT quantity FROM container_movements WHERE reference = b.reference AND source = 'return') = 7, 'ledger now 7');
  PERFORM pg_temp.check((SELECT returned FROM public.account_jugs(f) WHERE holder_id = c) = ret_c - 2, 'account follows');

  -- Wrong person: it was marketer RC Marketer Two.
  ret_r := COALESCE((SELECT returned FROM public.account_jugs(f) WHERE holder_id = r), 0);
  PERFORM public.correct_qc_jug_entry(b.id, 7, 'wrong marketer', 'sales_rep', r);
  PERFORM pg_temp.check((SELECT from_id FROM qc_jug_batches WHERE id = b.id) = r, 'sender changed');
  PERFORM pg_temp.check((SELECT from_id FROM container_movements WHERE reference = b.reference AND source = 'return') = r, 'ledger sender changed');
  PERFORM pg_temp.check((SELECT returned FROM public.account_jugs(f) WHERE holder_id = r) = ret_r + 7, 'marketer now credited');
  PERFORM pg_temp.check((SELECT returned FROM public.account_jugs(f) WHERE holder_id = c) = ret_c - 9, 'customer no longer');

  -- Post 3 of 7; the part left (4) is corrected to 2.
  v := public.qc_post_jugs_to_pm(f, 0, NULL, 3);
  SELECT * INTO part FROM qc_jug_batches WHERE factory_id = f AND status = 'accepted' AND reference = b.reference || '-R1';
  PERFORM pg_temp.check(part.quantity_accepted = 4, 'part left 4');
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.correct_qc_jug_entry(%L, 4, %L, %L, %L)', part.id, 'x', 'customer', c)) LIKE '%already posted%', 'no sender change once part is posted');
  PERFORM public.correct_qc_jug_entry(part.id, 2, 'two were not ours');
  PERFORM pg_temp.check((SELECT quantity FROM container_movements WHERE reference = b.reference AND source = 'return') = 5, 'ledger 3 + 2');
  -- A posted entry can't be corrected here.
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.correct_qc_jug_entry(%L, 1, %L)', b.id, 'x')) LIKE '%already been posted%', 'posted entry refused');
  -- Remove the part.
  PERFORM public.correct_qc_jug_entry(part.id, 0, 'entered twice');
  PERFORM pg_temp.check((SELECT status FROM qc_jug_batches WHERE id = part.id) = 'cancelled', 'removed');
  PERFORM pg_temp.check((SELECT quantity FROM container_movements WHERE reference = b.reference AND source = 'return') = 3, 'ledger back to 3');
  -- The ledger is still append-only otherwise.
  PERFORM pg_temp.check(pg_temp.err(format('UPDATE container_movements SET quantity = 1 WHERE reference = %L', b.reference)) LIKE '%append-only%', 'still append-only');
END $$;

-- @@ Test 9: QC posts one day's entries; other days stay with QC
DO $$
DECLARE
  c uuid := 'b9900000-0000-0000-0000-000000000001';
  f uuid := 'f9900000-0000-0000-0000-000000000001';
  v jsonb;
BEGIN
  UPDATE qc_jug_batches SET status = 'cancelled', cancelled_by = 'a9900000-0000-0000-0000-000000000001',
         cancelled_at = now(), cancel_reason = 'test reset', accepted_at = NULL
   WHERE factory_id = f AND status = 'accepted';
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 20) IS NULL, 'issue 20');
  -- 5 back yesterday, 8 today.
  PERFORM pg_temp.err(format('SELECT public.record_container_movement(%L)', jsonb_build_object(
    'factory_id', f, 'container_type_id', 'e9900000-0000-0000-0000-000000000001', 'kind', 'return',
    'holder_type', 'customer', 'holder_id', c, 'quantity', 5,
    'movement_date', ((now() AT TIME ZONE 'Africa/Lagos')::date - 1)::text)));
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 1, 8) IS NULL, 'return 8 today');

  v := public.qc_post_jugs_to_pm(f, 0, NULL, NULL, (now() AT TIME ZONE 'Africa/Lagos')::date - 1);
  PERFORM pg_temp.check((v->>'good')::numeric = 5, 'only yesterday''s 5 posted');
  PERFORM pg_temp.check((SELECT SUM(quantity_accepted) FROM qc_jug_batches WHERE factory_id = f AND status = 'accepted') = 8,
                        'today''s 8 still with QC');
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.qc_post_jugs_to_pm(%L, 0, NULL, NULL, %L)', f,
                          ((now() AT TIME ZONE 'Africa/Lagos')::date - 1)::text)) LIKE '%no jugs with QC to post for%', 'nothing left that day');
  -- Part of today's.
  v := public.qc_post_jugs_to_pm(f, 0, NULL, 6, (now() AT TIME ZONE 'Africa/Lagos')::date);
  PERFORM pg_temp.check((v->>'good')::numeric = 6 AND (v->>'kept')::numeric = 2, '6 of today''s 8, 2 kept');
END $$;

-- @@ Test 10 (20261110260000): QC posts every jug of a period (From..To) in one posting
DO $$
DECLARE
  c uuid := 'b9900000-0000-0000-0000-000000000001';
  f uuid := 'f9900000-0000-0000-0000-000000000001';
  v jsonb; d0 date := public._jug_day(now());
BEGIN
  UPDATE qc_jug_batches SET status = 'cancelled', cancelled_by = 'a9900000-0000-0000-0000-000000000001',
         cancelled_at = now(), cancel_reason = 'test reset', accepted_at = NULL
   WHERE factory_id = f AND status = 'accepted';
  PERFORM pg_temp.check(pg_temp.mv('issue', 'customer', c, 2, 20) IS NULL, 'issue 20');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 5) IS NULL, 'return 5');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 7) IS NULL, 'return 7');
  PERFORM pg_temp.check(pg_temp.mv('return', 'customer', c, 2, 3) IS NULL, 'return 3');
  -- Spread over three days: d0-4, d0-2, d0.
  UPDATE qc_jug_batches SET accepted_at = accepted_at - interval '4 days'
   WHERE factory_id = f AND status = 'accepted' AND quantity_accepted = 5;
  UPDATE qc_jug_batches SET accepted_at = accepted_at - interval '2 days'
   WHERE factory_id = f AND status = 'accepted' AND quantity_accepted = 7;

  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.qc_post_jugs_to_pm(%L, 0, NULL, NULL, %L, %L)',
    f, d0 - 1, d0 - 3)) LIKE '%To date is before%', 'To before From refused');
  PERFORM pg_temp.check(pg_temp.err(format('SELECT public.qc_post_jugs_to_pm(%L, 0, NULL, NULL, %L, %L)',
    f, d0 - 1, d0 - 1)) LIKE '%no jugs with QC%', 'nothing on that one day');
  -- From d0-4 to d0-1: the 5 and the 7 (12), not today's 3.
  v := public.qc_post_jugs_to_pm(f, 2, 'cracked', NULL, d0 - 4, d0 - 1);
  PERFORM pg_temp.check((v->>'good')::numeric = 10 AND (v->>'damaged')::numeric = 2 AND (v->>'kept')::numeric = 0,
    'period posted: 10 good + 2 damaged: ' || v::text);
  PERFORM pg_temp.check((SELECT count(*) FROM qc_jug_batches WHERE pm_posting = v->>'reference') = 2, 'both days in one posting');
  PERFORM pg_temp.check((SELECT SUM(quantity_accepted) FROM qc_jug_batches WHERE factory_id = f AND status = 'accepted') = 3,
    'today''s 3 still with QC');
  -- p_to left out = that day only (as before).
  v := public.qc_post_jugs_to_pm(f, 0, NULL, NULL, d0);
  PERFORM pg_temp.check((v->>'good')::numeric = 3, 'one day still works');
END $$;
