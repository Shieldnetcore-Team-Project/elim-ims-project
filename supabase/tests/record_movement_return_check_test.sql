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
