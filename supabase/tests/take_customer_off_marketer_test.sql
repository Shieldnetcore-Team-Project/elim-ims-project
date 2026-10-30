-- ============================================================================
-- Acceptance tests: taking a customer off a marketer's account
-- (reassign_customer_marketer to no marketer, used by "Take off" in
-- Marketer & retail accounts → a marketer → customers)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. An accountant with marketer-accounts edit
-- takes a customer off a marketer: no marketer any more, the customer is
-- kept, the move and its reason are in the marketer history. Without the
-- right it is refused; without a reason it is refused.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b1300000-0000-0000-0000-000000000001', 'admin@tko'),
  ('b1300000-0000-0000-0000-000000000002', 'nobody@tko');
DELETE FROM user_roles WHERE user_id IN ('b1300000-0000-0000-0000-000000000001', 'b1300000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('b1300000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'b1300000-0000-0000-0000-0000000000b1', id, 'TKO Marketer', 'active', 'rep' FROM factories WHERE code = 'water';
INSERT INTO customers(id, factory_id, name, registered, sales_rep_id)
SELECT 'b1300000-0000-0000-0000-0000000000c1', id, 'TKO Shop', true, 'b1300000-0000-0000-0000-0000000000b1'
  FROM factories WHERE code = 'water';

-- @@ Test 1: taken off with a reason; refused without the right or a reason
DO $$
DECLARE ok1 boolean := false; ok2 boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'b1300000-0000-0000-0000-000000000002', false);
  BEGIN
    PERFORM public.reassign_customer_marketer('b1300000-0000-0000-0000-0000000000c1', NULL, 'mistake');
  EXCEPTION WHEN OTHERS THEN ok1 := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM set_config('test.uid', 'b1300000-0000-0000-0000-000000000001', false);
  BEGIN
    PERFORM public.reassign_customer_marketer('b1300000-0000-0000-0000-0000000000c1', NULL, ' ');
  EXCEPTION WHEN OTHERS THEN ok2 := SQLERRM LIKE '%reason%';
  END;
  IF NOT (ok1 AND ok2) THEN RAISE EXCEPTION 'ASSERTION FAILED: refusals % %', ok1, ok2; END IF;

  PERFORM public.reassign_customer_marketer('b1300000-0000-0000-0000-0000000000c1', NULL, 'Added to this marketer by mistake');
  IF (SELECT sales_rep_id FROM customers WHERE id = 'b1300000-0000-0000-0000-0000000000c1') IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED: still assigned';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_marketer_history
                  WHERE customer_id = 'b1300000-0000-0000-0000-0000000000c1'
                    AND from_rep_id = 'b1300000-0000-0000-0000-0000000000b1' AND to_rep_id IS NULL
                    AND reason = 'Added to this marketer by mistake') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: history %', (SELECT jsonb_agg(h) FROM customer_marketer_history h
                                                   WHERE customer_id = 'b1300000-0000-0000-0000-0000000000c1');
  END IF;
END $$;
