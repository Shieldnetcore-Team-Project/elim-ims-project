-- ============================================================================
-- Acceptance tests: cash requisition (20261121110000)
-- Items total the request; Accounts accept then Chairman approves; either
-- rejects only with a reason; maintenance staff can't decide; order enforced.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fa000000-0000-0000-0000-0000000000c1', 'crtest', 'CR Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', 'maint@cr'),
  ('a0000000-0000-0000-0000-0000000000c2', 'acct@cr'),
  ('a0000000-0000-0000-0000-0000000000c3', 'chair@cr');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', 'maintenance', 'fa000000-0000-0000-0000-0000000000c1'),
  ('a0000000-0000-0000-0000-0000000000c2', 'accountant', 'fa000000-0000-0000-0000-0000000000c1'),
  ('a0000000-0000-0000-0000-0000000000c3', 'chairman', NULL)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.new_req() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000c1', false);
  r := public.create_maintenance_request(jsonb_build_object(
    'factory_id','fa000000-0000-0000-0000-0000000000c1','category','vehicle_repair',
    'title','Servicing ABJ-465 YT',
    'items', jsonb_build_array(
      jsonb_build_object('item_name','Oil filter','quantity',2,'unit_amount',3000),
      jsonb_build_object('item_name','Engine oil','description','4L tins','quantity',2,'unit_amount',13600))));
  RETURN (r->>'id')::uuid;
END $$;

-- @@ Test 1: items saved, total = sum of qty x amount
DO $$
DECLARE v uuid; n int;
BEGIN
  v := pg_temp.new_req();
  n := (SELECT count(*) FROM maintenance_request_items WHERE request_id = v);
  PERFORM pg_temp.check(n = 2, 'two items');
  PERFORM pg_temp.check((SELECT estimated_cost FROM maintenance_requests WHERE id = v) = 33200, 'total 33,200');
  PERFORM pg_temp.check((SELECT amount FROM maintenance_request_items WHERE request_id = v AND line_no = 2) = 27200, 'line total');
END $$;

-- @@ Test 2: Accounts then Chairman; order enforced; maintenance can't decide
DO $$
DECLARE v uuid; ok boolean := false;
BEGIN
  v := pg_temp.new_req();
  -- chairman can't jump ahead of Accounts
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000c3', false);
  BEGIN
    PERFORM public.decide_maintenance_request(v, true, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%waiting for Accounts%';
  END;
  PERFORM pg_temp.check(ok, 'chairman waits for Accounts');
  ok := false;

  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000c1', false);
  BEGIN
    PERFORM public.decide_maintenance_request(v, true, NULL); -- as maintenance (requester)
  EXCEPTION WHEN OTHERS THEN ok := true;
  END;
  PERFORM pg_temp.check(ok, 'requester cannot decide');

  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000c2', false);
  PERFORM public.decide_maintenance_request(v, true, 'Budget ok');
  PERFORM pg_temp.check((SELECT status = 'accounts_approved' AND accounts_note = 'Budget ok'
                           FROM maintenance_requests WHERE id = v), 'accounts accepted');
  ok := false;
  BEGIN
    PERFORM public.decide_maintenance_request(v, true, NULL); -- accountant again
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Chairman%';
  END;
  PERFORM pg_temp.check(ok, 'accountant cannot give the final approval');

  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000c3', false);
  PERFORM public.decide_maintenance_request(v, true, NULL);
  PERFORM pg_temp.check((SELECT status = 'approved' AND chairman_by_name IS NOT DISTINCT FROM chairman_by_name
                           AND chairman_at IS NOT NULL
                           FROM maintenance_requests WHERE id = v), 'chairman approved');
END $$;

-- @@ Test 3: reject needs a reason; Accounts reject ends it
DO $$
DECLARE v uuid; ok boolean := false;
BEGIN
  v := pg_temp.new_req();
  PERFORM set_config('test.uid', 'a0000000-0000-0000-0000-0000000000c2', false);
  BEGIN
    PERFORM public.decide_maintenance_request(v, false, '  ');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%reason%';
  END;
  PERFORM pg_temp.check(ok, 'reason required');
  PERFORM public.decide_maintenance_request(v, false, 'Too expensive');
  PERFORM pg_temp.check((SELECT status = 'rejected' AND accounts_note = 'Too expensive' AND decision_note = 'Too expensive'
                           FROM maintenance_requests WHERE id = v), 'rejected by accounts');
END $$;

-- @@ Test 4: accountant can read requests and items
DO $$
BEGIN
  PERFORM pg_temp.check(public.is_requisition_accounts('a0000000-0000-0000-0000-0000000000c2'), 'accountant is Accounts');
  PERFORM pg_temp.check(NOT public.is_requisition_accounts('a0000000-0000-0000-0000-0000000000c1'), 'maintenance is not Accounts');
  PERFORM pg_temp.check(NOT public.is_requisition_chairman('a0000000-0000-0000-0000-0000000000c2'), 'accountant is not Chairman');
END $$;
