-- ============================================================================
-- Acceptance tests: preform weight in grams (20261021090000_preform_grams.sql)
--
-- Same harness as preform_inventory_test.sql (supabase/tests/pglite/README.md).
-- Uses its own factory, users and materials; never run against production.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7000000-0000-0000-0000-000000000001', 'pgtest', 'Preform Grams Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a7000000-0000-0000-0000-000000000001', 'admin@pg'),
  ('a7000000-0000-0000-0000-000000000002', 'storekeeper@pg'),
  ('a7000000-0000-0000-0000-000000000007', 'auditor@pg');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE 'a7000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a7000000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('a7000000-0000-0000-0000-000000000002', 'store_keeper', 'f7000000-0000-0000-0000-000000000001'),
  ('a7000000-0000-0000-0000-000000000007', 'auditor', 'f7000000-0000-0000-0000-000000000001');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', 'a7000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
CREATE OR REPLACE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
GRANT ALL ON ids TO authenticated;

-- @@ Test 1: the Store sets a preform's grams once; a change needs edit rights and a reason
DO $$
DECLARE v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('2');
  v := public.save_preform_material(jsonb_build_object(
         'factory_id', 'f7000000-0000-0000-0000-000000000001', 'name', 'Grams Preform 50cl', 'pieces_per_bag', 1500));
  INSERT INTO ids VALUES ('pf50', (v->>'id')::uuid);
  PERFORM pg_temp.check((SELECT grams_per_piece IS NULL FROM raw_materials WHERE id = pg_temp.id('pf50')),
                        'no weight is assumed');

  PERFORM pg_temp.as_user('7');
  e := pg_temp.err(format($q$SELECT public.set_material_grams('%s', 18)$q$, pg_temp.id('pf50')));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'auditor cannot set grams: ' || COALESCE(e, 'no error'));

  PERFORM pg_temp.as_user('2');
  e := pg_temp.err(format($q$SELECT public.set_material_grams('%s', 0)$q$, pg_temp.id('pf50')));
  PERFORM pg_temp.check(e LIKE '%above 0%', 'zero grams refused: ' || COALESCE(e, 'no error'));
  v := public.set_material_grams(pg_temp.id('pf50'), 18.5);
  PERFORM pg_temp.check((v->>'changed')::boolean, 'first weight set');
  PERFORM pg_temp.check((SELECT grams_per_piece = 18.5 AND current_stock = 0 FROM raw_materials WHERE id = pg_temp.id('pf50')),
                        'weight stored, stock untouched');
  v := public.set_material_grams(pg_temp.id('pf50'), 18.5);
  PERFORM pg_temp.check(NOT (v->>'changed')::boolean, 'same weight is a no-op');

  PERFORM pg_temp.as_user('1');
  e := pg_temp.err(format($q$SELECT public.set_material_grams('%s', 19)$q$, pg_temp.id('pf50')));
  PERFORM pg_temp.check(e LIKE '%reason%', 'change without a reason refused: ' || COALESCE(e, 'no error'));
  v := public.set_material_grams(pg_temp.id('pf50'), 19, 'Supplier changed the mould');
  PERFORM pg_temp.check((SELECT grams_per_piece = 19 FROM raw_materials WHERE id = pg_temp.id('pf50')), 'weight changed');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'set_material_grams'
                                   AND entity_id = pg_temp.id('pf50')::text
                                   AND old_value->>'grams_per_piece' = '18.50'
                                   AND new_value->>'reason' = 'Supplier changed the mould'), 'change audited');
END $$;

-- @@ Test 2: grams per supplier -- set after picking the supplier, linked if needed, first one becomes the default
DO $$
DECLARE v jsonb; e text;
BEGIN
  INSERT INTO suppliers(id, factory_id, name) VALUES
    ('b7000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000001', 'Grams Supplier A'),
    ('b7000000-0000-0000-0000-000000000002', 'f7000000-0000-0000-0000-000000000001', 'Grams Supplier B');
  PERFORM pg_temp.as_user('2');
  v := public.save_preform_material(jsonb_build_object(
         'factory_id', 'f7000000-0000-0000-0000-000000000001', 'name', 'Grams Preform 1.5L'));
  INSERT INTO ids VALUES ('pf15', (v->>'id')::uuid);

  PERFORM pg_temp.as_user('7');
  e := pg_temp.err(format($q$SELECT public.set_preform_supplier_grams('%s', 'b7000000-0000-0000-0000-000000000001', 32)$q$, pg_temp.id('pf15')));
  PERFORM pg_temp.check(e LIKE '%Insufficient permissions%', 'auditor cannot set supplier grams: ' || COALESCE(e, 'no error'));

  PERFORM pg_temp.as_user('2');
  v := public.set_preform_supplier_grams(pg_temp.id('pf15'), 'b7000000-0000-0000-0000-000000000001', 32);
  PERFORM pg_temp.check((SELECT grams_per_piece = 32 FROM material_suppliers
                          WHERE material_id = pg_temp.id('pf15') AND supplier_id = 'b7000000-0000-0000-0000-000000000001'),
                        'supplier linked with its grams');
  PERFORM pg_temp.check((SELECT grams_per_piece = 32 FROM raw_materials WHERE id = pg_temp.id('pf15')),
                        'first weight becomes the preform default');
  v := public.set_preform_supplier_grams(pg_temp.id('pf15'), 'b7000000-0000-0000-0000-000000000002', 30);
  PERFORM pg_temp.check((SELECT grams_per_piece = 32 FROM raw_materials WHERE id = pg_temp.id('pf15')),
                        'a second supplier does not change the default');
  PERFORM pg_temp.as_user('1');
  e := pg_temp.err(format($q$SELECT public.set_preform_supplier_grams('%s', 'b7000000-0000-0000-0000-000000000002', 31)$q$, pg_temp.id('pf15')));
  PERFORM pg_temp.check(e LIKE '%reason%', 'change needs a reason: ' || COALESCE(e, 'no error'));
  v := public.set_preform_supplier_grams(pg_temp.id('pf15'), 'b7000000-0000-0000-0000-000000000002', 31, 'New mould');
  PERFORM pg_temp.check((SELECT grams_per_piece = 31 FROM material_suppliers
                          WHERE material_id = pg_temp.id('pf15') AND supplier_id = 'b7000000-0000-0000-0000-000000000002'),
                        'supplier grams changed');
END $$;
