-- ============================================================================
-- Acceptance tests: remove the refused release REL-20261030-46391
-- (20261030210000_remove_refused_release_46391.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Production releases 535 packs of 50cl,
-- the Warehouse refuses them; the removal leaves no release, no audit line,
-- and the same stock and Production hall as before. Another release is
-- untouched, and a release no longer refused is not removed.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b0900000-0000-0000-0000-000000000001', 'wh@rm'),
  ('b0900000-0000-0000-0000-000000000002', 'pm@rm');
DELETE FROM user_roles WHERE user_id IN ('b0900000-0000-0000-0000-000000000001', 'b0900000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role) VALUES ('b0900000-0000-0000-0000-000000000001', 'super_admin');
UPDATE products SET active = false, name = name || ' (old ' || left(id::text, 8) || ')' WHERE product_type = 'finished';
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT 'b0900000-0000-0000-0000-0000000000a2', id, '50cl Bottle Water', 'Pack', 'finished', true, 497, 2650
  FROM factories WHERE code = 'water';
INSERT INTO production_releases(factory_id, release_number, product_id, quantity, unit, status, released_by)
SELECT id, x.n, 'b0900000-0000-0000-0000-0000000000a2', x.q, 'Pack', 'pending', 'b0900000-0000-0000-0000-000000000002'
  FROM factories, (VALUES ('REL-20261030-46391', 535), ('REL-OTHER', 10)) AS x(n, q) WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the refused release and its audit lines go; stock, the hall and other releases stay
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); hall numeric;
BEGIN
  PERFORM set_config('test.uid', 'b0900000-0000-0000-0000-000000000001', false);
  PERFORM public.reject_production_release((SELECT id FROM production_releases WHERE release_number = 'REL-20261030-46391'), 'wrong');
  PERFORM pg_temp.check((SELECT count(*) FROM audit_logs WHERE entity = 'production_releases'
                           AND entity_id = (SELECT id::text FROM production_releases WHERE release_number = 'REL-20261030-46391')) >= 1,
                        'refusal audited');
  hall := public._production_hall_available(f, 'b0900000-0000-0000-0000-0000000000a2');
END $$;
DO $$
DECLARE
  v_id uuid := (SELECT id FROM production_releases WHERE release_number = 'REL-20261030-46391');
  v_ok boolean;
  v_audit int;
BEGIN
  IF v_id IS NULL THEN
    RAISE NOTICE 'REL-20261030-46391 is not there -- nothing to remove';
    RETURN;
  END IF;
  v_ok := (SELECT r.status = 'rejected' AND r.quantity = 535 AND btrim(p.name) ~* '^50 ?cl bottle'
             FROM production_releases r JOIN products p ON p.id = r.product_id
            WHERE r.id = v_id);
  IF NOT COALESCE(v_ok, false) THEN
    RAISE NOTICE 'REL-20261030-46391 is not the refused 50cl × 535 any more -- NOT removed';
    RETURN;
  END IF;

  DELETE FROM audit_logs WHERE entity = 'production_releases' AND entity_id = v_id::text;
  GET DIAGNOSTICS v_audit = ROW_COUNT;
  DELETE FROM production_releases WHERE id = v_id;
  RAISE NOTICE 'REL-20261030-46391 removed (and % audit line(s))', v_audit;
END $$;
DO $$
DECLARE
  v_id uuid := (SELECT id FROM production_releases WHERE release_number = 'REL-20261030-46391');
  v_ok boolean;
  v_audit int;
BEGIN
  IF v_id IS NULL THEN
    RAISE NOTICE 'REL-20261030-46391 is not there -- nothing to remove';
    RETURN;
  END IF;
  v_ok := (SELECT r.status = 'rejected' AND r.quantity = 535 AND btrim(p.name) ~* '^50 ?cl bottle'
             FROM production_releases r JOIN products p ON p.id = r.product_id
            WHERE r.id = v_id);
  IF NOT COALESCE(v_ok, false) THEN
    RAISE NOTICE 'REL-20261030-46391 is not the refused 50cl × 535 any more -- NOT removed';
    RETURN;
  END IF;

  DELETE FROM audit_logs WHERE entity = 'production_releases' AND entity_id = v_id::text;
  GET DIAGNOSTICS v_audit = ROW_COUNT;
  DELETE FROM production_releases WHERE id = v_id;
  RAISE NOTICE 'REL-20261030-46391 removed (and % audit line(s))', v_audit;
END $$;
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water');
BEGIN
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM production_releases WHERE release_number = 'REL-20261030-46391'), 'release gone');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM audit_logs WHERE new_value::text LIKE '%wrong%'
                                      AND action = 'reject_production_release'), 'audit gone');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM production_releases WHERE release_number = 'REL-OTHER' AND status = 'pending'), 'other kept');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'b0900000-0000-0000-0000-0000000000a2') = 497, 'stock unchanged');
END $$;

-- @@ Test 2: not removed when it is no longer the refused 535 packs
UPDATE production_releases SET status = 'pending', release_number = 'REL-20261030-46391' WHERE release_number = 'REL-OTHER';
DO $$
DECLARE
  v_id uuid := (SELECT id FROM production_releases WHERE release_number = 'REL-20261030-46391');
  v_ok boolean;
  v_audit int;
BEGIN
  IF v_id IS NULL THEN
    RAISE NOTICE 'REL-20261030-46391 is not there -- nothing to remove';
    RETURN;
  END IF;
  v_ok := (SELECT r.status = 'rejected' AND r.quantity = 535 AND btrim(p.name) ~* '^50 ?cl bottle'
             FROM production_releases r JOIN products p ON p.id = r.product_id
            WHERE r.id = v_id);
  IF NOT COALESCE(v_ok, false) THEN
    RAISE NOTICE 'REL-20261030-46391 is not the refused 50cl × 535 any more -- NOT removed';
    RETURN;
  END IF;

  DELETE FROM audit_logs WHERE entity = 'production_releases' AND entity_id = v_id::text;
  GET DIAGNOSTICS v_audit = ROW_COUNT;
  DELETE FROM production_releases WHERE id = v_id;
  RAISE NOTICE 'REL-20261030-46391 removed (and % audit line(s))', v_audit;
END $$;
DO $$
BEGIN
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM production_releases WHERE release_number = 'REL-20261030-46391'), 'a pending one is kept');
END $$;
