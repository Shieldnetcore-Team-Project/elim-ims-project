-- ============================================================================
-- Acceptance tests: Store & Warehouse role for Ustin
-- (20261021130000_store_warehouse_role_aniaustin.sql)
--
-- Same harness as preform_inventory_test.sql (supabase/tests/pglite/README.md).
-- Uses its own factory and users; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fb000000-0000-0000-0000-000000000001', 'swtest', 'Store Warehouse Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('ab000000-0000-0000-0000-000000000001', 'aniaustin.sw@example.com'),
  ('ab000000-0000-0000-0000-000000000002', 'qc.sw@test');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'ab000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
-- As after 20261021120000: Sales plus Warehouse, and a one-off extra right.
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('ab000000-0000-0000-0000-000000000001', 'sales', 'fb000000-0000-0000-0000-000000000001'),
  ('ab000000-0000-0000-0000-000000000001', 'store_officer', 'fb000000-0000-0000-0000-000000000001'),
  ('ab000000-0000-0000-0000-000000000002', 'qc_officer', 'fb000000-0000-0000-0000-000000000001');
INSERT INTO suppliers(id, factory_id, name) VALUES
  ('bb000000-0000-0000-0000-000000000001', 'fb000000-0000-0000-0000-000000000001', 'SW Test Supplier');
INSERT INTO permission_overrides(user_id, module, action, granted)
VALUES ('ab000000-0000-0000-0000-000000000001', 'payroll', 'view', true);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: Ustin keeps only Store, Warehouse and Expenses
DO $$
DECLARE u uuid := 'ab000000-0000-0000-0000-000000000001'; r text; m text; v jsonb;
BEGIN
  -- Two test accounts match "aniaustin" (this one and grant_warehouse_role_test's,
  -- when run together), so match this run's account exactly.
  r := public._set_only_role('aniaustin.sw', 'store_warehouse');
  PERFORM pg_temp.check(r LIKE '%now has only the Store & Warehouse role', r);
  PERFORM pg_temp.check((SELECT array_agg(role) FROM user_roles WHERE user_id = u) = ARRAY['store_warehouse'],
                        'only the Store & Warehouse role is left');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM permission_overrides WHERE user_id = u), 'extra override removed');

  -- Store, Warehouse and Expenses pages.
  FOREACH m IN ARRAY ARRAY['raw-materials','production-requests','preform-production',
                           'finished-goods','sales','sales-returns','distribution','customers',
                           'expenses'] LOOP
    PERFORM pg_temp.check(public.has_permission(u, m::module_key, 'view'::action_key), 'sees ' || m);
  END LOOP;
  PERFORM pg_temp.check(public.has_permission(u, 'raw-materials'::module_key, 'create'::action_key), 'Store: can add materials');
  PERFORM pg_temp.check(public.has_permission(u, 'goods-receiving'::module_key, 'confirm'::action_key), 'Store: confirms deliveries');
  PERFORM pg_temp.check(public.has_permission(u, 'production'::module_key, 'confirm'::action_key), 'Warehouse: accepts production releases');
  PERFORM pg_temp.check(public.has_permission(u, 'expenses'::module_key, 'submit'::action_key), 'raises expenses');

  -- Nothing else.
  PERFORM pg_temp.check(NOT public.has_permission(u, 'production'::module_key, 'view'::action_key), 'no Production page');
  PERFORM pg_temp.check(NOT public.has_permission(u, 'expenses'::module_key, 'approve'::action_key), 'cannot approve expenses');
  PERFORM pg_temp.check(NOT public.has_permission(u, 'suppliers'::module_key, 'create'::action_key), 'cannot add suppliers');
  FOREACH m IN ARRAY ARRAY['suppliers','finance','payroll','employees','marketer-accounts','distributor-accounts',
                           'costing','logistics','reports','settings','users','approvals'] LOOP
    PERFORM pg_temp.check(NOT public.has_permission(u, m::module_key, 'view'::action_key), 'no ' || m);
  END LOOP;

  -- Still sends Old / New Jugs to QC.
  PERFORM set_config('test.uid', u::text, false);
  v := public.send_jugs_to_qc(jsonb_build_object('factory_id', 'fb000000-0000-0000-0000-000000000001',
                                                 'jug_kind', 'old', 'quantity', 6));
  PERFORM set_config('test.uid', 'ab000000-0000-0000-0000-000000000002', false);
  PERFORM public.accept_qc_jugs((v->>'id')::uuid, 6);
  PERFORM pg_temp.check((SELECT status = 'accepted' FROM qc_jug_batches WHERE id = (v->>'id')::uuid), 'jugs reached QC');
END $$;

-- @@ Test 2: without the Suppliers page, the Store forms still list the suppliers
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM set_config('test.uid', 'ab000000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.suppliers WHERE id = 'bb000000-0000-0000-0000-000000000001'),
                        'Ustin can pick the supplier of a delivery');
  PERFORM pg_temp.check(pg_temp.err('UPDATE public.suppliers SET name = ''x'' WHERE id = ''bb000000-0000-0000-0000-000000000001''') IS NOT NULL
                        OR (SELECT name FROM public.suppliers WHERE id = 'bb000000-0000-0000-0000-000000000001') = 'SW Test Supplier',
                        'but cannot edit suppliers');
END $$;
RESET ROLE;
