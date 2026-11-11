-- ============================================================================
-- Acceptance tests: daily / shift opening and closing balances, carried
-- forward (20261111090000_production_daily_shift_balance.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
--
-- The worked example from the brief (Morning = Day shift, Afternoon = Night
-- shift, which runs on past 6 p.m. on the same production day):
--   Day 1: open 0,      Day +5,000 -500 = 4,500,  Night +3,000 -1,000 = 6,500
--   Day 2: open 6,500,  Day +2,000 -500 = 8,000,  Night +3,500 -1,000 = 10,500
--   Day 3: open 10,500
-- The three days are the latest three in a row with no Sunday among the last
-- 7 days, so releases can be dated on them.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('6a000000-0000-0000-0000-000000001111', 'pm@dailybal');
INSERT INTO profiles(id, email, full_name)
SELECT '6a000000-0000-0000-0000-000000001111', 'pm@dailybal', 'PM Daily'
 WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE id = '6a000000-0000-0000-0000-000000001111');
DELETE FROM user_roles WHERE user_id = '6a000000-0000-0000-0000-000000001111';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('6a000000-0000-0000-0000-000000001111', 'super_admin', (SELECT id FROM factories WHERE code = 'water'));
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('6d000000-0000-0000-0000-000000001111', (SELECT id FROM factories WHERE code = 'water'), 'DB Sachet Water', 'Bag', 0, 0, 'finished'),
  ('6d000000-0000-0000-0000-000000001112', (SELECT id FROM factories WHERE code = 'water'), 'DB 50cl Bottle Water', 'Pack', 0, 0, 'finished');

SELECT set_config('test.uid', '6a000000-0000-0000-0000-000000001111', false);
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- Day 1 of the example: the first of three days with no Sunday, 2..6 days ago.
CREATE TEMP TABLE t_days AS
SELECT min(d)::date AS day1 FROM (
  SELECT ((now() AT TIME ZONE 'Africa/Lagos')::date - k) AS d
    FROM generate_series(2, 6) k
) c
WHERE extract(dow FROM d) NOT IN (0, 5, 6)   -- d, d+1, d+2 none a Sunday
  AND d + 2 < (now() AT TIME ZONE 'Africa/Lagos')::date;

