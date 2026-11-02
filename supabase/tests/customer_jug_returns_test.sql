-- ============================================================================
-- Acceptance tests: customer_jug_returns (20261102150000_customer_jug_returns.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Own factory. A distributor holds 5 jugs
-- (sold with water); the Warehouse records 4 coming back; QC counts 4: the
-- jugs move back, no money is credited, QC's list names the customer.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fc000000-0000-0000-0000-000000000001', 'cjtest', 'CJ Test Factory');
INSERT INTO auth.users(id, email) VALUES ('ac000000-0000-0000-0000-000000000001', 'admin@cj'),
                                         ('ac000000-0000-0000-0000-000000000002', 'qc@cj');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('ac000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('ac000000-0000-0000-0000-000000000002', 'super_admin', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO customers(id, factory_id, name, registered, credit_balance, outstanding_balance) VALUES
  ('cc000000-0000-0000-0000-000000000001', 'fc000000-0000-0000-0000-000000000001', 'CJ Distributor', true, 0, 0);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT ALL ON ids TO authenticated;

-- @@ Test 1: record and count a distributor's empty jugs
DO $$
DECLARE t uuid; r jsonb; jr uuid;
BEGIN
  PERFORM set_config('test.uid', 'ac000000-0000-0000-0000-000000000001', false);
  t := public.save_container_type('fc000000-0000-0000-0000-000000000001', NULL, 'CJ Jug');
  INSERT INTO ids VALUES ('t', t);
  -- 5 jugs reached the customer (as a dispenser sale does).
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity, source, reference)
  VALUES ('fc000000-0000-0000-0000-000000000001', t, 'warehouse', NULL, 'customer', 'cc000000-0000-0000-0000-000000000001', 5, 'sale', 'CJ-INV-1');

  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.record_jug_return(jsonb_build_object(
           'customer_id', 'cc000000-0000-0000-0000-000000000001', 'container_type_id', '%s', 'quantity', 6))$q$, t))
         LIKE '%at most 5%', 'no more than they hold');
  r := public.record_jug_return(jsonb_build_object(
         'customer_id', 'cc000000-0000-0000-0000-000000000001', 'container_type_id', t, 'quantity', 4));
  jr := (r->>'id')::uuid;
  PERFORM pg_temp.check((SELECT customer_id FROM jug_returns WHERE id = jr) = 'cc000000-0000-0000-0000-000000000001'
                        AND (SELECT sales_rep_id FROM jug_returns WHERE id = jr) IS NULL, 'recorded for the customer');
  PERFORM pg_temp.check((SELECT holder FROM public.qc_pending_jug_returns('fc000000-0000-0000-0000-000000000001')
                          WHERE id = jr) = 'CJ Distributor', 'QC sees the customer');

  PERFORM set_config('test.uid', 'ac000000-0000-0000-0000-000000000002', false);
  PERFORM public.verify_jug_return(jr, 4, NULL);
  PERFORM pg_temp.check(public._jug_customer_balance('cc000000-0000-0000-0000-000000000001', t) = 1, '1 jug left with them');
  PERFORM pg_temp.check((SELECT credit_price FROM jug_returns WHERE id = jr) IS NULL
                        AND (SELECT credit_balance FROM customers WHERE id = 'cc000000-0000-0000-0000-000000000001') = 0,
                        'no money credited');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM qc_jug_batches WHERE jug_return_id = jr AND quantity_accepted = 4),
                        'QC consignment');
  -- Neither / both holders refused.
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.record_jug_return(jsonb_build_object(
           'container_type_id', '%s', 'quantity', 1))$q$, t)) LIKE '%Choose who%', 'needs a holder');
END $$;
