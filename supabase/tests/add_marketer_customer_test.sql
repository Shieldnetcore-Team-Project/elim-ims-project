-- ============================================================================
-- Acceptance tests: add_marketer_customer (20261029240000_add_marketer_customer.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. An accountant adds customers under the
-- marketer "AMC Sunday" from his account.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('ae000000-0000-0000-0000-000000000001', 'acct@amc'),
  ('ae000000-0000-0000-0000-000000000002', 'prod@amc');
DELETE FROM user_roles WHERE user_id IN ('ae000000-0000-0000-0000-000000000001', 'ae000000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT v.u::uuid, v.r, f.id FROM factories f,
  (VALUES ('ae000000-0000-0000-0000-000000000001', 'accountant'),
          ('ae000000-0000-0000-0000-000000000002', 'production')) v(u, r)
 WHERE f.code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'af000000-0000-0000-0000-000000000001', id, 'AMC Sunday', 'active', 'rep' FROM factories WHERE code = 'water';
INSERT INTO customers(id, factory_id, name, phone, registered)
SELECT 'af000000-0000-0000-0000-000000000011', id, 'AMC Old Customer', '08000000111', true FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.fails(p_sql text, p_like text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE p_like THEN RAISE NOTICE 'unexpected error: %', SQLERRM; RETURN false; END IF;
  RETURN true;
END;
$$;

-- @@ Test 1: a new customer is created under the marketer; an existing one is moved under him
DO $$
DECLARE r jsonb; c record;
BEGIN
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
  r := public.add_marketer_customer('af000000-0000-0000-0000-000000000001', NULL, '  AMC Mama Joy ', '08000000222', 'Kubwa');
  SELECT * INTO c FROM customers WHERE id = (r->>'customer_id')::uuid;
  PERFORM pg_temp.check(c.name = 'AMC Mama Joy' AND c.sales_rep_id = 'af000000-0000-0000-0000-000000000001'
                        AND c.phone = '08000000222' AND c.address = 'Kubwa' AND c.registered, 'new: ' || row_to_json(c)::text);
  PERFORM public.add_marketer_customer('af000000-0000-0000-0000-000000000001', 'af000000-0000-0000-0000-000000000011');
  SELECT * INTO c FROM customers WHERE id = 'af000000-0000-0000-0000-000000000011';
  PERFORM pg_temp.check(c.sales_rep_id = 'af000000-0000-0000-0000-000000000001', 'existing moved under Sunday');
  PERFORM pg_temp.check((SELECT count(*) FROM audit_logs WHERE action = 'add_marketer_customer'
                          AND new_value->>'marketer' = 'AMC Sunday') = 2, 'audited');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.rep_customers('af000000-0000-0000-0000-000000000001')
                                 WHERE name = 'AMC Mama Joy'), 'listed under the marketer');
END $$;

-- @@ Test 2: duplicates, already-assigned, no name, and no rights are refused
DO $$
BEGIN
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.add_marketer_customer('af000000-0000-0000-0000-000000000001', NULL, 'amc old customer')$q$,
                                      '%already on the customer list%'), 'same name refused');
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.add_marketer_customer('af000000-0000-0000-0000-000000000001', 'af000000-0000-0000-0000-000000000011')$q$,
                                      '%already one of%'), 'already assigned refused');
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.add_marketer_customer('af000000-0000-0000-0000-000000000001', NULL, '  ')$q$,
                                      '%Enter the customer%'), 'no name refused');
  PERFORM set_config('test.uid', 'ae000000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(pg_temp.fails($q$SELECT public.add_marketer_customer('af000000-0000-0000-0000-000000000001', NULL, 'AMC New')$q$,
                                      '%Insufficient permissions%'), 'production refused');
END $$;
