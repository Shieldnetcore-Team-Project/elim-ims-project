-- ============================================================================
-- Acceptance tests: blown bottles from QC in Process Material
-- (20261029110000_process_material_blown_bottles.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A production user (role 'production')
-- records the blown bottles QC sent her.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('be000000-0000-0000-0000-000000000009', 'boss@pmbottle'),
  ('be000000-0000-0000-0000-000000000001', 'pm@pmbottle');
DELETE FROM user_roles WHERE user_id IN ('be000000-0000-0000-0000-000000000009', 'be000000-0000-0000-0000-000000000001');
INSERT INTO user_roles(user_id, role) VALUES ('be000000-0000-0000-0000-000000000009', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'be000000-0000-0000-0000-000000000001', 'production', id FROM factories WHERE code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active)
SELECT 'bf000000-0000-0000-0000-000000000001', id, 'PMB 50cl Bottle', 'Piece', 'semi_finished', true
  FROM factories WHERE code = 'water';
INSERT INTO products(id, factory_id, name, unit, product_type, active)
SELECT 'bf000000-0000-0000-0000-000000000002', id, 'PMB 50cl Bottle Water', 'Pack', 'finished', true
  FROM factories WHERE code = 'water';
-- QC sent 1,000 + 500 bottles; PM received 1,000 and 480 (a discrepancy); a
-- test-data transfer and one still on its way don't count.
INSERT INTO bottle_transfers(factory_id, reference, product_id, to_department, quantity_sent, quantity_received, status,
                             received_at, test_cleared)
SELECT f.id, v.ref, 'bf000000-0000-0000-0000-000000000001', 'PM', v.sent, v.rec, v.st, v.at::timestamptz, v.tc
  FROM factories f,
  (VALUES ('PMB-1', 1000, 1000, 'received', now() - interval '2 hours', false),
          ('PMB-2', 500, 480, 'discrepancy', now() - interval '1 hour', false),
          ('PMB-3', 900, 900, 'received', now() - interval '1 hour', true),
          ('PMB-4', 300, NULL, 'dispatched', NULL, false)) v(ref, sent, rec, st, at, tc)
 WHERE f.code = 'water';
SELECT set_config('test.uid', 'be000000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: the blown bottle is in the dropdown with what PM received; finished Bottle Water is not
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); o record;
BEGIN
  SELECT * INTO o FROM public.production_material_options(f) WHERE material_id = 'bf000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(o.kind = 'bottle' AND o.received_since = 1480 AND o.last_balance = 0 AND o.unit = 'Piece',
                        'bottle option: ' || row_to_json(o)::text);
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.production_material_options(f)
                                     WHERE material_id = 'bf000000-0000-0000-0000-000000000002'), 'finished not listed');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.production_material_options(f) WHERE kind IS NULL), 'kinds set');
END $$;

-- @@ Test 2: saving a bottle line; the next entry opens on its balance with nothing new received
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r record; o record; e text;
BEGIN
  PERFORM public.save_production_material_report(jsonb_build_object('factory_id', f, 'lines', jsonb_build_array(
    jsonb_build_object('product_id', 'bf000000-0000-0000-0000-000000000001', 'opening', 0, 'qty_in', 1480,
                       'qty_used', 1200, 'damages', 30))));
  SELECT * INTO r FROM production_material_reports WHERE product_id = 'bf000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(r.material_id IS NULL AND r.material_name = 'PMB 50cl Bottle' AND r.unit = 'Piece'
                        AND r.balance = 250, 'line saved: ' || row_to_json(r)::text);
  SELECT * INTO o FROM public.production_material_options(f) WHERE material_id = 'bf000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.check(o.last_balance = 250 AND o.received_since = 0, 'carried: ' || row_to_json(o)::text);

  -- A finished product is not a process material.
  BEGIN
    PERFORM public.save_production_material_report(jsonb_build_object('factory_id', f, 'lines', jsonb_build_array(
      jsonb_build_object('product_id', 'bf000000-0000-0000-0000-000000000002', 'qty_in', 5))));
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  PERFORM pg_temp.check(e LIKE '%blown bottle%', 'finished refused: ' || COALESCE(e, 'none'));
END $$;
