-- ============================================================================
-- Acceptance tests: marketer_customer_credit_bbf
-- (20261102090000_marketer_customer_credit_bbf.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. The four marketers on the 27/10/26 sheet
-- are the seeded Emmanuel (renamed from Emma), Abiodun, Godwin and Sunday; Al Haq is already a customer of Emmanuel's (found by phone), Nasir is
-- under another marketer, the rest are new. The balances land on each
-- marketer's account and a re-run adds nothing.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('bf270000-0000-0000-0000-000000000001', 'acct@bf');
DELETE FROM user_roles WHERE user_id = 'bf270000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT 'bf270000-0000-0000-0000-000000000001', 'accountant', id FROM factories WHERE code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'bf270000-0000-0000-0000-0000000000a5', id, 'Other Marketer', 'active', 'rep' FROM factories WHERE code = 'water';
-- The seeded marketers: Emmanuel (was Emma), Abiodun, Godwin, Sunday.
CREATE TEMP TABLE ids AS
SELECT lower(full_name) AS k, id AS v FROM sales_reps WHERE full_name IN ('Emmanuel', 'Abiodun', 'Godwin', 'Sunday');
INSERT INTO customers(id, factory_id, name, phone, registered, sales_rep_id, outstanding_balance)
SELECT x.id::uuid, f.id, x.n, x.ph, true, x.rep::uuid, 0
  FROM factories f, (VALUES
    ('bf270000-0000-0000-0000-0000000000c1', 'Al-Haq Stores', '0806 782 2288', (SELECT v FROM ids WHERE k = 'emmanuel')),
    ('bf270000-0000-0000-0000-0000000000c2', 'Nasir',         NULL,            'bf270000-0000-0000-0000-0000000000a5')) AS x(id, n, ph, rep)
 WHERE f.code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: every balance lands on its marketer's account
DO $$
DECLARE r jsonb;
BEGIN
  -- The complete names: Emma -> Emmanuel; no Emma, Biodun or Sunny left.
  PERFORM pg_temp.check((SELECT count(*) FROM ids) = 4, 'four marketers: ' || (SELECT string_agg(k, ',') FROM ids));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM sales_reps WHERE full_name ~* '\m(emma|biodun|sunny)\M'), 'short names gone');
  r := public._marketer_credit_bbf_20261027();
  PERFORM pg_temp.check((r->>'balances')::int = 11 AND (r->>'total')::numeric = 3130650, 'result: ' || r::text);
  -- Per marketer, as on the sheet.
  PERFORM pg_temp.check((SELECT sum(outstanding) FROM debts WHERE account_rep_id = (SELECT v FROM ids WHERE k = 'emmanuel') AND sale_id IS NULL) = 1033650, 'Emmanuel');
  PERFORM pg_temp.check((SELECT sum(outstanding) FROM debts WHERE account_rep_id = (SELECT v FROM ids WHERE k = 'abiodun') AND sale_id IS NULL) = 415750, 'Biodun');
  PERFORM pg_temp.check((SELECT sum(outstanding) FROM debts WHERE account_rep_id = (SELECT v FROM ids WHERE k = 'godwin') AND sale_id IS NULL) = 981250, 'Godwin');
  PERFORM pg_temp.check((SELECT sum(outstanding) FROM debts WHERE account_rep_id = (SELECT v FROM ids WHERE k = 'sunday') AND sale_id IS NULL) = 700000, 'Sunny = Sunday');
  -- Al Haq found by phone, not duplicated; Nasir moved to Biodun with history.
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'bf270000-0000-0000-0000-0000000000c1') = 500150, 'Al Haq owes');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM customers WHERE name ILIKE 'al haq'), 'Al Haq not duplicated');
  PERFORM pg_temp.check((SELECT sales_rep_id FROM customers WHERE id = 'bf270000-0000-0000-0000-0000000000c2') = (SELECT v FROM ids WHERE k = 'abiodun'), 'Nasir moved');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM customer_marketer_history WHERE customer_id = 'bf270000-0000-0000-0000-0000000000c2'
                                 AND to_rep_id = (SELECT v FROM ids WHERE k = 'abiodun') AND reason LIKE '%27 Oct 2026%'), 'move logged');
  -- New customers under their marketer, with phone; dated 27 Oct; ledger agrees.
  PERFORM pg_temp.check((SELECT sales_rep_id FROM customers WHERE name = 'Alh. Muhammed') = (SELECT v FROM ids WHERE k = 'abiodun')
                        AND (SELECT phone FROM customers WHERE name = 'Alh. Muhammed') = '08051341474, 09166485470', 'new customer');
  PERFORM pg_temp.check((SELECT count(*) FROM debts WHERE sale_id IS NULL AND account_rep_id IS NOT NULL
                          AND (created_at AT TIME ZONE 'UTC')::date = '2026-10-27' AND due_date IS NOT NULL) = 11, 'dated 27 Oct');
  PERFORM pg_temp.check((SELECT debt_after FROM customer_account_transactions
                          WHERE customer_id = 'bf270000-0000-0000-0000-0000000000c1' ORDER BY seq DESC LIMIT 1) = 500150, 'ledger');
END $$;

-- @@ Test 2: the accountant's card and the marketer statement count it
DO $$
DECLARE s jsonb;
BEGIN
  PERFORM set_config('test.uid', 'bf270000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check((SELECT sum(brought_forward) FROM public.rep_customers((SELECT v FROM ids WHERE k = 'godwin'))) = 981250, 'rep_customers b/f');
  PERFORM pg_temp.check((SELECT brought_forward_due FROM public.rep_customers((SELECT v FROM ids WHERE k = 'godwin')) LIMIT 1) > '2026-10-27', 'due date');
  s := public.marketer_statement((SELECT v FROM ids WHERE k = 'sunday'), NULL, NULL);
  PERFORM pg_temp.check(s::text LIKE '%700000%', 'Sunny statement shows 700,000: ' || left(s::text, 400));
END $$;

-- @@ Test 3: a payment clears it; a re-run adds nothing
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', 'bf270000-0000-0000-0000-000000000001', false);
  PERFORM public.record_payment(jsonb_build_object('factory_id', (SELECT id FROM factories WHERE code = 'water'), 'customer_id', 'bf270000-0000-0000-0000-0000000000c1', 'amount', 150,
            'payment_method', 'cash', 'collected_by_rep', (SELECT v FROM ids WHERE k = 'emmanuel')));
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'bf270000-0000-0000-0000-0000000000c1') = 500000, 'paid down');
  PERFORM pg_temp.check((SELECT brought_forward FROM public.rep_customers((SELECT v FROM ids WHERE k = 'emmanuel'))
                          WHERE customer_id = 'bf270000-0000-0000-0000-0000000000c1') = 500000, 'b/f paid down');
  r := public._marketer_credit_bbf_20261027();
  PERFORM pg_temp.check((r->>'balances')::int = 0, 're-run: ' || r::text);
  PERFORM pg_temp.check((SELECT count(*) FROM debts WHERE sale_id IS NULL AND account_rep_id IS NOT NULL) = 11, 'no duplicates');
END $$;
