-- ============================================================================
-- Acceptance test: Quality Control → Preforms, end to end
--
-- The Store issues preforms to the QC officer (issue_preforms, as Store →
-- Issue Stock does for a preform to a QC person); she accepts them; she
-- enters the day's Blown and Damages (save_preform_shift + submit, as the
-- Preforms tab's pencil does). Only the good bottles (blown - damages) are
-- stocked; the day's row shows From Store, Opening, Blown, Damages, Balance.
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('6f000000-0000-0000-0000-000000000001', 'qcpf', 'QC Preforms Factory');
INSERT INTO auth.users(id, email) VALUES
  ('6a000000-0000-0000-0000-000000000001', 'store@qcpf'),
  ('6a000000-0000-0000-0000-000000000002', 'qc@qcpf');
INSERT INTO profiles(id, email, full_name)
SELECT u.id, u.email, split_part(u.email, '@', 1) FROM auth.users u
 WHERE u.id::text LIKE '6a000000-%' AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id);
DELETE FROM user_roles WHERE user_id::text LIKE '6a000000-%';
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('6a000000-0000-0000-0000-000000000001', 'store_keeper', '6f000000-0000-0000-0000-000000000001'),
  ('6a000000-0000-0000-0000-000000000002', 'qc_officer', '6f000000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('6d000000-0000-0000-0000-000000000001', '6f000000-0000-0000-0000-000000000001', '50cl bottles', 'Piece', 0, 0, 'finished');
INSERT INTO raw_materials(id, factory_id, name, unit, current_stock, current_value, unit_cost, pieces_per_bag, is_preform, output_product_id) VALUES
  ('6c000000-0000-0000-0000-000000000001', '6f000000-0000-0000-0000-000000000001', 'Preform 29mm', 'Piece',
   1152 * 10, 1152 * 10, 1, 1152, true, '6d000000-0000-0000-0000-000000000001');

CREATE OR REPLACE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('test.uid', '6a000000-0000-0000-0000-' || lpad(p, 12, '0'), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: Store issues to QC -> QC accepts -> enters blown and damages -> only good bottles stocked
DO $$
DECLARE v jsonb; iss uuid; r record; s jsonb;
  f uuid := '6f000000-0000-0000-0000-000000000001';
  m uuid := '6c000000-0000-0000-0000-000000000001';
  qc uuid := '6a000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM pg_temp.as_user('1');
  v := public.issue_preforms(jsonb_build_object('material_id', m, 'operator_id', qc, 'bags', 2, 'loose_pieces', 0));
  iss := (v->>'id')::uuid;
  PERFORM pg_temp.check((SELECT current_stock FROM raw_materials WHERE id = m) = 1152 * 8, 'left the Store');

  -- Not hers until she accepts.
  PERFORM pg_temp.as_user('2');
  SELECT * INTO r FROM public.preform_daily_report(f, public._pf_today(), public._pf_today(), qc, m);
  PERFORM pg_temp.check(r.received IS NULL OR r.received = 0, 'not received before accepting');
  PERFORM public.respond_preform_issue(iss, true);
  SELECT * INTO r FROM public.preform_daily_report(f, public._pf_today(), public._pf_today(), qc, m);
  PERFORM pg_temp.check(r.received = 2304 AND r.closing = 2304 AND r.shifts = 0, 'From Store 2 bags, nothing blown yet: ' || row_to_json(r)::text);

  -- She enters the day's blowing: 2,000 blown, 50 damaged.
  v := public.save_preform_shift(jsonb_build_object('operator_id', qc, 'material_id', m, 'production_date', public._pf_today(),
         'shift', 'day', 'good_bottles', 1950, 'damaged_bottles', 50));
  s := public.submit_preform_shift((v->>'id')::uuid);
  PERFORM pg_temp.check(s->>'status' = 'completed', 'straight into stock: ' || s::text);
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = '6d000000-0000-0000-0000-000000000001') = 1950,
                        'only the good bottles stocked');
  SELECT * INTO r FROM public.preform_daily_report(f, public._pf_today(), public._pf_today(), qc, m);
  PERFORM pg_temp.check(r.usage = 2000 AND r.damaged_bottles = 50 AND r.closing = 304 AND r.shifts = 1,
                        'Blown 2000, Damages 50, Balance 304: ' || row_to_json(r)::text);
END $$;
