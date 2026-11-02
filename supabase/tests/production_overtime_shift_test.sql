-- ============================================================================
-- Acceptance tests: production_overtime_shift (20261102190000)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A Sunday batch is saved as Over-Time; an
-- unknown shift is refused.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('a0e00000-0000-0000-0000-000000000001', 'admin@ot');
INSERT INTO user_roles(user_id, role, factory_id) VALUES ('a0e00000-0000-0000-0000-000000000001', 'super_admin', NULL)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: Over-Time is a shift; anything else is not
DO $$
DECLARE r jsonb; f uuid := (SELECT id FROM factories WHERE code = 'water');
  p uuid := (SELECT id FROM products WHERE factory_id = (SELECT id FROM factories WHERE code = 'water')
              AND product_type = 'finished' AND active ORDER BY name LIMIT 1);
BEGIN
  PERFORM set_config('test.uid', 'a0e00000-0000-0000-0000-000000000001', false);
  r := public.create_production(jsonb_build_object('factory_id', f, 'product_id', p, 'quantity_produced', 10,
         'production_date', '2026-11-01', 'shift', 'overtime', 'batch_number', 'OT-TEST'));
  PERFORM pg_temp.check((SELECT shift FROM production WHERE id = (r->>'id')::uuid) = 'overtime', 'saved as overtime');
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.create_production(jsonb_build_object('factory_id', '%s',
           'product_id', '%s', 'quantity_produced', 1, 'shift', 'sunday'))$q$, f, p)) LIKE '%production_shift_check%',
         'unknown shift refused');
END $$;
