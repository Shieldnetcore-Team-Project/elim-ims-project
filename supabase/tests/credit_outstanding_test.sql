-- ============================================================================
-- Acceptance tests: credit_outstanding (20261030240000_credit_outstanding.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Two of a marketer's customers owe, one
-- doesn't; a distributor owes; a removed customer owes. An accountant sees
-- the two under the marketer (with phones) and the distributor, nothing
-- else; someone without rights is refused. The page access moved to the
-- renamed tab.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('b1600000-0000-0000-0000-000000000001', 'acct@co'),
  ('b1600000-0000-0000-0000-000000000002', 'nobody@co');
DELETE FROM user_roles WHERE user_id IN ('b1600000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'b1600000-0000-0000-0000-000000000001', 'accountant', id FROM factories WHERE code = 'water';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'b1600000-0000-0000-0000-000000000002', 'production', id FROM factories WHERE code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, phone, status, kind)
SELECT 'b1600000-0000-0000-0000-0000000000b1', id, 'CO Emmanuel', '08011111111', 'active', 'rep' FROM factories WHERE code = 'water';
INSERT INTO customers(id, factory_id, name, phone, registered, sales_rep_id)
SELECT x.id::uuid, f.id, x.n, x.ph, x.reg, x.rep::uuid
  FROM factories f, (VALUES
    ('b1600000-0000-0000-0000-0000000000c1', 'CO Haq',       '08067822288', true,  'b1600000-0000-0000-0000-0000000000b1'),
    ('b1600000-0000-0000-0000-0000000000c2', 'CO Khanibaq',  '09031394661', true,  'b1600000-0000-0000-0000-0000000000b1'),
    ('b1600000-0000-0000-0000-0000000000c3', 'CO Paid Up',   NULL,          true,  'b1600000-0000-0000-0000-0000000000b1'),
    ('b1600000-0000-0000-0000-0000000000c4', 'CO Distrib',   '0802',        true,  NULL),
    ('b1600000-0000-0000-0000-0000000000c5', 'CO Removed',   NULL,          true,  NULL)) AS x(id, n, ph, reg, rep)
 WHERE f.code = 'water';
-- Balances as the ledger keeps them.
UPDATE customers SET outstanding_balance = x.o
  FROM (VALUES ('b1600000-0000-0000-0000-0000000000c1', 500150), ('b1600000-0000-0000-0000-0000000000c2', 448500),
               ('b1600000-0000-0000-0000-0000000000c4', 120000), ('b1600000-0000-0000-0000-0000000000c5', 99)) AS x(id, o)
 WHERE customers.id = x.id::uuid;
UPDATE customers SET removed_at = now() WHERE id = 'b1600000-0000-0000-0000-0000000000c5';
INSERT INTO user_page_access(user_id, page_id, granted)
VALUES ('b1600000-0000-0000-0000-000000000002', 'Marketer & Retail Accounts › Credit sales (distributors)', false);

-- @@ Test 1: the accountant sees the marketer's two debtors and the distributor; no rights refused
DO $$
DECLARE f uuid := (SELECT id FROM factories WHERE code = 'water'); got text; ok boolean := false;
BEGIN
  PERFORM set_config('test.uid', 'b1600000-0000-0000-0000-000000000001', false);
  got := (SELECT string_agg(concat_ws('/', kind, COALESCE(marketer_name, '-'), COALESCE(marketer_phone, '-'), customer,
                                      outstanding::int, COALESCE(phone, '-')), ' | ' ORDER BY customer)
            FROM public.credit_outstanding(f) WHERE customer LIKE 'CO %');
  IF got IS DISTINCT FROM 'distributor/-/-/CO Distrib/120000/0802 | marketer/CO Emmanuel/08011111111/CO Haq/500150/08067822288 | marketer/CO Emmanuel/08011111111/CO Khanibaq/448500/09031394661' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: %', got;
  END IF;
  PERFORM set_config('test.uid', 'b1600000-0000-0000-0000-000000000002', false);
  BEGIN
    PERFORM * FROM public.credit_outstanding(f);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Insufficient permissions%';
  END;
  IF NOT ok THEN RAISE EXCEPTION 'ASSERTION FAILED: no rights not refused'; END IF;
END $$;
