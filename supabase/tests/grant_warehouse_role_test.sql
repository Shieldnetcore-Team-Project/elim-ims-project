-- ============================================================================
-- Acceptance tests: Warehouse role for aniaustin (20261021120000_grant_warehouse_aniaustin.sql)
--
-- Same harness as preform_inventory_test.sql (supabase/tests/pglite/README.md).
-- Uses its own factory and users; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('fa000000-0000-0000-0000-000000000001', 'gwtest', 'Grant Warehouse Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('aa000000-0000-0000-0000-000000000001', 'aniaustin.test@example.com'),
  ('aa000000-0000-0000-0000-000000000002', 'qc.gw@test');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'aa000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('aa000000-0000-0000-0000-000000000001', 'sales', 'fa000000-0000-0000-0000-000000000001'),
  ('aa000000-0000-0000-0000-000000000002', 'qc_officer', 'fa000000-0000-0000-0000-000000000001');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: aniaustin gets every Warehouse page and can send jugs to QC; existing roles are kept
DO $$
DECLARE u uuid := 'aa000000-0000-0000-0000-000000000001'; r text; m text; v jsonb;
BEGIN
  r := public._grant_role_to_match('aniaustin', 'store_officer');
  PERFORM pg_temp.check(r LIKE '%now has the Warehouse role', r);
  PERFORM pg_temp.check((SELECT array_agg(role ORDER BY role) FROM user_roles WHERE user_id = u) = ARRAY['sales', 'store_officer'],
                        'Warehouse role added, Sales role kept');
  r := public._grant_role_to_match('aniaustin', 'store_officer');
  PERFORM pg_temp.check(r LIKE '%already has%', 'running again changes nothing: ' || r);

  FOREACH m IN ARRAY ARRAY['finished-goods','production-requests','preform-production','sales','sales-returns','distribution','customers'] LOOP
    PERFORM pg_temp.check(public.has_permission(u, m::module_key, 'view'::action_key), 'sees Warehouse tab for ' || m);
  END LOOP;

  -- Sends jugs to QC; QC accepts them (the next step towards the PM).
  PERFORM set_config('test.uid', u::text, false);
  v := public.send_jugs_to_qc(jsonb_build_object('factory_id', 'fa000000-0000-0000-0000-000000000001',
                                                 'jug_kind', 'new', 'quantity', 12));
  PERFORM set_config('test.uid', 'aa000000-0000-0000-0000-000000000002', false);
  PERFORM public.accept_qc_jugs((v->>'id')::uuid, 12);
  PERFORM pg_temp.check((SELECT status = 'accepted' FROM qc_jug_batches WHERE id = (v->>'id')::uuid),
                        'jugs sent by aniaustin reached QC');
END $$;
