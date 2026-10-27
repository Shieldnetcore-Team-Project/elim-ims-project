-- ============================================================================
-- Acceptance tests: receiving new jugs into the Warehouse
-- (20261027130000_receive_new_jugs.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Each block between "-- @@" markers is one
-- test. Uses the Water Factory's New Jug type.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('8b000000-0000-0000-0000-000000000001', 'warehouse@newjugs'),
  ('8b000000-0000-0000-0000-000000000002', 'nobody@newjugs');
INSERT INTO profiles(id, email, full_name)
SELECT v.id, v.email, v.name FROM (VALUES
  ('8b000000-0000-0000-0000-000000000001'::uuid, 'warehouse@newjugs', 'Warehouse'),
  ('8b000000-0000-0000-0000-000000000002'::uuid, 'nobody@newjugs', 'Nobody')) v(id, email, name)
 WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v.id);
DELETE FROM user_roles WHERE user_id IN ('8b000000-0000-0000-0000-000000000001', '8b000000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT '8b000000-0000-0000-0000-000000000001', 'store_warehouse', f.id FROM factories f WHERE f.code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.jug(p_name text) RETURNS uuid LANGUAGE sql AS $$
  SELECT c.id FROM container_types c JOIN factories f ON f.id = c.factory_id
   WHERE f.code = 'water' AND c.name = p_name $$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: the Warehouse receives 50 New Jugs -- a "Bought in" move into the Warehouse
DO $$
DECLARE f uuid; v uuid; m container_movements%ROWTYPE;
BEGIN
  SELECT id INTO f FROM factories WHERE code = 'water';
  PERFORM set_config('test.uid', '8b000000-0000-0000-0000-000000000001', false);
  v := public.receive_new_jugs(f, pg_temp.jug('New Jug'), 50, '  DN-0457 ', 'From supplier');
  SELECT * INTO m FROM container_movements WHERE id = v;
  PERFORM pg_temp.check(m.source = 'purchase' AND m.from_type = 'external' AND m.to_type = 'warehouse'
                        AND m.quantity = 50 AND m.reference = 'DN-0457' AND m.notes = 'From supplier'
                        AND m.created_by = '8b000000-0000-0000-0000-000000000001', 'movement written');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'receive_new_jugs' AND entity_id = v::text), 'audited');
END $$;

-- @@ Test 2: refused without rights, for bad quantities, without a reference, or another factory's type
DO $$
DECLARE f uuid; e text; other uuid;
BEGIN
  SELECT id INTO f FROM factories WHERE code = 'water';
  PERFORM set_config('test.uid', '8b000000-0000-0000-0000-000000000002', false);
  e := pg_temp.err(format('SELECT public.receive_new_jugs(%L, %L, 5, %L)', f, pg_temp.jug('New Jug'), 'DN-1'));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'no rights: ' || COALESCE(e, 'none'));

  PERFORM set_config('test.uid', '8b000000-0000-0000-0000-000000000001', false);
  e := pg_temp.err(format('SELECT public.receive_new_jugs(%L, %L, 0, %L)', f, pg_temp.jug('New Jug'), 'DN-1'));
  PERFORM pg_temp.check(e LIKE '%whole number%', 'zero: ' || COALESCE(e, 'none'));
  e := pg_temp.err(format('SELECT public.receive_new_jugs(%L, %L, 2.5, %L)', f, pg_temp.jug('New Jug'), 'DN-1'));
  PERFORM pg_temp.check(e LIKE '%whole number%', 'fraction: ' || COALESCE(e, 'none'));
  e := pg_temp.err(format('SELECT public.receive_new_jugs(%L, %L, 5, %L)', f, pg_temp.jug('New Jug'), ' '));
  PERFORM pg_temp.check(e LIKE '%delivery note%', 'no reference: ' || COALESCE(e, 'none'));

  SELECT c.id INTO other FROM container_types c WHERE c.factory_id <> f LIMIT 1;
  IF other IS NOT NULL THEN
    e := pg_temp.err(format('SELECT public.receive_new_jugs(%L, %L, 5, %L)', f, other, 'DN-1'));
    PERFORM pg_temp.check(e LIKE '%not found%', 'other factory type: ' || COALESCE(e, 'none'));
  END IF;
END $$;
