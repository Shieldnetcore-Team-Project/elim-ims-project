-- ============================================================================
-- Acceptance tests: the Store receives new jugs and sends jugs to QC
-- (20261101090000_store_receives_sends_jugs.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A Store user (raw-materials view/create
-- only) receives 50 New Jugs, sends 30 to QC, cancels a second send, and
-- can read the jug records; a user with no Store rights is refused.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('a3700000-0000-0000-0000-000000000001', 'store@jugs'),
  ('a3700000-0000-0000-0000-000000000002', 'nobody@jugs');
INSERT INTO roles(slug, label, is_system) VALUES
  ('sj_store_test', 'Store (test)', false), ('sj_nobody_test', 'Nobody (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action) VALUES
  ('sj_store_test', 'raw-materials', 'view'), ('sj_store_test', 'raw-materials', 'create'),
  ('sj_nobody_test', 'dashboard', 'view') ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id IN ('a3700000-0000-0000-0000-000000000001', 'a3700000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT v.u::uuid, v.r, f.id FROM factories f,
  (VALUES ('a3700000-0000-0000-0000-000000000001', 'sj_store_test'),
          ('a3700000-0000-0000-0000-000000000002', 'sj_nobody_test')) v(u, r)
 WHERE f.code = 'water';
INSERT INTO container_types(id, factory_id, name)
SELECT 'e3700000-0000-0000-0000-000000000001', id, 'SJ New Jug' FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.check(boolean, text) TO authenticated;

-- @@ Test 1: the Store receives 50, sends 30 to QC, cancels a second send
DO $$
DECLARE v jsonb; w jsonb;
  f uuid := (SELECT id FROM factories WHERE code = 'water');
BEGIN
  PERFORM set_config('test.uid', 'a3700000-0000-0000-0000-000000000001', false);
  PERFORM public.receive_new_jugs(f, 'e3700000-0000-0000-0000-000000000001', 50, 'DN-77', 'test supplier');
  PERFORM pg_temp.check((SELECT sum(quantity) FROM container_movements
                          WHERE container_type_id = 'e3700000-0000-0000-0000-000000000001' AND source = 'purchase') = 50,
                        '50 received');
  v := public.send_jugs_to_qc(jsonb_build_object('factory_id', f, 'jug_kind', 'new', 'quantity', 30));
  w := public.send_jugs_to_qc(jsonb_build_object('factory_id', f, 'jug_kind', 'old', 'quantity', 5));
  PERFORM public.cancel_jugs_to_qc((w->>'id')::uuid, 'sent by mistake');
  PERFORM pg_temp.check((SELECT status FROM qc_jug_batches WHERE id = (v->>'id')::uuid) = 'sent', 'sent to QC');
  PERFORM pg_temp.check((SELECT status FROM qc_jug_batches WHERE id = (w->>'id')::uuid) = 'cancelled', 'cancelled');
END $$;

-- @@ Test 2: the Store reads its jug records under row-level security
SELECT set_config('test.uid', 'a3700000-0000-0000-0000-000000000001', false);
SET ROLE authenticated;
SELECT pg_temp.check((SELECT count(*) FROM container_types WHERE id = 'e3700000-0000-0000-0000-000000000001') = 1, 'types');
SELECT pg_temp.check((SELECT count(*) FROM container_movements
                       WHERE container_type_id = 'e3700000-0000-0000-0000-000000000001') = 1, 'receipt row');
SELECT pg_temp.check((SELECT count(*) FROM qc_jug_batches WHERE quantity_sent IN (30, 5)) >= 2, 'consignments');
RESET ROLE;

-- @@ Test 3: no Store rights -> refused
DO $$
DECLARE ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'a3700000-0000-0000-0000-000000000002', false);
  BEGIN
    PERFORM public.send_jugs_to_qc(jsonb_build_object('factory_id', (SELECT id FROM factories WHERE code = 'water'),
                                                      'jug_kind', 'new', 'quantity', 1));
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM pg_temp.check(ok, 'refused');
END $$;
