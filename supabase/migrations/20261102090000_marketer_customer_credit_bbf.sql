-- ============================================================================
-- Marketer customers: credit outstanding brought forward (27 Oct 2026)
-- ----------------------------------------------------------------------------
-- User request (2026-11-02): the paper "TOTAL CREDIT OUTSTANDING" sheet of
-- 27/10/26 is carried into the system, so each marketer's account (Marketer
-- page, Accountant -> Marketer & retail accounts) shows what their customers
-- still owe:
--   Emmanuel  Al Haq 500,150 · Khanibaq 448,500 · Iyanu Provision 85,000
--                                                           = 1,033,650
--   Biodun    Alh. Muhammed 344,500 · Mazito 25,750 · Nasir 45,500 = 415,750
--   Godwin    First Place Fidelity 265,000 · First Place Charliboy 385,000 ·
--             T-Y Store 331,250                               =   981,250
--   Sunny     World Health 530,000 · Igwe Garden 170,000      =   700,000
--
-- Each balance is one debt with no invoice (sale_id NULL), dated 27 Oct 2026,
-- on the marketer's account (sales_rep_id / account_rep_id), plus an
-- OPENING_BALANCE row on the customer's ledger and the cached
-- customers.outstanding_balance. Record payment then clears it like any other
-- debt (oldest first), so later payments reduce it.
--
-- Customers are found by phone, else by name (case/punctuation ignored,
-- this marketer's customers first); a missing one is created under the
-- marketer. One found under another marketer is moved to this one (logged in
-- customer_marketer_history). Re-running adds nothing: each balance carries
-- an idempotency key on the ledger.
--
-- rep_customers gains brought_forward / brought_forward_due so the
-- Accountant's "Customers of <marketer>" card counts these balances in Owes.
-- ============================================================================

-- ============ 1. rep_customers: balances brought forward ============
DROP FUNCTION IF EXISTS public.rep_customers(uuid);
CREATE FUNCTION public.rep_customers(p_sales_rep_id uuid)
RETURNS TABLE(
  customer_id uuid, name text, phone text, assigned boolean,
  total_owed numeric, advance_balance numeric, collected_by_rep numeric, last_collection date,
  brought_forward numeric, brought_forward_due date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT c.id, c.name, c.phone, c.sales_rep_id IS NOT DISTINCT FROM p_sales_rep_id,
         c.outstanding_balance, c.credit_balance,
         COALESCE(p.total, 0), p.last_date,
         COALESCE(bf.owed, 0), bf.due
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT SUM(pr.amount) AS total, MAX(pr.payment_date) AS last_date
        FROM payments_received pr
       WHERE pr.customer_id = c.id AND pr.collected_by_rep = p_sales_rep_id
         AND pr.status NOT IN ('reversed','rejected')
    ) p ON true
    -- Debts with no invoice (balances brought forward, adjustments) on this
    -- marketer's account: rep_customer_invoices lists invoices only.
    LEFT JOIN LATERAL (
      SELECT SUM(d.outstanding) AS owed, MIN(d.due_date) AS due
        FROM debts d
       WHERE d.customer_id = c.id AND d.sale_id IS NULL AND d.account_rep_id = p_sales_rep_id
         AND d.status <> 'paid' AND d.outstanding > 0
    ) bf ON true
   WHERE c.sales_rep_id = p_sales_rep_id
      OR EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id AND s.sales_rep_id = p_sales_rep_id
                   AND s.status = 'posted' AND s.deleted_at IS NULL)
   ORDER BY c.name;
END;
$$;
REVOKE ALL ON FUNCTION public.rep_customers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_customers(uuid) TO authenticated;

-- ============ 2. Marketers' full names ============
-- User (2026-11-02): "Emma is Emmanuel, Biodun is Abiodun and Sunny Sunday"
-- -- use the complete names. Only the first name changes; a surname stays.
UPDATE public.sales_reps r
   SET full_name = x.full_name, updated_at = now()
  FROM (SELECT id, regexp_replace(regexp_replace(regexp_replace(full_name,
                 '\mEmma\M', 'Emmanuel', 'gi'),
                 '\mBiodun\M', 'Abiodun', 'gi'),
                 '\mSunny\M', 'Sunday', 'gi') AS full_name
          FROM public.sales_reps WHERE kind = 'rep') x
 WHERE r.id = x.id AND r.full_name IS DISTINCT FROM x.full_name;

