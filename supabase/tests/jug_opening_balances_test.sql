-- ============================================================================
-- Acceptance tests: opening balances for jug minus figures
-- (20261110100000_jug_opening_balances.sql)
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9800000-0000-0000-0000-000000000001', 'obfac', 'OB Factory');
INSERT INTO auth.users(id, email) VALUES ('a9800000-0000-0000-0000-000000000001', 'admin@ob');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e9800000-0000-0000-0000-000000000001', 'f9800000-0000-0000-0000-000000000001', 'Old Dispenser Jug'),
  ('e9800000-0000-0000-0000-000000000002', 'f9800000-0000-0000-0000-000000000001', 'New Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, product_type) VALUES
  ('d9800000-0000-0000-0000-000000000001', 'f9800000-0000-0000-0000-000000000001', 'OB Dispenser Water', 'Piece', 1200, 'finished'),
  ('d9800000-0000-0000-0000-000000000002', 'f9800000-0000-0000-0000-000000000001', 'OB Sachet', 'Bag', 300, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('d9800000-0000-0000-0000-000000000001', 'e9800000-0000-0000-0000-000000000002', 1, 'with_water');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c9800000-0000-0000-0000-000000000001', 'f9800000-0000-0000-0000-000000000001', 'OB Held', 'active', 'rep'),
  ('c9800000-0000-0000-0000-000000000002', 'f9800000-0000-0000-0000-000000000001', 'OB Returned Same Day', 'active', 'rep'),
  ('c9800000-0000-0000-0000-000000000003', 'f9800000-0000-0000-0000-000000000001', 'OB Mixed Types', 'active', 'rep'),
  ('c9800000-0000-0000-0000-000000000004', 'f9800000-0000-0000-0000-000000000001', 'OB Reversed', 'active', 'rep'),
  ('c9800000-0000-0000-0000-000000000005', 'f9800000-0000-0000-0000-000000000001', 'OB Sachet Only', 'active', 'rep'),
  ('c9800000-0000-0000-0000-000000000006', 'f9800000-0000-0000-0000-000000000001', 'OB Shop', 'active', 'outlet');
INSERT INTO customers(id, factory_id, name) VALUES
  ('b9800000-0000-0000-0000-000000000001', 'f9800000-0000-0000-0000-000000000001', 'OB Commission'),
  ('b9800000-0000-0000-0000-000000000002', 'f9800000-0000-0000-0000-000000000001', 'OB Pending Count');
SELECT set_config('test.uid', 'a9800000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
-- A jug move on a day (noon Lagos).
CREATE OR REPLACE FUNCTION pg_temp.mv(p_ft text, p_fid uuid, p_tt text, p_tid uuid, p_type int, p_q numeric, p_src text, p_day date)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity, source, created_at)
  VALUES ('f9800000-0000-0000-0000-000000000001', ('e9800000-0000-0000-0000-00000000000' || p_type)::uuid,
          p_ft, p_fid, p_tt, p_tid, p_q, p_src, (p_day::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Lagos');
$$;
-- A posting on the supply day; the item trigger moves its jugs Warehouse -> rep.
CREATE OR REPLACE FUNCTION pg_temp.post(p_rep int, p_product int, p_q numeric, p_status text DEFAULT 'posted')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO stock_dispatches(id, factory_id, dispatch_number, dispatch_date, sales_rep_id, total_value, status)
  VALUES (v, 'f9800000-0000-0000-0000-000000000001', 'OB-' || left(v::text, 8), '2026-11-09',
          ('c9800000-0000-0000-0000-00000000000' || p_rep)::uuid, 0, 'posted');
  INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value)
  VALUES (v, ('d9800000-0000-0000-0000-00000000000' || p_product)::uuid, p_q, 1200, p_q * 1200);
  IF p_status = 'reversed' THEN UPDATE stock_dispatches SET status = 'reversed' WHERE id = v; END IF;
END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.total(p_type text, p_id uuid) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(balance), 0) FROM container_balances WHERE holder_type = p_type AND holder_id = p_id;
$$;

-- @@ Test 1: who gets an opening balance, who is held; preview writes nothing; a rerun clears the held marketer
DO $$
DECLARE
  c1 uuid := 'b9800000-0000-0000-0000-000000000001'; c2 uuid := 'b9800000-0000-0000-0000-000000000002';
  held uuid := 'c9800000-0000-0000-0000-000000000001'; same uuid := 'c9800000-0000-0000-0000-000000000002';
  mixed uuid := 'c9800000-0000-0000-0000-000000000003'; rev uuid := 'c9800000-0000-0000-0000-000000000004';
  sachet uuid := 'c9800000-0000-0000-0000-000000000005'; shop uuid := 'c9800000-0000-0000-0000-000000000006';
  n_before int; r record;
BEGIN
  -- British High Commission's shape: one return, nothing ever supplied.
  PERFORM pg_temp.mv('customer', c1, 'warehouse', NULL, 2, 233, 'return', '2026-11-03');
  -- A customer with a return waiting for QC.
  PERFORM pg_temp.mv('customer', c2, 'warehouse', NULL, 2, 10, 'return', '2026-11-05');
  INSERT INTO jug_returns(factory_id, reference, customer_id, container_type_id, quantity_claimed, recorded_by)
  VALUES ('f9800000-0000-0000-0000-000000000001', 'JR-OB-1', c2, 'e9800000-0000-0000-0000-000000000002', 4,
          'a9800000-0000-0000-0000-000000000001');
  -- Supplied on the 9th, no empties entered since: held.
  PERFORM pg_temp.mv('sales_rep', held, 'warehouse', NULL, 2, 30, 'return', '2026-11-06');
  PERFORM pg_temp.post(1, 1, 10);
  -- Supplied on the 9th, empties entered on the 9th: not held.
  PERFORM pg_temp.mv('sales_rep', same, 'warehouse', NULL, 2, 30, 'return', '2026-11-09');
  PERFORM pg_temp.post(2, 1, 10);
  -- Old -214, New +122 (no posting that day): the person lands on 0, not +122.
  PERFORM pg_temp.mv('sales_rep', mixed, 'warehouse', NULL, 1, 214, 'return', '2026-11-02');
  PERFORM pg_temp.mv('warehouse', NULL, 'sales_rep', mixed, 2, 122, 'dispatch', '2026-11-04');
  -- A reversed dispenser posting doesn't hold anyone.
  PERFORM pg_temp.mv('sales_rep', rev, 'warehouse', NULL, 2, 5, 'return', '2026-11-06');
  PERFORM pg_temp.post(4, 1, 2, 'reversed');
  -- A posting with no dispensers doesn't hold anyone.
  PERFORM pg_temp.mv('sales_rep', sachet, 'warehouse', NULL, 2, 7, 'return', '2026-11-06');
  PERFORM pg_temp.post(5, 2, 50);
  -- The shop is not a marketer: not held even if supplied.
  PERFORM pg_temp.mv('sales_rep', shop, 'warehouse', NULL, 2, 51, 'return', '2026-11-05');
  PERFORM pg_temp.post(6, 1, 0.5);

  -- Preview: reports, writes nothing.
  n_before := (SELECT count(*) FROM container_movements);
  PERFORM pg_temp.check((SELECT count(*) FROM public._jug_opening_balances('2026-11-09', false)
                          WHERE who LIKE 'OB %' AND decision = 'OPENING BALANCE') = 6, 'preview: six opening balances');
  PERFORM pg_temp.check((SELECT count(*) FROM public._jug_opening_balances('2026-11-09', false)
                          WHERE who LIKE 'OB %' AND decision = 'HOLD') = 2, 'preview: two held');
  PERFORM pg_temp.check((SELECT count(*) FROM container_movements) = n_before, 'preview writes nothing');

  PERFORM * FROM public._jug_opening_balances('2026-11-09', true);

  -- Brought to 0, dated the day before the first return.
  PERFORM pg_temp.check(pg_temp.total('customer', c1) = 0, 'commission at 0');
  SELECT * INTO r FROM container_movements WHERE to_type = 'customer' AND to_id = c1 AND source = 'issue';
  PERFORM pg_temp.check(r.quantity = 233 AND r.from_type = 'external' AND r.reference = 'OPENING-BALANCE', 'issue of 233 from outside');
  PERFORM pg_temp.check(public._jug_day(r.created_at) = '2026-11-02', 'dated the day before the return');
  PERFORM pg_temp.check(pg_temp.total('sales_rep', same) = 0, 'returned the same day: at 0');
  PERFORM pg_temp.check(pg_temp.total('sales_rep', rev) = 0, 'reversed posting: at 0');
  PERFORM pg_temp.check(pg_temp.total('sales_rep', sachet) = 0, 'sachet posting: at 0');
  PERFORM pg_temp.check(pg_temp.total('sales_rep', shop) = 0, 'shop: at 0');
  -- Old and New together land on 0; only the shortfall is issued.
  PERFORM pg_temp.check(pg_temp.total('sales_rep', mixed) = 0, 'mixed types: person at 0');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM container_movements
                          WHERE to_type = 'sales_rep' AND to_id = mixed AND source = 'issue') = 92, 'mixed: only 92 issued');
  PERFORM pg_temp.check((SELECT count(*) FROM audit_logs WHERE action = 'jug_opening_balance' AND entity_id = c1::text) = 1, 'audited');

  -- Held: untouched.
  PERFORM pg_temp.check(pg_temp.total('sales_rep', held) = -20, 'held marketer untouched at -20');
  PERFORM pg_temp.check(pg_temp.total('customer', c2) = -10, 'pending count untouched at -10');

  -- A rerun touches only those still below 0, and adds nothing for the done.
  n_before := (SELECT count(*) FROM container_movements);
  PERFORM * FROM public._jug_opening_balances('2026-11-09', true);
  PERFORM pg_temp.check((SELECT count(*) FROM container_movements) = n_before, 'rerun with nothing new writes nothing');

  -- The held marketer's return goes in for the 9th; the next run clears them.
  PERFORM pg_temp.mv('sales_rep', held, 'warehouse', NULL, 2, 8, 'return', '2026-11-09');
  PERFORM * FROM public._jug_opening_balances('2026-11-09', true);
  PERFORM pg_temp.check(pg_temp.total('sales_rep', held) = 0, 'held marketer cleared once the return is in');
  SELECT * INTO r FROM container_movements WHERE to_type = 'sales_rep' AND to_id = held AND source = 'issue';
  PERFORM pg_temp.check(r.quantity = 28 AND public._jug_day(r.created_at) = '2026-11-05', '28 dated before their first return');
END $$;
