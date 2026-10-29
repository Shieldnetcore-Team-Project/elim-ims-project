-- ============================================================================
-- Acceptance tests: monthly_party_sheet (20261029210000_monthly_party_sheet.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('ce000000-0000-0000-0000-000000000009', 'boss@mps'),
  ('ce000000-0000-0000-0000-000000000001', 'store@mps');
DELETE FROM user_roles WHERE user_id IN ('ce000000-0000-0000-0000-000000000009', 'ce000000-0000-0000-0000-000000000001');
INSERT INTO user_roles(user_id, role) VALUES ('ce000000-0000-0000-0000-000000000009', 'super_admin');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'ce000000-0000-0000-0000-000000000001', 'production', id FROM factories WHERE code = 'water';

INSERT INTO sales_reps(id, factory_id, code, full_name, status, kind)
SELECT v.id::uuid, f.id, v.code, v.name, 'active', v.kind
  FROM factories f,
  (VALUES ('cf000000-0000-0000-0000-000000000001', 'MPS-M1', 'MPS Ayuba', 'rep'),
          ('cf000000-0000-0000-0000-000000000002', 'MPS-R1', 'MPS Shop', 'outlet')) v(id, code, name, kind)
 WHERE f.code = 'water';
INSERT INTO customers(id, factory_id, name, code, registered)
SELECT v.id::uuid, f.id, v.name, v.code, v.reg
  FROM factories f,
  (VALUES ('cf000000-0000-0000-0000-000000000011', 'MPS Ambina', 'MPS-D1', true),
          ('cf000000-0000-0000-0000-000000000012', 'MPS Casual', NULL, false)) v(id, name, code, reg)
 WHERE f.code = 'water';
-- Posted sales on 2026-10-01: marketer 1,000 (300 on credit), shop 500,
-- distributor 2,000 (all credit), casual 100; a PR sale that doesn't count.
INSERT INTO sales(id, factory_id, invoice_number, sale_date, customer_id, customer_name, sales_rep_id,
                  subtotal, grand_total, amount_paid, balance, status, is_pr)
SELECT v.id::uuid, f.id, v.inv, '2026-10-01', v.cust::uuid, v.cname, v.rep::uuid, v.total, v.total, 0, v.total, 'pending_approval', v.pr
  FROM factories f,
  (VALUES ('cf000000-0000-0000-0000-000000000021', 'MPS-1', NULL, 'Walk-in', 'cf000000-0000-0000-0000-000000000001', 1000, false),
          ('cf000000-0000-0000-0000-000000000022', 'MPS-2', NULL, 'Shop buyer', 'cf000000-0000-0000-0000-000000000002', 500, false),
          ('cf000000-0000-0000-0000-000000000023', 'MPS-3', 'cf000000-0000-0000-0000-000000000011', 'MPS Ambina', NULL, 2000, false),
          ('cf000000-0000-0000-0000-000000000024', 'MPS-4', 'cf000000-0000-0000-0000-000000000012', 'MPS Casual', NULL, 100, false),
          ('cf000000-0000-0000-0000-000000000025', 'MPS-5', NULL, 'PR', 'cf000000-0000-0000-0000-000000000001', 999, true))
       v(id, inv, cust, cname, rep, total, pr)
 WHERE f.code = 'water';
-- Paid with the sale (while still pending, as approve_sale does): marketer 700,
-- shop 500, casual 100.
INSERT INTO payments_received(factory_id, receipt_number, payment_date, amount, payment_method, sale_id, customer_id,
                              status, at_point_of_sale)
SELECT f.id, v.rc, v.d::date, v.amt, 'cash', v.sale::uuid, v.cust::uuid, 'confirmed', v.pos
  FROM factories f,
  (VALUES ('MPS-R1', '2026-10-01', 700, 'cf000000-0000-0000-0000-000000000021', NULL, true),
          ('MPS-R2', '2026-10-01', 500, 'cf000000-0000-0000-0000-000000000022', NULL, true),
          ('MPS-R3', '2026-10-01', 100, 'cf000000-0000-0000-0000-000000000024', 'cf000000-0000-0000-0000-000000000012', true))
       v(rc, d, amt, sale, cust, pos)
 WHERE f.code = 'water';
UPDATE sales SET status = 'posted' WHERE invoice_number LIKE 'MPS-%';
-- Ambina pays 800 on her debt on 10-02.
INSERT INTO payments_received(factory_id, receipt_number, payment_date, amount, payment_method, sale_id, customer_id, status)
SELECT f.id, 'MPS-R4', '2026-10-02', 800, 'cash', 'cf000000-0000-0000-0000-000000000023', 'cf000000-0000-0000-0000-000000000011',
       'confirmed'
  FROM factories f WHERE f.code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: each party gets its own figures, by kind
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); r record;
BEGIN
  PERFORM set_config('test.uid', 'ce000000-0000-0000-0000-000000000009', false);
  SELECT * INTO r FROM public.monthly_party_sheet(f, '2026-10-01', '2026-10-31') WHERE party_name = 'MPS Ayuba';
  PERFORM pg_temp.check(r.party_kind = 'marketer' AND r.party_code = 'MPS-M1' AND r.total = 1000 AND r.credit = 300
                        AND r.recovery = 0, 'marketer: ' || row_to_json(r)::text);
  SELECT * INTO r FROM public.monthly_party_sheet(f, '2026-10-01', '2026-10-31') WHERE party_name = 'MPS Shop';
  PERFORM pg_temp.check(r.party_kind = 'retail' AND r.total = 500 AND r.credit = 0, 'retail: ' || row_to_json(r)::text);
  SELECT * INTO r FROM public.monthly_party_sheet(f, '2026-10-01', '2026-10-31')
   WHERE party_name = 'MPS Ambina' AND day = '2026-10-01';
  PERFORM pg_temp.check(r.party_kind = 'distributor' AND r.party_code = 'MPS-D1' AND r.total = 2000 AND r.credit = 2000,
                        'distributor sale: ' || row_to_json(r)::text);
  SELECT * INTO r FROM public.monthly_party_sheet(f, '2026-10-01', '2026-10-31')
   WHERE party_name = 'MPS Ambina' AND day = '2026-10-02';
  PERFORM pg_temp.check(r.total = 0 AND r.recovery = 800, 'distributor recovery: ' || row_to_json(r)::text);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.monthly_party_sheet(f, '2026-10-01', '2026-10-31')
                                 WHERE party_kind = 'other' AND party_id IS NULL AND total >= 100),
                        'unregistered customer goes to other');
END $$;

-- @@ Test 2: a user without finance or reports rights is refused
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'ce000000-0000-0000-0000-000000000001', false);
  BEGIN
    PERFORM public.monthly_party_sheet(f, '2026-10-01', '2026-10-31');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  PERFORM pg_temp.check(ok, 'production user refused');
END $$;