-- A go-live reset re-seeds the marketers under these names too.
CREATE OR REPLACE FUNCTION public.seed_marketers()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_factory uuid;
  v_added integer;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN RETURN 0; END IF;
  INSERT INTO sales_reps (factory_id, full_name, status, kind)
  SELECT v_factory, n.full_name, 'active', 'rep'
    FROM unnest(ARRAY[
           'Abiodun', 'Godwin', 'Emmanuel', 'Malla', 'Sunday', 'Courage', 'Abacha',
           'Christopher Ayuba'
         ]) WITH ORDINALITY AS n(full_name, ord)
   WHERE NOT EXISTS (
           SELECT 1 FROM sales_reps r
            WHERE r.factory_id = v_factory AND lower(trim(r.full_name)) = lower(n.full_name))
   ORDER BY n.ord;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_added;
END;
$$;
REVOKE ALL ON FUNCTION public.seed_marketers() FROM PUBLIC, anon, authenticated;

-- ============ 3. The balances ============
-- A function rather than a bare DO block so the tests can run it. The sheet's
-- names are matched to the system's: Emmanuel = Emma, Biodun = Abiodun,
-- Sunny = Sunday (or the phone 07086339002); more than one match stops it.
CREATE OR REPLACE FUNCTION public._marketer_credit_bbf_20261027()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := DATE '2026-10-27';
  v_row record;
  v_rep sales_reps%ROWTYPE;
  v_reps int;
  v_cust customers%ROWTYPE;
  v_phones text[];
  v_norm text;
  v_key text;
  v_debt uuid;
  v_count int := 0;
  v_total numeric := 0;
  v_lines jsonb := '[]'::jsonb;
  v_before numeric;
