-- ============================================================================
-- Acceptance tests: Dispenser Production & Jug Accountability
-- (20261020200000_jug_accountability.sql).
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test. Uses its own factory, users, marketer, jugs and products.
--
-- Scenario (the factory's example): a marketer starts the day owing 49
-- jugs, is loaded with 50 filled jugs (Total 99), sells refills (swaps),
-- Jug + Water and empty jugs, brings empties back, and the Warehouse counts
-- them; the next day opens with what is still outstanding.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f5000000-0000-0000-0000-000000000001', 'jugtest', 'Jug Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a5000000-0000-0000-0000-000000000001', 'admin@jug'),
  ('a5000000-0000-0000-0000-000000000002', 'warehouse@jug'),
  ('a5000000-0000-0000-0000-000000000003', 'sales@jug'),
  ('a5000000-0000-0000-0000-000000000004', 'nobody@jug'),
  ('a5000000-0000-0000-0000-000000000005', 'warehouse2@jug');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'a5000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
INSERT INTO roles(slug, label, is_system) VALUES ('jug_nobody', 'Nobody (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action) VALUES ('jug_nobody', 'dashboard', 'view') ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a5000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('a5000000-0000-0000-0000-000000000002', 'store_officer', 'f5000000-0000-0000-0000-000000000001'),
  ('a5000000-0000-0000-0000-000000000003', 'sales', 'f5000000-0000-0000-0000-000000000001'),
  ('a5000000-0000-0000-0000-000000000004', 'jug_nobody', 'f5000000-0000-0000-0000-000000000001'),
  ('a5000000-0000-0000-0000-000000000005', 'store_officer', 'f5000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO sales_reps(id, factory_id, code, full_name, status, kind) VALUES
  ('e5000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001', 'JT-01', 'Test Moniepoint', 'active', 'rep');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('d5000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001', 'Test Dispenser Refill', 'Piece', 500, 100, 'finished'),
  ('d5000000-0000-0000-0000-000000000002', 'f5000000-0000-0000-0000-000000000001', 'Test Jug + Water', 'Piece', 2500, 20, 'finished'),
  ('d5000000-0000-0000-0000-000000000003', 'f5000000-0000-0000-0000-000000000001', 'Test Empty Jug', 'Piece', 1500, 10, 'finished');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'a5000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
GRANT ALL ON ids TO authenticated;
CREATE OR REPLACE FUNCTION pg_temp.today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Africa/Lagos')::date $$;
CREATE OR REPLACE FUNCTION pg_temp.row(p_day date) RETURNS SETOF record LANGUAGE sql AS $$ SELECT 1 $$;

-- @@ Test 1: setup -- a jug type and which product does what with it (managers only)
DO $$
DECLARE e text; v uuid;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err($q$SELECT public.save_container_type('f5000000-0000-0000-0000-000000000001', NULL, '19L Jug')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'sales cannot set up jug types');
  PERFORM pg_temp.as_user('1');
  v := public.save_container_type('f5000000-0000-0000-0000-000000000001', NULL, '19L Jug');
  INSERT INTO ids VALUES ('jug', v);
  PERFORM public.set_product_jug_role('d5000000-0000-0000-0000-000000000001', v, 1, 'refill');
  PERFORM public.set_product_jug_role('d5000000-0000-0000-0000-000000000002', v, 1, 'with_water');
  PERFORM public.set_product_jug_role('d5000000-0000-0000-0000-000000000003', v, 1, 'empty');
  e := pg_temp.err(format($q$SELECT public.set_product_jug_role('d5000000-0000-0000-0000-000000000001', '%s', 1, 'gift')$q$, v));
  PERFORM pg_temp.check(e LIKE '%Unknown jug role%', 'unknown role refused');
  -- The jugs the factory owns: bought in.
  PERFORM public.record_container_movement(jsonb_build_object('factory_id', 'f5000000-0000-0000-0000-000000000001',
            'container_type_id', v, 'kind', 'purchase', 'quantity', 300));
  -- Yesterday the marketer was issued 49 jugs (their opening balance).
  INSERT INTO container_movements(factory_id, container_type_id, from_type, to_type, to_id, quantity, source, reference, notes, created_at)
  VALUES ('f5000000-0000-0000-0000-000000000001', v, 'warehouse', 'sales_rep', 'e5000000-0000-0000-0000-000000000001',
          49, 'issue', 'OPEN-1', 'Opening balance', now() - interval '1 day');
  -- 100 filled refills produced, approved and accepted into the Warehouse this period.
  INSERT INTO production_releases(factory_id, release_number, product_id, quantity, unit, status, accepted_quantity, accepted_at, released_by)
  VALUES ('f5000000-0000-0000-0000-000000000001', 'REL-JT-1', 'd5000000-0000-0000-0000-000000000001', 100, 'Piece',
          'accepted', 100, now(), 'a5000000-0000-0000-0000-000000000001');
END $$;

-- @@ Test 2: Opening 49 + Loaded 50 = Total 99; dispatch moves jugs, more than stock is refused
DO $$
DECLARE e text; r record;
BEGIN
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err($q$SELECT public.create_stock_dispatch('{"factory_id":"f5000000-0000-0000-0000-000000000001","sales_rep_id":"e5000000-0000-0000-0000-000000000001","items":[{"product_id":"d5000000-0000-0000-0000-000000000002","quantity":21}]}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient store stock%', 'cannot issue more filled jugs than stock: ' || COALESCE(e, 'no error'));
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f5000000-0000-0000-0000-000000000001',
            'sales_rep_id', 'e5000000-0000-0000-0000-000000000001', 'items', jsonb_build_array(
              jsonb_build_object('product_id', 'd5000000-0000-0000-0000-000000000001', 'quantity', 40),
              jsonb_build_object('product_id', 'd5000000-0000-0000-0000-000000000002', 'quantity', 6),
              jsonb_build_object('product_id', 'd5000000-0000-0000-0000-000000000003', 'quantity', 4))));
  SELECT * INTO r FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', pg_temp.today(), pg_temp.today());
  PERFORM pg_temp.check(r.opening = 49 AND r.loaded = 50 AND r.total = 99 AND r.outstanding = 99,
                        format('49 + 50 = 99: opening %s loaded %s total %s outstanding %s', r.opening, r.loaded, r.total, r.outstanding));
  SELECT * INTO r FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', pg_temp.today() - 1, pg_temp.today() - 1);
  PERFORM pg_temp.check(r.opening = 0 AND r.loaded = 49 AND r.outstanding = 49, 'yesterday closed at 49');
END $$;

-- @@ Test 3: sales -- refills are swaps, Jug + Water and empties take the jug; Expected Empties
DO $$
DECLARE v jsonb; r record;
BEGIN
  PERFORM pg_temp.as_user('1');
  v := public.create_sale(jsonb_build_object('factory_id', 'f5000000-0000-0000-0000-000000000001',
         'sales_rep_id', 'e5000000-0000-0000-0000-000000000001', 'customer_name', 'Walk-in', 'amount_paid', 30*500 + 5*2500 + 3*1500,
         'items', jsonb_build_array(
           jsonb_build_object('product_id', 'd5000000-0000-0000-0000-000000000001', 'quantity', 30, 'unit_price', 500),
           jsonb_build_object('product_id', 'd5000000-0000-0000-0000-000000000002', 'quantity', 5, 'unit_price', 2500),
           jsonb_build_object('product_id', 'd5000000-0000-0000-0000-000000000003', 'quantity', 3, 'unit_price', 1500))));
  IF (SELECT status FROM sales WHERE id = (v->>'sale_id')::uuid) <> 'posted' THEN
    PERFORM public.approve_sale((v->>'sale_id')::uuid, NULL);
  END IF;
  PERFORM pg_temp.check((SELECT status FROM sales WHERE id = (v->>'sale_id')::uuid) = 'posted', 'sale posted');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM container_movements WHERE sale_id = (v->>'sale_id')::uuid
                                       AND product_id = 'd5000000-0000-0000-0000-000000000001'),
                        'a refill sale moves no jug (the customer swapped an empty)');
  SELECT * INTO r FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', pg_temp.today(), pg_temp.today());
  PERFORM pg_temp.check(r.jug_water_sold = 5 AND r.empties_sold = 3 AND r.empties_value = 4500 AND r.refills_sold = 30,
                        format('sold: jw %s es %s value %s refills %s', r.jug_water_sold, r.empties_sold, r.empties_value, r.refills_sold));
  PERFORM pg_temp.check(r.expected_empties = 99 - 5 - 3 AND r.outstanding = 91, 'expected empties 91');
