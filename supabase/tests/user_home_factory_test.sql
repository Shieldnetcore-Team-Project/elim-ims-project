-- ============================================================================
-- Acceptance tests: every account belongs to Kubwa or Lugbe
-- (20261123100000_user_home_factory.sql). See supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('4a000000-0000-0000-0000-000000000001', 'admin@home'),
  ('4a000000-0000-0000-0000-000000000002', 'kubwa@home'),
  ('4a000000-0000-0000-0000-000000000003', 'lugbe@home');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '4a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
UPDATE profiles SET status = 'pending' WHERE id = '4a000000-0000-0000-0000-000000000003';
UPDATE profiles SET status = 'active', active_factory_id = (SELECT id FROM factories WHERE code = 'water')
 WHERE id = '4a000000-0000-0000-0000-000000000002';
DELETE FROM user_roles WHERE user_id::text LIKE '4a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('4a000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('4a000000-0000-0000-0000-000000000002', 'store_keeper', (SELECT id FROM factories WHERE code = 'water'));

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: an account created under Lugbe opens Lugbe only and works there
DO $$
DECLARE k uuid := (SELECT id FROM factories WHERE code = 'water');
        l uuid := (SELECT id FROM factories WHERE code = 'lugbe');
        u uuid := '4a000000-0000-0000-0000-000000000003';
BEGIN
  PERFORM set_config('test.uid', '4a000000-0000-0000-0000-000000000001', false);
  PERFORM public.admin_provision_user(u, 'store_keeper', 'Store', l, 'WATER');
  PERFORM pg_temp.check((SELECT active_factory_id = l AND status = 'active' FROM profiles WHERE id = u), 'home = Lugbe');
  PERFORM pg_temp.check((SELECT factory_id = l FROM user_roles WHERE user_id = u), 'role in Lugbe');

  PERFORM set_config('test.uid', u::text, false);
  PERFORM pg_temp.check((SELECT array_agg(code) FROM public.my_factories()) = ARRAY['lugbe'], 'Lugbe user sees Lugbe only');
  PERFORM pg_temp.check(public._works_in_factory(u, l) AND NOT public._works_in_factory(u, k), 'works in Lugbe, not Kubwa');

  -- Kubwa account: Kubwa only; allowed Lugbe -> both, Kubwa first, may post in Lugbe.
  PERFORM set_config('test.uid', '4a000000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check((SELECT array_agg(code) FROM public.my_factories()) = ARRAY['water'], 'Kubwa user sees Kubwa only');
  INSERT INTO factory_access(user_id, factory_id) VALUES ('4a000000-0000-0000-0000-000000000002', l);
  PERFORM pg_temp.check((SELECT array_agg(code) FROM public.my_factories()) = ARRAY['water','lugbe'], 'allowed: Kubwa then Lugbe');
  PERFORM pg_temp.check(public._works_in_factory('4a000000-0000-0000-0000-000000000002', l), 'allowed user works in Lugbe');
END $$;

-- @@ Test 2: Admin moves an account to Kubwa; only an Admin may
DO $$
DECLARE k uuid := (SELECT id FROM factories WHERE code = 'water');
        u uuid := '4a000000-0000-0000-0000-000000000003';
        e text;
BEGIN
  PERFORM set_config('test.uid', u::text, false);
  e := pg_temp.err(format('SELECT public.set_user_factory(%L, %L)', u, k));
  PERFORM pg_temp.check(e LIKE '%Chairman or Admin%', 'non-admin refused: ' || COALESCE(e, 'none'));

  PERFORM set_config('test.uid', '4a000000-0000-0000-0000-000000000001', false);
  PERFORM public.set_user_factory(u, k);
  PERFORM pg_temp.check((SELECT active_factory_id = k FROM profiles WHERE id = u), 'home = Kubwa');
  PERFORM pg_temp.check((SELECT bool_and(factory_id = k) FROM user_roles WHERE user_id = u), 'role moved');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'set_user_factory' AND entity_id = u::text), 'audited');
  PERFORM set_config('test.uid', u::text, false);
  PERFORM pg_temp.check((SELECT array_agg(code) FROM public.my_factories()) = ARRAY['water'], 'now Kubwa only');
END $$;