BEGIN
  FOR v_row IN
    SELECT * FROM (VALUES
      ('Emmanuel', '\memma',           NULL,          'AL HAQ',                '08067822288',              500150.00),
      ('Emmanuel', '\memma',           NULL,          'KHANIBAQ',              '09031394661',              448500.00),
      ('Emmanuel', '\memma',           NULL,          'IYANU PROVISION',       '09023495419',               85000.00),
      ('Biodun',   '\ma?biodun',       NULL,          'ALH. MUHAMMED',         '08051341474, 09166485470', 344500.00),
      ('Biodun',   '\ma?biodun',       NULL,          'MAZITO',                '08033749357',               25750.00),
      ('Biodun',   '\ma?biodun',       NULL,          'NASIR',                 '08063688156',               45500.00),
      ('Godwin',   '\mgodwin',         NULL,          'FIRST PLACE FIDELITY',  '09070513001',              265000.00),
      ('Godwin',   '\mgodwin',         NULL,          'FIRST PLACE CHARLIBOY', '08065061757',              385000.00),
      ('Godwin',   '\mgodwin',         NULL,          'T-Y STORE',             '08036627839',              331250.00),
      ('Sunny',    '\msun(ny|day)\M',  '07086339002', 'WORLD HEALTH',          '08106836992',              530000.00),
      ('Sunny',    '\msun(ny|day)\M',  '07086339002', 'IGWE GARDEN',           NULL,                       170000.00)
    ) AS t(marketer, pattern, marketer_phone, customer, phone, amount)
  LOOP
    -- The marketer: by phone when given, else by name (active ones first).
    v_rep := NULL;
    IF v_row.marketer_phone IS NOT NULL THEN
      SELECT * INTO v_rep FROM sales_reps
       WHERE kind = 'rep' AND public._norm_phone(phone) = public._norm_phone(v_row.marketer_phone)
       ORDER BY (status = 'active') DESC LIMIT 1;
    END IF;
    IF v_rep.id IS NULL THEN
      SELECT count(*) INTO v_reps FROM sales_reps
       WHERE kind = 'rep' AND status = 'active' AND full_name ~* v_row.pattern;
      IF v_reps = 0 THEN
        SELECT count(*) INTO v_reps FROM sales_reps WHERE kind = 'rep' AND full_name ~* v_row.pattern;
      END IF;
      IF v_reps <> 1 THEN
        RAISE EXCEPTION 'Marketer "%" on the sheet matches % marketers in the system: %', v_row.marketer, v_reps,
          COALESCE((SELECT string_agg(full_name || ' (' || status || ')', ', ') FROM sales_reps
                     WHERE kind = 'rep' AND full_name ~* v_row.pattern), 'none');
      END IF;
      SELECT * INTO v_rep FROM sales_reps
       WHERE kind = 'rep' AND full_name ~* v_row.pattern
       ORDER BY (status = 'active') DESC LIMIT 1;
    END IF;

    v_key := 'bbf-20261027-' || v_rep.id || '-' || lower(regexp_replace(v_row.customer, '[^A-Za-z0-9]', '', 'g'));
    CONTINUE WHEN EXISTS (SELECT 1 FROM customer_account_transactions WHERE idempotency_key = v_key);

    -- The customer: by any of the phones, else by name.
    v_cust := NULL;
    v_phones := ARRAY(SELECT public._norm_phone(x) FROM regexp_split_to_table(COALESCE(v_row.phone, ''), '[,/;]') x
                       WHERE public._norm_phone(x) IS NOT NULL);
    SELECT * INTO v_cust FROM customers
     WHERE factory_id = v_rep.factory_id AND removed_at IS NULL
       AND public._norm_phone(phone) = ANY (v_phones)
     ORDER BY (sales_rep_id = v_rep.id) DESC NULLS LAST, registered DESC, created_at LIMIT 1;
    IF v_cust.id IS NULL THEN
      v_norm := lower(regexp_replace(v_row.customer, '[^A-Za-z0-9]', '', 'g'));
      SELECT * INTO v_cust FROM customers
       WHERE factory_id = v_rep.factory_id AND removed_at IS NULL
         AND lower(regexp_replace(name, '[^A-Za-z0-9]', '', 'g')) = v_norm
       ORDER BY (sales_rep_id = v_rep.id) DESC NULLS LAST, registered DESC, created_at LIMIT 1;
    END IF;

    IF v_cust.id IS NULL THEN
      INSERT INTO customers(factory_id, name, phone, sales_rep_id, registered, notes)
      VALUES (v_rep.factory_id, initcap(v_row.customer), v_row.phone, v_rep.id, true,
              'Added with the credit outstanding brought forward on 27 Oct 2026')
      RETURNING * INTO v_cust;
    ELSIF v_cust.sales_rep_id IS DISTINCT FROM v_rep.id THEN
      PERFORM set_config('elim.reassign_reason', 'Credit outstanding sheet of 27 Oct 2026 lists them under ' || v_rep.full_name, true);
      UPDATE customers SET sales_rep_id = v_rep.id, registered = true, updated_at = now() WHERE id = v_cust.id;
      PERFORM set_config('elim.reassign_reason', '', true);
    END IF;

    SELECT COALESCE(outstanding_balance, 0) INTO v_before FROM customers WHERE id = v_cust.id FOR UPDATE;
    INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status, created_at)
    VALUES (v_rep.factory_id, v_cust.id, NULL, v_rep.id, v_row.amount, 0, v_row.amount, 'unpaid', v_date::timestamptz)
    RETURNING id INTO v_debt;
    UPDATE customers SET outstanding_balance = outstanding_balance + v_row.amount, updated_at = now() WHERE id = v_cust.id;
    PERFORM public._customer_ledger_post(
      v_rep.factory_id, v_cust.id, 'OPENING_BALANCE', 'balance_bf', v_debt, NULL, NULL, v_debt,
      0, 0, 0, 0, v_row.amount, NULL,
      'Credit outstanding brought forward (' || v_rep.full_name || ', 27 Oct 2026)',
      'From the marketers'' total credit outstanding sheet of 27/10/26', NULL, v_key, NULL);

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (NULL, v_rep.factory_id, 'marketer_customer_balance_bf', 'customers', v_cust.id::text,
            jsonb_build_object('marketer', v_rep.full_name, 'customer', v_cust.name, 'amount', v_row.amount,
                               'as_of', v_date, 'debt_id', v_debt));
    v_lines := v_lines || jsonb_build_object('marketer', v_rep.full_name, 'customer', v_cust.name,
                                             'brought_forward', v_row.amount, 'owed_before', v_before,
                                             'owes_now', v_before + v_row.amount);
    v_count := v_count + 1;
    v_total := v_total + v_row.amount;
  END LOOP;
  RAISE NOTICE 'Brought forward % customer balance(s), total %', v_count, v_total;
  RETURN jsonb_build_object('balances', v_count, 'total', v_total, 'lines', v_lines);
END;
$$;
REVOKE ALL ON FUNCTION public._marketer_credit_bbf_20261027() FROM PUBLIC, anon, authenticated;

-- Only where the factory is trading (marketers have had stock posted to them):
-- a fresh test database, which has the seeded marketers but no history,
-- is left alone.
SELECT CASE WHEN EXISTS (SELECT 1 FROM public.rep_stock_movements)
            THEN public._marketer_credit_bbf_20261027()
            ELSE jsonb_build_object('skipped', 'no marketer postings yet') END AS result;