END $$;

-- @@ Test 4: two-step return -- claim, then a different person counts; only Received reduces Outstanding
DO $$
DECLARE v jsonb; v2 jsonb; e text; r record;
BEGIN
  -- 91 jugs owed; 10 refills + 1 Jug + Water still full on the marketer's stock -> at most 80 empties.
  PERFORM pg_temp.as_user('4');
  e := pg_temp.err($q$SELECT public.record_jug_return('{"sales_rep_id":"e5000000-0000-0000-0000-000000000001","container_type_id":"00000000-0000-0000-0000-000000000000","quantity":1}')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'no rights, no return');
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.record_jug_return('{"sales_rep_id":"e5000000-0000-0000-0000-000000000001","container_type_id":"%s","quantity":81}')$q$, pg_temp.id('jug')));
  PERFORM pg_temp.check(e LIKE '%at most 80%', 'cannot claim more empties than can be owed: ' || COALESCE(e, 'no error'));
  e := pg_temp.err(format($q$SELECT public.record_jug_return('{"sales_rep_id":"e5000000-0000-0000-0000-000000000001","container_type_id":"%s","quantity":-3}')$q$, pg_temp.id('jug')));
  PERFORM pg_temp.check(e LIKE '%whole number%', 'negative refused');
  v := public.record_jug_return(jsonb_build_object('sales_rep_id', 'e5000000-0000-0000-0000-000000000001',
         'container_type_id', pg_temp.id('jug'), 'quantity', 60, 'client_ref', 'c5000000-0000-0000-0000-000000000001'));
  v2 := public.record_jug_return(jsonb_build_object('sales_rep_id', 'e5000000-0000-0000-0000-000000000001',
         'container_type_id', pg_temp.id('jug'), 'quantity', 60, 'client_ref', 'c5000000-0000-0000-0000-000000000001'));
  PERFORM pg_temp.check(v2->>'id' = v->>'id', 'double submit records one return');
  INSERT INTO ids VALUES ('ret1', (v->>'id')::uuid);
  SELECT * INTO r FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', pg_temp.today(), pg_temp.today());
  PERFORM pg_temp.check(r.returned = 60 AND r.received = 0 AND r.outstanding = 91 AND r.pending_claims = 60,
                        'claimed but not counted: still outstanding');
  e := pg_temp.err(format($q$SELECT public.record_jug_return('{"sales_rep_id":"e5000000-0000-0000-0000-000000000001","container_type_id":"%s","quantity":21}')$q$, pg_temp.id('jug')));
  PERFORM pg_temp.check(e LIKE '%at most 20%', 'pending claims count against what can be claimed');

  e := pg_temp.err(format($q$SELECT public.verify_jug_return('%s', 60)$q$, pg_temp.id('ret1')));
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'sales cannot confirm a warehouse count');
  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format($q$SELECT public.verify_jug_return('%s', 58)$q$, pg_temp.id('ret1')));
  PERFORM pg_temp.check(e LIKE '%say why%', 'a short count needs a reason');
  PERFORM public.verify_jug_return(pg_temp.id('ret1'), 58, 'Two jugs not on the van');
  e := pg_temp.err(format($q$SELECT public.verify_jug_return('%s', 58, 'again')$q$, pg_temp.id('ret1')));
  PERFORM pg_temp.check(e LIKE '%already verified%', 'a return is received once');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM container_movements WHERE reference = (SELECT reference FROM jug_returns WHERE id = pg_temp.id('ret1'))) = 1,
                        'one ledger move');
  SELECT * INTO r FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', pg_temp.today(), pg_temp.today());
  PERFORM pg_temp.check(r.returned = 60 AND r.received = 58 AND r.outstanding = 33,
                        format('returned 60, received 58, outstanding %s', r.outstanding));