CREATE OR REPLACE FUNCTION pg_temp.make(p_day date, p_shift text, p_qty numeric, p_op text, p_damaged numeric DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  RETURN (public.create_production(jsonb_build_object(
    'factory_id', (SELECT id FROM factories WHERE code = 'water'),
    'product_id', '6d000000-0000-0000-0000-000000001111',
    'quantity_produced', p_qty, 'damaged_quantity', p_damaged, 'unit', 'Bag',
    'production_date', p_day, 'shift', p_shift, 'supervisor', p_op))->>'id')::uuid;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.issue(p_day date, p_shift text, p_qty numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  RETURN (public.release_to_warehouse(jsonb_build_object(
    'factory_id', (SELECT id FROM factories WHERE code = 'water'),
    'product_id', '6d000000-0000-0000-0000-000000001111',
    'quantity', p_qty, 'production_date', p_day, 'shift', p_shift))->>'id')::uuid;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.row_of(p_day date, p_shift text)
RETURNS record LANGUAGE sql AS $$
  SELECT (b.prev_closing, b.opening, b.produced, b.damaged, b.issued, b.closing, b.operators)
    FROM public.production_daily_balance((SELECT id FROM factories WHERE code = 'water'),
           '6d000000-0000-0000-0000-000000001111', p_day, p_day) b
   WHERE b.shift = p_shift;
$$;
CREATE OR REPLACE FUNCTION pg_temp.bal(p_day date, p_shift text, p_col text)
RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE v numeric;
BEGIN
  EXECUTE format('SELECT b.%I FROM public.production_daily_balance($1, $2, $3, $3) b WHERE b.shift = $4', p_col)
     INTO v USING (SELECT id FROM factories WHERE code = 'water'), '6d000000-0000-0000-0000-000000001111'::uuid, p_day, p_shift;
  RETURN v;
END $$;

-- @@ Test 1: first production day opens at 0; Day (morning) then Night (afternoon) shift
DO $$
DECLARE d1 date := (SELECT day1 FROM t_days);
BEGIN
  PERFORM pg_temp.check(d1 IS NOT NULL, 'test needs three weekdays in the last week');
  PERFORM pg_temp.make(d1, 'day', 5000, 'Gideon');
  PERFORM pg_temp.make(d1, 'night', 3000, 'Musa');
  PERFORM pg_temp.issue(d1, 'day', 500);
  PERFORM pg_temp.issue(d1, 'night', 1000);

  PERFORM pg_temp.check(pg_temp.bal(d1, 'day', 'prev_closing') = 0, 'day 1 previous closing 0');
  PERFORM pg_temp.check(pg_temp.bal(d1, 'day', 'opening') = 0, 'day 1 opens at 0');
  PERFORM pg_temp.check(pg_temp.bal(d1, 'day', 'produced') = 5000, 'morning produced 5,000');
  PERFORM pg_temp.check(pg_temp.bal(d1, 'day', 'issued') = 500, 'morning issued 500');
  PERFORM pg_temp.check(pg_temp.bal(d1, 'day', 'closing') = 4500, 'morning closing 4,500');
  PERFORM pg_temp.check(pg_temp.bal(d1, 'night', 'opening') = 4500, 'afternoon opens at morning closing');
  PERFORM pg_temp.check(pg_temp.bal(d1, 'night', 'closing') = 6500, 'final closing 6,500');
  PERFORM pg_temp.check(pg_temp.bal(d1, 'overtime', 'closing') = 6500, 'no over-time: unchanged');
END $$;

-- @@ Test 2: Monday's closing opens Tuesday automatically, counted once
DO $$
DECLARE d1 date := (SELECT day1 FROM t_days); d2 date := (SELECT day1 + 1 FROM t_days);
BEGIN
  PERFORM pg_temp.make(d2, 'day', 2000, 'Gideon');
  PERFORM pg_temp.make(d2, 'night', 3500, 'Musa');
  PERFORM pg_temp.issue(d2, 'day', 500);
  PERFORM pg_temp.issue(d2, 'night', 1000);
  PERFORM pg_temp.check(pg_temp.bal(d2, 'day', 'prev_closing') = 6500, 'previous day closing 6,500');
  PERFORM pg_temp.check(pg_temp.bal(d2, 'day', 'opening') = 6500, 'Tuesday opens at 6,500');
  PERFORM pg_temp.check(pg_temp.bal(d2, 'day', 'closing') = 8000, 'morning closing 8,000');
  PERFORM pg_temp.check(pg_temp.bal(d2, 'night', 'opening') = 8000, 'afternoon opening 8,000');
  PERFORM pg_temp.check(pg_temp.bal(d2, 'night', 'closing') = 10500, 'final closing 10,500');
  -- Monday is unchanged by Tuesday's entries.
  PERFORM pg_temp.check(pg_temp.bal(d1, 'night', 'closing') = 6500, 'Monday still 6,500');
END $$;

-- @@ Test 3: Wednesday opens at 10,500; a shift with no production carries over; ranges agree
DO $$
DECLARE d1 date := (SELECT day1 FROM t_days); d3 date := (SELECT day1 + 2 FROM t_days);
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '6d000000-0000-0000-0000-000000001111';
  today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  v_last numeric; n int;
BEGIN
  PERFORM pg_temp.check(pg_temp.bal(d3, 'day', 'opening') = 10500, 'Wednesday opens at 10,500');
  PERFORM pg_temp.check(pg_temp.bal(d3, 'day', 'closing') = 10500, 'empty morning shift: closing = opening');
  -- Asked for the three days at once, the figures are the same as one by one.
  SELECT count(*) INTO n FROM public.production_daily_balance(f, p, d1, d1 + 2) b
   WHERE (b.production_date = d1 AND b.shift = 'night' AND b.closing = 6500)
      OR (b.production_date = d1 + 1 AND b.shift = 'day' AND b.opening = 6500 AND b.closing = 8000)
      OR (b.production_date = d1 + 1 AND b.shift = 'night' AND b.closing = 10500)
      OR (b.production_date = d1 + 2 AND b.shift = 'day' AND b.opening = 10500);
  PERFORM pg_temp.check(n = 4, 'range query agrees, got ' || n);
  -- Every stage opens at the previous stage's closing (no gaps, nothing twice).
  SELECT count(*) INTO n FROM public.production_daily_balance(f, p, d1, today) b
   WHERE b.opening <> b.prev_closing AND NOT b.opening_reset;
  PERFORM pg_temp.check(n = 0, 'chain broken in ' || n || ' rows');
  -- Today's last closing is what is in the hall now.
  SELECT b.closing INTO v_last FROM public.production_daily_balance(f, p, today, today) b
   WHERE b.shift = 'overtime';
  PERFORM pg_temp.check(v_last = public._production_hall_available(f, p),
                        'today closing ' || v_last || ' = hall ' || public._production_hall_available(f, p));
END $$;

-- @@ Test 4: production after 6 p.m. entered late stays on its own day and re-flows forward
DO $$
DECLARE d1 date := (SELECT day1 FROM t_days); d2 date := (SELECT day1 + 1 FROM t_days);
BEGIN
  -- Monday's night run went on to 9 p.m.: 200 more bags keyed in today, on Monday.
  PERFORM pg_temp.make(d1, 'night', 200, 'Musa');
  PERFORM pg_temp.check(pg_temp.bal(d1, 'night', 'closing') = 6700, 'Monday final closing 6,700');
  PERFORM pg_temp.check(pg_temp.bal(d2, 'day', 'opening') = 6700, 'Tuesday opening follows: 6,700');
  PERFORM pg_temp.check(pg_temp.bal(d2, 'night', 'closing') = 10700, 'Tuesday closing 10,700');
  -- The late entry is in the audit log as late.
  PERFORM pg_temp.check(EXISTS (
    SELECT 1 FROM audit_logs a
     WHERE a.action = 'record_production' AND (a.new_value->>'production_date')::date = d1
       AND (a.new_value->>'quantity')::numeric = 200 AND (a.new_value->>'late_entry')::boolean),
    'late production audited');
  PERFORM pg_temp.check(EXISTS (
    SELECT 1 FROM audit_logs a
     WHERE a.action = 'release_to_warehouse' AND (a.new_value->>'production_date')::date = d1
       AND (a.new_value->>'late_entry')::boolean),
    'back-dated release audited as late');
END $$;

-- @@ Test 5: damages and withdrawn issues; corrections re-flow, history kept
DO $$
DECLARE d1 date := (SELECT day1 FROM t_days); d2 date := (SELECT day1 + 1 FROM t_days);
  d3 date := (SELECT day1 + 2 FROM t_days); rid uuid;
BEGIN
  -- Wednesday afternoon: 1,000 made, 40 damaged, 300 issued.
  PERFORM pg_temp.make(d3, 'night', 1000, 'Musa', 40);
  rid := pg_temp.issue(d3, 'night', 300);
  PERFORM pg_temp.check(pg_temp.bal(d3, 'night', 'damaged') = 40, 'damage shown');
  PERFORM pg_temp.check(pg_temp.bal(d3, 'night', 'closing') = 10700 + 1000 - 40 - 300, 'closing 11,360');
  -- The issue is withdrawn: it is back in the hall, and the day re-flows.
  PERFORM public.cancel_production_release(rid);
  PERFORM pg_temp.check(pg_temp.bal(d3, 'night', 'issued') = 0, 'withdrawn issue no longer counts');
  PERFORM pg_temp.check(pg_temp.bal(d3, 'night', 'closing') = 11660, 'closing 11,660');
  PERFORM pg_temp.check((SELECT status FROM production_releases WHERE id = rid) = 'cancelled',
                        'withdrawn release kept in history');
  -- Earlier days untouched.
  PERFORM pg_temp.check(pg_temp.bal(d2, 'night', 'closing') = 10700, 'Tuesday unchanged');
END $$;

-- @@ Test 6: guards -- future / too-old release day, more than the hall, duplicate batch
DO $$
DECLARE ok boolean;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '6d000000-0000-0000-0000-000000001111';
  today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  ok := false;
  BEGIN PERFORM pg_temp.issue(today + 1, 'day', 1);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%after today%'; END;
  PERFORM pg_temp.check(ok, 'future release day refused');
  ok := false;
  BEGIN PERFORM pg_temp.issue(today - 8, 'day', 1);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%7 days back%'; END;
  PERFORM pg_temp.check(ok, 'release more than 7 days back refused');
  ok := false;
  BEGIN PERFORM pg_temp.issue(today, 'day', 1000000);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Only%in the production hall%'; END;
  PERFORM pg_temp.check(ok, 'cannot issue more than the hall');

  PERFORM pg_temp.make(today, 'day', 77, 'Gideon');
  ok := false;
  BEGIN PERFORM pg_temp.make(today, 'day', 77, 'Gideon');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%already recorded a moment ago%'; END;
  PERFORM pg_temp.check(ok, 'same batch twice refused');
  PERFORM pg_temp.make(today, 'day', 78, 'Gideon');   -- a different batch is fine
  PERFORM pg_temp.check((SELECT closing FROM public.production_daily_balance(f, p, today, today) WHERE shift = 'overtime')
                        = public._production_hall_available(f, p), 'still equals the hall');
END $$;

-- @@ Test 7: an opening balance resets the chain on its day; other products separate
DO $$
DECLARE d2 date := (SELECT day1 + 1 FROM t_days); d3 date := (SELECT day1 + 2 FROM t_days);
  f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := '6d000000-0000-0000-0000-000000001111';
  n int;
BEGIN
  INSERT INTO production_hall_openings(factory_id, product_id, opening_date, quantity, reason, created_by)
  VALUES (f, p, d3, 9000, 'count', auth.uid());
  PERFORM pg_temp.check(pg_temp.bal(d3, 'day', 'prev_closing') = 10700, 'previous closing shown');
  PERFORM pg_temp.check(pg_temp.bal(d3, 'day', 'opening') = 9000, 'opening reset to the count');
  PERFORM pg_temp.check((SELECT opening_reset FROM public.production_daily_balance(f, p, d3, d3) WHERE shift = 'day'),
                        'reset flagged');
  PERFORM pg_temp.check(pg_temp.bal(d2, 'night', 'closing') = 10700, 'day before untouched');
  PERFORM pg_temp.check((SELECT closing FROM public.production_daily_balance(f, p,
                           (now() AT TIME ZONE 'Africa/Lagos')::date, (now() AT TIME ZONE 'Africa/Lagos')::date)
                          WHERE shift = 'overtime') = public._production_hall_available(f, p),
                        'after the opening still equals the hall');
  -- All products at once: the bottle product with nothing recorded isn't listed,
  -- the sachet is.
  SELECT count(DISTINCT b.product_id) INTO n FROM public.production_daily_balance(f, NULL, d3, d3) b
   WHERE b.product_id IN (p, '6d000000-0000-0000-0000-000000001112');
  PERFORM pg_temp.check(n = 1, 'only products with activity, got ' || n);
END $$;
