-- ============================================================================
-- Tests: Maintenance page (20261028290000_maintenance_page.sql). Same harness
-- as payments_recorded_final_test.sql; never run against production.
-- An admin keeps the parts; a second admin approves issues.
-- ============================================================================
INSERT INTO factories(id, code, name) VALUES ('f5000000-0000-0000-0000-000000000001', 'mnttest', 'Maintenance Test Factory');
INSERT INTO auth.users(id, email) VALUES ('a5000000-0000-0000-0000-000000000001', 'clerk@mnt'), ('a5000000-0000-0000-0000-000000000002', 'admin@mnt');
INSERT INTO user_roles(user_id, role) VALUES ('a5000000-0000-0000-0000-000000000001', 'super_admin'), ('a5000000-0000-0000-0000-000000000002', 'super_admin');
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END; $$;

-- @@ Buy a part, issue it (waits for approval), approve it
DO $$
DECLARE f uuid := 'f5000000-0000-0000-0000-000000000001'; v jsonb; part uuid; iss uuid;
BEGIN
  PERFORM set_config('test.uid', 'a5000000-0000-0000-0000-000000000001', false);
  v := public.save_maintenance_part(jsonb_build_object('factory_id', f, 'name', 'POP LIGHT', 'category', 'machine_part'));
  part := (v->>'id')::uuid;
  PERFORM public.record_maintenance_stock(jsonb_build_object('part_id', part, 'movement_type', 'purchased',
            'quantity', 2, 'unit_cost', 5000, 'source', 'Saheed'));
  PERFORM pg_temp.check((SELECT quantity_on_hand FROM maintenance_parts WHERE id = part) = 2, 'bought 2');
  v := public.record_maintenance_stock(jsonb_build_object('part_id', part, 'movement_type', 'issued',
            'quantity', 2, 'source', 'Saheed', 'notes', 'For Admin''s office'));
  PERFORM pg_temp.check((v->>'pending_approval')::boolean, 'issue waits');
  PERFORM pg_temp.check((SELECT quantity_on_hand FROM maintenance_parts WHERE id = part) = 2, 'stock untouched until approved');
  iss := (v->>'id')::uuid;
  PERFORM set_config('test.uid', 'a5000000-0000-0000-0000-000000000002', false);
  PERFORM public.decide_maintenance_issue(iss, true, NULL);
  PERFORM pg_temp.check((SELECT quantity_on_hand FROM maintenance_parts WHERE id = part) = 0, 'issued on approval');
  PERFORM pg_temp.check((SELECT count(*) FROM maintenance_stock_movements WHERE part_id = part) = 2, 'two movements');
END $$;
SELECT 'ok' AS result;

-- @@ A request is approved, bought against, and completed
DO $$
DECLARE f uuid := 'f5000000-0000-0000-0000-000000000001'; v jsonb; req uuid;
BEGIN
  PERFORM set_config('test.uid', 'a5000000-0000-0000-0000-000000000001', false);
  v := public.create_maintenance_request(jsonb_build_object('factory_id', f, 'category', 'factory_maintenance', 'title', 'Fix gate'));
  req := (v->>'id')::uuid;
  PERFORM set_config('test.uid', 'a5000000-0000-0000-0000-000000000002', false);
  PERFORM public.decide_maintenance_request(req, true, NULL);
  PERFORM public.add_maintenance_purchase(jsonb_build_object('request_id', req, 'item_description', 'Hinges', 'quantity', 2, 'unit_cost', 1500));
  PERFORM public.complete_maintenance_request(req, 'done');
  PERFORM pg_temp.check((SELECT status FROM maintenance_requests WHERE id = req) = 'completed', 'completed');
  PERFORM pg_temp.check((SELECT sum(amount) FROM maintenance_purchases WHERE request_id = req) = 3000, 'spent 3,000');
END $$;
SELECT 'ok' AS result;

-- @@ Reject needs a reason, withdraw, no more than is free, adjust down waits
DO $$
DECLARE f uuid := 'f5000000-0000-0000-0000-000000000001'; v jsonb; part uuid; a uuid; b uuid; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'a5000000-0000-0000-0000-000000000001', false);
  v := public.save_maintenance_part(jsonb_build_object('factory_id', f, 'name', 'SWITCH', 'category', 'machine_part'));
  part := (v->>'id')::uuid;
  PERFORM public.record_maintenance_stock(jsonb_build_object('part_id', part, 'movement_type', 'received', 'quantity', 3));
  a := (public.record_maintenance_stock(jsonb_build_object('part_id', part, 'movement_type', 'issued', 'quantity', 2))->>'id')::uuid;
  -- only 1 left free (3 on hand - 2 pending)
  BEGIN PERFORM public.record_maintenance_stock(jsonb_build_object('part_id', part, 'movement_type', 'issued', 'quantity', 2));
  EXCEPTION WHEN OTHERS THEN ok := true; END;
  PERFORM pg_temp.check(ok, 'over-request refused');
  b := (public.record_maintenance_stock(jsonb_build_object('part_id', part, 'movement_type', 'adjustment', 'quantity', -1, 'notes', 'count'))->>'id')::uuid;
  PERFORM pg_temp.check((SELECT quantity_on_hand FROM maintenance_parts WHERE id = part) = 3, 'adjust down waits');
  PERFORM public.cancel_maintenance_issue(b);
  PERFORM pg_temp.check((SELECT status FROM maintenance_issue_requests WHERE id = b) = 'cancelled', 'withdrawn');
  PERFORM set_config('test.uid', 'a5000000-0000-0000-0000-000000000002', false);
  ok := false;
  BEGIN PERFORM public.decide_maintenance_issue(a, false, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; END;
  PERFORM pg_temp.check(ok, 'reject needs a reason');
  PERFORM public.decide_maintenance_issue(a, false, 'not needed');
  PERFORM pg_temp.check((SELECT status FROM maintenance_issue_requests WHERE id = a) = 'rejected', 'rejected');
  PERFORM pg_temp.check((SELECT quantity_on_hand FROM maintenance_parts WHERE id = part) = 3, 'stock unchanged');
END $$;
SELECT 'ok' AS result;