END $$;

-- @@ Test 5: maker-checker, over-receipt, cancellation
DO $$
DECLARE v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := public.record_jug_return(jsonb_build_object('sales_rep_id', 'e5000000-0000-0000-0000-000000000001',
         'container_type_id', pg_temp.id('jug'), 'quantity', 10));
  e := pg_temp.err(format($q$SELECT public.verify_jug_return('%s', 10)$q$, v->>'id'));
  PERFORM pg_temp.check(e LIKE '%Someone other%', 'whoever recorded a return cannot confirm it');
  PERFORM pg_temp.as_user('5');
  e := pg_temp.err(format($q$SELECT public.verify_jug_return('%s', 30, 'found more')$q$, v->>'id'));
  PERFORM pg_temp.check(e LIKE '%owes only 22%', 'cannot receive more empties than the marketer can owe: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.as_user('2');
  PERFORM public.cancel_jug_return((v->>'id')::uuid, 'Entered twice');
  PERFORM pg_temp.check((SELECT status FROM jug_returns WHERE id = (v->>'id')::uuid) = 'cancelled', 'cancelled');
  e := pg_temp.err(format($q$SELECT public.verify_jug_return('%s', 10, 'x')$q$, v->>'id'));
  PERFORM pg_temp.check(e LIKE '%already cancelled%', 'a cancelled return cannot be received');
END $$;

-- @@ Test 6: approved write-off; Outstanding = ledger; tomorrow opens with today's Outstanding
DO $$
DECLARE r record; e text;
BEGIN
  PERFORM pg_temp.as_user('3');
  e := pg_temp.err(format($q$SELECT public.record_container_movement('{"factory_id":"f5000000-0000-0000-0000-000000000001","container_type_id":"%s","kind":"lost","holder_type":"sales_rep","holder_id":"e5000000-0000-0000-0000-000000000001","quantity":2,"notes":"x"}')$q$, pg_temp.id('jug')));
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'sales cannot write jugs off');
  PERFORM pg_temp.as_user('1');
  PERFORM public.record_container_movement(jsonb_build_object('factory_id', 'f5000000-0000-0000-0000-000000000001',
            'container_type_id', pg_temp.id('jug'), 'kind', 'lost', 'holder_type', 'sales_rep',
            'holder_id', 'e5000000-0000-0000-0000-000000000001', 'quantity', 2, 'notes', 'Two jugs lost, marketer to pay'));
  SELECT * INTO r FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', pg_temp.today(), pg_temp.today());
  PERFORM pg_temp.check(r.written_off = 2 AND r.outstanding = 31, 'written off 2: outstanding 31');
  PERFORM pg_temp.check(r.outstanding = public._jug_rep_balance('e5000000-0000-0000-0000-000000000001', pg_temp.id('jug')),
                        'report agrees with the ledger');
  SELECT * INTO r FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', pg_temp.today() + 1, pg_temp.today() + 1);
  PERFORM pg_temp.check(r.opening = 31 AND r.outstanding = 31 AND r.loaded = 0, 'next day opens at 31');
  -- A range: one row per day, each opening = previous outstanding.
  PERFORM pg_temp.check((SELECT bool_and(x.opening = COALESCE(x.prev, 0)) FROM (
                           SELECT opening, lag(outstanding) OVER (ORDER BY report_date) AS prev
                             FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001',
                                                                    pg_temp.today() - 1, pg_temp.today() + 1)) x),
                        'carry-forward holds across the range');
  e := pg_temp.err($q$SELECT * FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', '2026-10-10', '2026-10-01')$q$);
  PERFORM pg_temp.check(e LIKE '%before the start%', 'invalid range refused');
  e := pg_temp.err($q$SELECT * FROM public.jug_accountability_report('f5000000-0000-0000-0000-000000000001', NULL, '2026-10-01')$q$);
  PERFORM pg_temp.check(e LIKE '%valid date%', 'missing date refused');
END $$;

-- @@ Test 7: the jug pool agrees with the Warehouse and the marketers
DO $$
DECLARE o record; e text;
BEGIN
  PERFORM pg_temp.as_user('2');
  SELECT * INTO o FROM public.jug_overview('f5000000-0000-0000-0000-000000000001', pg_temp.today() - 1, pg_temp.today());
  -- 300 bought; 49 + 50 out; 58 back; 5 + 3 with customers; 2 lost.
  PERFORM pg_temp.check(o.in_warehouse = 300 - 49 - 50 + 58, 'warehouse jugs ' || o.in_warehouse);
  PERFORM pg_temp.check(o.with_marketers = 31 AND o.with_customers = 8 AND o.written_off_total = 2, 'marketers / customers / written off');
  PERFORM pg_temp.check(o.in_circulation = 300 - 2, 'every jug accounted for: ' || o.in_circulation);
  PERFORM pg_temp.check(o.filled_in_warehouse = 60 + 14 AND o.empty_in_warehouse = o.in_warehouse - 74, 'filled vs empty in the warehouse');
  PERFORM pg_temp.check(o.full_with_marketers = 11, 'full jugs still with the marketer');
  PERFORM pg_temp.check(o.produced_approved = 100 AND o.issued = 99 AND o.sold_with_water = 5 AND o.empties_sold = 3
                        AND o.received = 58 AND o.empties_value = 4500, 'period activity');
  PERFORM pg_temp.as_user('4');
  e := pg_temp.err($q$SELECT * FROM public.jug_overview('f5000000-0000-0000-0000-000000000001', '2026-10-01', '2026-10-02')$q$);
  PERFORM pg_temp.check(e LIKE '%Insufficient%', 'no rights, no overview');
END $$;

-- @@ Test 8: transactions are append-only for app users
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM pg_temp.as_user('1');
  PERFORM pg_temp.check(pg_temp.err(format('UPDATE jug_returns SET quantity_received = 60 WHERE id = %L', pg_temp.id('ret1'))) LIKE '%denied%',
                        'a verified return cannot be edited');
  PERFORM pg_temp.check(pg_temp.err(format('DELETE FROM jug_returns WHERE id = %L', pg_temp.id('ret1'))) LIKE '%denied%',
                        'nor deleted');
  PERFORM pg_temp.check(pg_temp.err('DELETE FROM container_movements WHERE factory_id = ''f5000000-0000-0000-0000-000000000001''') IS NOT NULL,
                        'ledger lines cannot be deleted');
END $$;
RESET ROLE;
