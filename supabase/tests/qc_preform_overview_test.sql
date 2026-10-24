-- ============================================================================
-- Acceptance test: Quality Control → Preforms overview (qc_preform_overview)
--
-- One line per preform from the Store to the good bottles: a preform never
-- issued still shows; an issue waiting for QC counts as issued and waiting;
-- once accepted and blown, Blown / Damages / Good and what QC still holds
-- follow.
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('7f000000-0000-0000-0000-000000000001', 'qcov', 'QC Overview Factory');
INSERT INTO auth.users(id, email) VALUES
  ('7a000000-0000-0000-0000-000000000001', 'store@qcov'),
  ('7a000000-0000-0000-0000-000000000002', 'qc@qcov');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '7a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '7a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('7a000000-0000-0000-0000-000000000001', 'store_keeper', '7f000000-0000-0000-0000-000000000001'),
  ('7a000000-0000-0000-0000-000000000002', 'qc_officer', '7f000000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('7d000000-0000-0000-0000-000000000001', '7f000000-0000-0000-0000-000000000001', '50cl bottles', 'Piece', 0, 0, 'finished');
INSERT INTO suppliers(id, factory_id, name) VALUES
  ('7e000000-0000-0000-0000-000000000001', '7f000000-0000-0000-0000-000000000001', 'Prima Plastics');
INSERT INTO brands(id, factory_id, name, category, grammage, supplier_id) VALUES
  ('7b000000-0000-0000-0000-000000000001', '7f000000-0000-0000-0000-000000000001', 'Prima', 'Bag', '16.5g',
   '7e000000-0000-0000-0000-000000000001');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform, output_product_id, brand_id) VALUES
  ('7c000000-0000-0000-0000-000000000001', '7f000000-0000-0000-0000-000000000001', 'Preform 29mm', 'Piece',
   1152 * 10, 1152 * 10, 1, 1152, true, '7d000000-0000-0000-0000-000000000001', '7b000000-0000-0000-0000-000000000001'),
  ('7c000000-0000-0000-0000-000000000002', '7f000000-0000-0000-0000-000000000001', 'Preform 29mm 14g', 'Piece',
   0, 0, 1, 1428, true, NULL, NULL);

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '7a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: issued -> waiting -> accepted -> blown, damages, good, held
DO $$
DECLARE v jsonb; iss uuid; r record;
  f uuid := '7f000000-0000-0000-0000-000000000001';
  m uuid := '7c000000-0000-0000-0000-000000000001';
  qc uuid := '7a000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM pg_temp.as_user('2');
  PERFORM pg_temp.check((SELECT COUNT(*) FROM public.qc_preform_overview(f)) = 2, 'every preform shows, issued or not');
  SELECT * INTO r FROM public.qc_preform_overview(f) WHERE material_id = m;
  PERFORM pg_temp.check(r.brand = 'Prima' AND r.grammage = '16.5g' AND r.supplier = 'Prima Plastics'
    AND r.pieces_per_bag = 1152 AND r.in_store = 11520 AND r.issued = 0, 'details before any issue: ' || row_to_json(r)::text);

  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', m, 'operator_id', qc, 'bags', 2, 'loose_pieces', 0));
  iss := (v->>'id')::uuid;
  PERFORM pg_temp.as_user('2');
  SELECT * INTO r FROM public.qc_preform_overview(f) WHERE material_id = m;
  PERFORM pg_temp.check(r.issued = 2304 AND r.waiting = 2304 AND r.received = 0 AND r.in_store = 1152 * 8
    AND r.last_issue IS NOT NULL, 'waiting for QC: ' || row_to_json(r)::text);

  PERFORM public.respond_preform_issue(iss, true);
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m, 'production_date', public._pf_today(),
         'shift', 'day', 'good_bottles', 1950, 'damaged_bottles', 50));
  PERFORM public.set_shift_bottle_by_name((v->>'id')::uuid, '50cl bottles');
  PERFORM public.submit_preform_shift((v->>'id')::uuid);
  SELECT * INTO r FROM public.qc_preform_overview(f) WHERE material_id = m;
  PERFORM pg_temp.check(r.waiting = 0 AND r.received = 2304 AND r.blown = 2000 AND r.damages = 50
    AND r.good = 1950 AND r.qc_holds = 304, 'after blowing: ' || row_to_json(r)::text);
END $$;
