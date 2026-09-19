-- ============================================================================
-- Customer account ledger (advance / credit / debt) — Phase 3 backend
-- ----------------------------------------------------------------------------
-- Until now a customer's position lived in two cached columns
-- (customers.credit_balance, customers.outstanding_balance) plus a "ledger"
-- the Sales page rebuilt in the browser (payments minus posted sales). There
-- was no record of HOW those numbers were reached, a payment made while the
-- customer owed money never settled that debt, an over-payment on an old debt
-- was silently dropped, and reversing an advance payment actually *increased*
-- the customer's debt.
--
-- This migration adds ONE append-only table, customer_account_transactions,
-- and makes every RPC that moves a customer's balance post to it in the same
-- transaction, under the same customer-row lock:
--
--   record_customer_advance  deposit  -> settle oldest debts first, excess = credit
--   record_payment           payment  -> same allocation, then credit
--   approve_sale             SALE / ADVANCE_APPLIED / overpayment credit
--   approve_delete (sales)   compensating REVERSAL / ADVANCE_RESTORED rows
--   reverse_payment          undoes exactly what the payment did (ledger-aware)
--   post/reverse_debt_writeoff
--
-- The two customers.* columns stay as a protected cache; the ledger is the
-- history. reconcile_customer_account() reports any disagreement between them.
--
-- Nothing is reconstructed for the past: each customer holding a balance gets
-- a single OPENING_BALANCE row equal to the stored figures.
--
-- Manual corrections go through maker-checker (customer_account_adjustments):
-- the accountant submits, an admin (super_admin/chairman) approves.
--
-- Lock order everywhere: sale -> customer -> debts (oldest first) -> stock.
-- ============================================================================

-- ============ 1. Ledger table ============
CREATE TABLE public.customer_account_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  txn_type text NOT NULL CHECK (txn_type IN (
    'OPENING_BALANCE','ADVANCE_PAYMENT','SALE','ADVANCE_APPLIED','CUSTOMER_PAYMENT',
    'DEBT_SETTLEMENT','REFUND','CREDIT_ADJUSTMENT','DEBIT_ADJUSTMENT','REVERSAL','ADVANCE_RESTORED'
  )),
  -- What the row is about. Deliberately NOT foreign keys: the ledger is
  -- immutable history and must survive a debt row being deleted (sale
  -- reversal) or a sale being purged after its retention window.
  reference_type text,
  reference_id uuid,
  sale_id uuid,
  payment_id uuid,
  debt_id uuid,
  reverses_id uuid,
  amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  goods_value numeric(14,2) NOT NULL DEFAULT 0 CHECK (goods_value >= 0),
  cash_paid numeric(14,2) NOT NULL DEFAULT 0 CHECK (cash_paid >= 0),
  advance_used numeric(14,2) NOT NULL DEFAULT 0 CHECK (advance_used >= 0),
  -- Signed change to each side of the account. Two columns rather than one
  -- signed balance so credit and debt are never netted silently.
  credit_delta numeric(14,2) NOT NULL DEFAULT 0,
  debt_delta numeric(14,2) NOT NULL DEFAULT 0,
  credit_after numeric(14,2) NOT NULL CHECK (credit_after >= 0),
  debt_after numeric(14,2) NOT NULL CHECK (debt_after >= 0),
  payment_method public.payment_method,
  description text,
  notes text,
  status text NOT NULL DEFAULT 'posted' CHECK (status = 'posted'),
  idempotency_key text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cat_customer_seq ON public.customer_account_transactions (customer_id, seq);
CREATE INDEX idx_cat_factory_created ON public.customer_account_transactions (factory_id, created_at);
CREATE INDEX idx_cat_sale ON public.customer_account_transactions (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX idx_cat_payment ON public.customer_account_transactions (payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_cat_idempotency ON public.customer_account_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- The same business event can never post the same kind of row twice.
CREATE UNIQUE INDEX uq_cat_reference ON public.customer_account_transactions
  (txn_type, reference_type, reference_id, COALESCE(debt_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public._customer_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customer_account_transactions is append-only; post a compensating entry instead';
END;
$$;
CREATE TRIGGER trg_cat_immutable
  BEFORE UPDATE OR DELETE ON public.customer_account_transactions
  FOR EACH ROW EXECUTE FUNCTION public._customer_ledger_immutable();

ALTER TABLE public.customer_account_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_account_transactions FROM anon, authenticated;
GRANT SELECT ON public.customer_account_transactions TO authenticated;
GRANT ALL ON public.customer_account_transactions TO service_role;
CREATE POLICY "customer ledger read" ON public.customer_account_transactions FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'customers'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'payments'::module_key, 'view'::action_key)
  );
-- No INSERT/UPDATE/DELETE policy: rows are written only by the SECURITY
-- DEFINER RPCs below.

-- ============ 2. Internal helpers (not callable by clients) ============
-- Posts one ledger row. The caller must already hold the customer-row lock
-- (re-taking it here is harmless); balances are derived from the previous
-- ledger row, and a delta that would push a side below zero is clamped so a
-- pre-existing cache/ledger drift can never make a sale or payment fail.
CREATE OR REPLACE FUNCTION public._customer_ledger_post(
  p_factory uuid, p_customer uuid, p_type text,
  p_ref_type text, p_ref_id uuid,
  p_sale_id uuid, p_payment_id uuid, p_debt_id uuid,
  p_goods_value numeric, p_cash_paid numeric, p_advance_used numeric,
  p_credit_delta numeric, p_debt_delta numeric,
  p_method public.payment_method, p_description text, p_notes text,
  p_reverses uuid, p_idem text, p_uid uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_prev_credit numeric;
  v_prev_debt numeric;
  v_credit_delta numeric;
  v_debt_delta numeric;
  v_amount numeric;
  v_id uuid;
BEGIN
  PERFORM 1 FROM customers WHERE id = p_customer FOR UPDATE;

  SELECT credit_after, debt_after INTO v_prev_credit, v_prev_debt
    FROM customer_account_transactions
   WHERE customer_id = p_customer
   ORDER BY seq DESC LIMIT 1;
  v_prev_credit := COALESCE(v_prev_credit, 0);
  v_prev_debt := COALESCE(v_prev_debt, 0);

  v_credit_delta := GREATEST(COALESCE(p_credit_delta, 0), -v_prev_credit);
  v_debt_delta := GREATEST(COALESCE(p_debt_delta, 0), -v_prev_debt);
  v_amount := GREATEST(abs(v_credit_delta), abs(v_debt_delta), COALESCE(p_goods_value, 0),
                       COALESCE(p_cash_paid, 0), COALESCE(p_advance_used, 0));
  IF v_amount = 0 THEN RETURN NULL; END IF;

  INSERT INTO customer_account_transactions(
    factory_id, customer_id, txn_type, reference_type, reference_id, sale_id, payment_id, debt_id, reverses_id,
    amount, goods_value, cash_paid, advance_used, credit_delta, debt_delta, credit_after, debt_after,
    payment_method, description, notes, idempotency_key, created_by)
  VALUES (
    p_factory, p_customer, p_type, p_ref_type, p_ref_id, p_sale_id, p_payment_id, p_debt_id, p_reverses,
    v_amount, COALESCE(p_goods_value, 0), COALESCE(p_cash_paid, 0), COALESCE(p_advance_used, 0),
    v_credit_delta, v_debt_delta, v_prev_credit + v_credit_delta, v_prev_debt + v_debt_delta,
    p_method, p_description, p_notes, p_idem, p_uid)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._customer_ledger_post(uuid,uuid,text,text,uuid,uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,public.payment_method,text,text,uuid,text,uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._next_receipt_number(p_factory uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_prefix text; v_candidate text; v_try int := 0;
BEGIN
  SELECT COALESCE(receipt_prefix, 'RCP-') INTO v_prefix FROM settings WHERE factory_id = p_factory;
  v_prefix := COALESCE(v_prefix, 'RCP-');
  LOOP
    v_candidate := v_prefix || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM payments_received WHERE receipt_number = v_candidate);
    v_try := v_try + 1;
    IF v_try > 25 THEN RAISE EXCEPTION 'Could not allocate a unique receipt number'; END IF;
  END LOOP;
  RETURN v_candidate;
END;
$$;
REVOKE ALL ON FUNCTION public._next_receipt_number(uuid) FROM PUBLIC, anon, authenticated;

-- Money received from a customer: settle their oldest open debts first (a
-- targeted debt goes to the front of the queue), and only what is left over
-- becomes credit. Caller inserts the payments_received row first.
CREATE OR REPLACE FUNCTION public._customer_receive_money(
  p_factory uuid, p_customer uuid, p_amount numeric, p_method public.payment_method, p_date date,
  p_uid uuid, p_remarks text, p_payment_id uuid, p_receipt text, p_target_debt uuid,
  p_origin text, p_idem text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_remaining numeric := p_amount;
  v_settled numeric := 0;
  v_credit numeric := 0;
  v_debt debts%ROWTYPE;
  v_pay numeric;
  v_new_paid numeric;
  v_new_out numeric;
  v_invoice text;
  v_n int := 0;
  v_allocs jsonb := '[]'::jsonb;
BEGIN
  PERFORM 1 FROM customers WHERE id = p_customer FOR UPDATE;

  FOR v_debt IN
    SELECT * FROM debts
     WHERE customer_id = p_customer AND factory_id = p_factory
       AND outstanding > 0 AND status <> 'paid'
     ORDER BY (id = p_target_debt) DESC, created_at, id
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_pay := LEAST(v_remaining, v_debt.outstanding);
    v_new_paid := v_debt.amount_paid + v_pay;
    v_new_out := v_debt.outstanding - v_pay;

    UPDATE debts SET amount_paid = v_new_paid, outstanding = v_new_out,
           status = CASE WHEN v_new_out = 0 THEN 'paid'::debt_status
                         WHEN v_new_paid > 0 THEN 'partial'::debt_status
                         ELSE 'unpaid'::debt_status END,
           updated_at = now()
     WHERE id = v_debt.id;

    INSERT INTO debt_payments(debt_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_debt.id, v_pay, p_method, p_date, p_uid, p_remarks);

    v_invoice := NULL;
    IF v_debt.sale_id IS NOT NULL THEN
      UPDATE sales SET amount_paid = amount_paid + v_pay, balance = GREATEST(balance - v_pay, 0)
       WHERE id = v_debt.sale_id
       RETURNING invoice_number INTO v_invoice;
    END IF;

    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_pay, 0), updated_at = now()
     WHERE id = p_customer;

    v_n := v_n + 1;
    PERFORM public._customer_ledger_post(
      p_factory, p_customer, 'DEBT_SETTLEMENT', 'payment', p_payment_id,
      v_debt.sale_id, p_payment_id, v_debt.id,
      0, v_pay, 0, 0, -v_pay,
      p_method,
      CASE WHEN v_invoice IS NOT NULL THEN 'Payment applied to ' || v_invoice ELSE 'Payment applied to outstanding debt' END,
      p_receipt,
      NULL,
      CASE WHEN p_idem IS NULL THEN NULL WHEN v_n = 1 THEN p_idem ELSE p_idem || ':' || v_n END,
      p_uid);

    v_settled := v_settled + v_pay;
    v_remaining := v_remaining - v_pay;
    v_allocs := v_allocs || jsonb_build_object('debt_id', v_debt.id, 'sale_id', v_debt.sale_id, 'amount', v_pay);
  END LOOP;

  IF v_remaining > 0 THEN
    UPDATE customers SET credit_balance = credit_balance + v_remaining, updated_at = now()
     WHERE id = p_customer;
    v_n := v_n + 1;
    PERFORM public._customer_ledger_post(
      p_factory, p_customer,
      CASE WHEN p_origin = 'advance' THEN 'ADVANCE_PAYMENT' ELSE 'CUSTOMER_PAYMENT' END,
      'payment', p_payment_id, NULL, p_payment_id, NULL,
      0, v_remaining, 0, v_remaining, 0,
      p_method,
      CASE WHEN p_origin = 'advance' THEN 'Advance payment' ELSE 'Payment in excess of debt, held as credit' END,
      p_receipt,
      NULL,
      CASE WHEN p_idem IS NULL THEN NULL WHEN v_n = 1 THEN p_idem ELSE p_idem || ':' || v_n END,
      p_uid);
    v_credit := v_remaining;
  END IF;

  RETURN jsonb_build_object('settled_debt', v_settled, 'credit_added', v_credit, 'allocations', v_allocs);
END;
$$;
REVOKE ALL ON FUNCTION public._customer_receive_money(uuid,uuid,numeric,public.payment_method,date,uuid,text,uuid,text,uuid,text,text) FROM PUBLIC, anon, authenticated;

-- ============ 3. Opening balances (no history is invented) ============
INSERT INTO public.customer_account_transactions(
  factory_id, customer_id, txn_type, reference_type, reference_id, amount,
  credit_delta, debt_delta, credit_after, debt_after, description, notes)
SELECT c.factory_id, c.id, 'OPENING_BALANCE', 'opening', c.id,
       GREATEST(c.credit_balance, c.outstanding_balance, 0),
       GREATEST(c.credit_balance, 0), GREATEST(c.outstanding_balance, 0),
       GREATEST(c.credit_balance, 0), GREATEST(c.outstanding_balance, 0),
       'Opening balance carried over when the account ledger went live',
       'Taken from the stored customer balances; earlier history was not reconstructed.'
  FROM public.customers c
 WHERE (c.credit_balance > 0 OR c.outstanding_balance > 0)
   AND NOT EXISTS (SELECT 1 FROM public.customer_account_transactions l WHERE l.customer_id = c.id);

INSERT INTO public.audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
SELECT NULL, NULL, 'customer_ledger_opening_balances', 'customers', NULL, NULL,
       jsonb_build_object('customers_seeded', count(*), 'total_credit', COALESCE(sum(credit_after), 0),
                          'total_debt', COALESCE(sum(debt_after), 0))
  FROM public.customer_account_transactions WHERE txn_type = 'OPENING_BALANCE';

-- ============ 4. record_customer_advance: settle debts first, excess = credit ============
CREATE OR REPLACE FUNCTION public.record_customer_advance(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_amount numeric := COALESCE((payload->>'amount')::numeric, 0);
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_remarks text := NULLIF(btrim(COALESCE(payload->>'remarks','')), '');
  v_reference text := NULLIF(btrim(COALESCE(payload->>'reference','')), '');
  v_idem text := NULLIF(btrim(COALESCE(payload->>'idempotency_key','')), '');
  v_receipt text;
  v_payment_id uuid;
  v_existing uuid;
  v_res jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'A registered customer is required for an advance payment'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;

  -- Serialises everything for this customer, including a double-submit.
  PERFORM 1 FROM customers WHERE id = v_customer AND factory_id = v_factory FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this factory'; END IF;

  IF v_idem IS NOT NULL THEN
    SELECT payment_id INTO v_existing FROM customer_account_transactions WHERE idempotency_key = v_idem;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'payment_id', v_existing,
        'receipt_number', (SELECT receipt_number FROM payments_received WHERE id = v_existing));
    END IF;
  END IF;

  v_receipt := public._next_receipt_number(v_factory);
  INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
  VALUES (v_factory, v_receipt, v_customer, NULL, v_amount, v_method, CURRENT_DATE, v_uid,
          COALESCE(v_remarks, 'Advance payment') || CASE WHEN v_reference IS NOT NULL THEN ' (Ref: ' || v_reference || ')' ELSE '' END)
  RETURNING id INTO v_payment_id;

  v_res := public._customer_receive_money(v_factory, v_customer, v_amount, v_method, CURRENT_DATE, v_uid,
                                          v_remarks, v_payment_id, v_receipt, NULL, 'advance', v_idem);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'record_customer_advance', 'customers', v_customer::text, NULL,
          jsonb_build_object('amount', v_amount, 'payment_method', v_method, 'receipt_number', v_receipt,
                             'settled_debt', v_res->'settled_debt', 'credit_added', v_res->'credit_added'));

  RETURN jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt, 'amount', v_amount,
                            'settled_debt', v_res->'settled_debt', 'credit_added', v_res->'credit_added',
                            'allocations', v_res->'allocations');
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_customer_advance(jsonb) TO authenticated;

-- ============ 5. record_payment: same allocation; no more silently lost excess ============
CREATE OR REPLACE FUNCTION public.record_payment(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_debt_id uuid := NULLIF(payload->>'debt_id','')::uuid;
  v_sale_id uuid := NULLIF(payload->>'sale_id','')::uuid;
  v_date date := COALESCE((payload->>'payment_date')::date, CURRENT_DATE);
  v_remarks text := payload->>'remarks';
  v_idem text := NULLIF(btrim(COALESCE(payload->>'idempotency_key','')), '');
  v_multi boolean := COALESCE(CASE WHEN jsonb_typeof(payload->'payments') = 'array' THEN jsonb_array_length(payload->'payments') > 0 END, false);
  v_lines jsonb;
  v_line jsonb;
  v_i int := 0;
  v_amount numeric;
  v_method payment_method;
  v_total numeric := 0;
  v_settled numeric := 0;
  v_credit numeric := 0;
  v_receipt text;
  v_payment_id uuid;
  v_first_payment uuid;
  v_first_receipt text;
  v_debt debts%ROWTYPE;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_existing uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key) OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;

  IF v_debt_id IS NULL AND v_sale_id IS NOT NULL THEN
    SELECT id INTO v_debt_id FROM debts WHERE sale_id = v_sale_id AND status <> 'paid' LIMIT 1;
  END IF;
  IF v_sale_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM sales WHERE id = v_sale_id AND status = 'posted') THEN
      RAISE EXCEPTION 'Cannot record a payment against a sale that has not been approved yet';
    END IF;
  END IF;
  IF v_debt_id IS NOT NULL THEN
    SELECT * INTO v_debt FROM debts WHERE id = v_debt_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'debt not found'; END IF;
    IF v_sale_id IS NULL THEN v_sale_id := v_debt.sale_id; END IF;
    IF v_customer IS NULL THEN v_customer := v_debt.customer_id; END IF;
  END IF;

  IF v_multi THEN
    v_lines := payload->'payments';
  ELSE
    v_lines := jsonb_build_array(jsonb_build_object(
      'amount', COALESCE((payload->>'amount')::numeric, 0),
      'method', COALESCE(payload->>'payment_method', 'cash')));
  END IF;

  -- A debt with no customer on it (named walk-in): nothing to ledger and no
  -- account to hold credit, so only that one debt can be paid down.
  IF v_customer IS NULL THEN
    IF v_debt_id IS NULL THEN RAISE EXCEPTION 'A customer or debt is required'; END IF;
    SELECT * INTO v_debt FROM debts WHERE id = v_debt_id FOR UPDATE;
    FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
      v_amount := COALESCE((v_line->>'amount')::numeric, 0);
      v_method := COALESCE((v_line->>'method')::payment_method, 'cash');
      IF v_amount <= 0 THEN CONTINUE; END IF;
      IF v_amount > v_debt.outstanding THEN RAISE EXCEPTION 'Payment exceeds the amount owed on this debt'; END IF;
      v_receipt := public._next_receipt_number(v_factory);
      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_factory, v_receipt, NULL, v_sale_id, v_amount, v_method, v_date, v_uid, v_remarks)
      RETURNING id INTO v_payment_id;
      INSERT INTO debt_payments(debt_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_debt_id, v_amount, v_method, v_date, v_uid, v_remarks);
      UPDATE debts SET amount_paid = amount_paid + v_amount, outstanding = outstanding - v_amount,
             status = CASE WHEN outstanding - v_amount = 0 THEN 'paid'::debt_status ELSE 'partial'::debt_status END,
             updated_at = now()
       WHERE id = v_debt_id
       RETURNING * INTO v_debt;
      IF v_sale_id IS NOT NULL THEN
        UPDATE sales SET amount_paid = amount_paid + v_amount, balance = GREATEST(balance - v_amount, 0) WHERE id = v_sale_id;
      END IF;
      v_total := v_total + v_amount;
      v_first_payment := COALESCE(v_first_payment, v_payment_id);
      v_first_receipt := COALESCE(v_first_receipt, v_receipt);
      v_results := v_results || jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt, 'amount', v_amount, 'payment_method', v_method);
    END LOOP;
    IF v_total <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;
    IF v_multi THEN RETURN jsonb_build_object('payments', v_results, 'total_amount', v_total); END IF;
    RETURN jsonb_build_object('payment_id', v_first_payment, 'receipt_number', v_first_receipt);
  END IF;

  PERFORM 1 FROM customers WHERE id = v_customer AND factory_id = v_factory FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this factory'; END IF;

  IF v_idem IS NOT NULL THEN
    SELECT payment_id INTO v_existing FROM customer_account_transactions WHERE idempotency_key = v_idem;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'payment_id', v_existing,
        'receipt_number', (SELECT receipt_number FROM payments_received WHERE id = v_existing));
    END IF;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_amount := COALESCE((v_line->>'amount')::numeric, 0);
    v_method := COALESCE((v_line->>'method')::payment_method, 'cash');
    IF v_amount <= 0 THEN CONTINUE; END IF;
    v_i := v_i + 1;

    v_receipt := public._next_receipt_number(v_factory);
    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount, v_method, v_date, v_uid, v_remarks)
    RETURNING id INTO v_payment_id;

    v_res := public._customer_receive_money(v_factory, v_customer, v_amount, v_method, v_date, v_uid,
                                            v_remarks, v_payment_id, v_receipt, v_debt_id, 'payment',
                                            CASE WHEN v_idem IS NULL THEN NULL WHEN v_i = 1 THEN v_idem ELSE v_idem || ':L' || v_i END);

    v_total := v_total + v_amount;
    v_settled := v_settled + (v_res->>'settled_debt')::numeric;
    v_credit := v_credit + (v_res->>'credit_added')::numeric;
    v_first_payment := COALESCE(v_first_payment, v_payment_id);
    v_first_receipt := COALESCE(v_first_receipt, v_receipt);
    v_results := v_results || jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt,
                                                 'amount', v_amount, 'payment_method', v_method);
  END LOOP;
  IF v_total <= 0 THEN RAISE EXCEPTION 'amount must be > 0'; END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'record_payment', 'customers', v_customer::text, NULL,
          jsonb_build_object('total', v_total, 'settled_debt', v_settled, 'credit_added', v_credit, 'receipt_number', v_first_receipt));

  IF v_multi THEN
    RETURN jsonb_build_object('payments', v_results, 'total_amount', v_total, 'settled_debt', v_settled, 'credit_added', v_credit);
  END IF;
  RETURN jsonb_build_object('payment_id', v_first_payment, 'receipt_number', v_first_receipt,
                            'settled_debt', v_settled, 'credit_added', v_credit);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_payment(jsonb) TO authenticated;

-- ============ 6. approve_sale: post SALE / ADVANCE_APPLIED / overpayment credit ============
CREATE OR REPLACE FUNCTION public.approve_sale(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
  v_item RECORD;
  v_receipt_prefix text;
  v_receipt text;
  v_pay_line jsonb;
  v_line_amount numeric;
  v_line_method payment_method;
  v_move_reason text;
  v_before numeric;
  v_customer_credit numeric;
  v_credit_to_apply numeric := 0;
  v_final_balance numeric;
  v_excess numeric := 0;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Approval must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  -- The authoritative credit draw-down: however much the customer has
  -- available right now, automatically applied to whatever cash didn't
  -- cover. Locks the customer row so a concurrent sale for the same
  -- customer can't double-spend the same credit.
  IF v_row.customer_id IS NOT NULL AND NOT v_row.is_pr THEN
    SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_row.customer_id FOR UPDATE;
    v_customer_credit := COALESCE(v_customer_credit, 0);
    v_credit_to_apply := LEAST(GREATEST(v_row.grand_total - v_row.amount_paid, 0), v_customer_credit);
  END IF;
  v_final_balance := GREATEST(v_row.grand_total - v_row.amount_paid - v_credit_to_apply, 0);

  v_move_reason := CASE WHEN v_row.is_pr THEN 'PR - complimentary, no charge' ELSE 'Sale' END;

  -- Re-validate and apply stock now, at approval time -- availability may
  -- have moved since the sale was submitted.
  FOR v_item IN SELECT si.product_id, si.quantity FROM sale_items si WHERE si.sale_id = p_id LOOP
    IF v_row.sales_rep_id IS NOT NULL THEN
      SELECT quantity INTO v_before FROM rep_stock WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      IF COALESCE(v_before,0) < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient van stock for a line on this sale (product %)', v_item.product_id;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
       WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_row.sales_rep_id, v_item.product_id, 'sold', -v_item.quantity, v_row.invoice_number, v_move_reason, v_uid, v_before, v_before - v_item.quantity);
    ELSE
      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      IF v_before IS NULL OR v_before < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for a line on this sale (product %): have %, need %', v_item.product_id, COALESCE(v_before,0), v_item.quantity;
      END IF;
      UPDATE products SET current_stock = current_stock - v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_item.product_id, 'sold', v_item.quantity, v_row.invoice_number, v_move_reason, v_uid, v_before, v_before - v_item.quantity);
    END IF;
  END LOOP;

  IF v_row.pending_payments IS NOT NULL AND jsonb_array_length(v_row.pending_payments) > 0 THEN
    FOR v_pay_line IN SELECT * FROM jsonb_array_elements(v_row.pending_payments) LOOP
      v_line_amount := (v_pay_line->>'amount')::numeric;
      v_line_method := COALESCE((v_pay_line->>'method')::payment_method, 'cash');
      IF v_line_amount IS NULL OR v_line_amount <= 0 THEN CONTINUE; END IF;

      v_receipt := public._next_receipt_number(v_row.factory_id);

      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_row.factory_id, v_receipt, v_row.customer_id, p_id, v_line_amount, v_line_method, v_row.sale_date, v_uid, 'Payment at point of sale');
    END LOOP;
  END IF;

  IF v_final_balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_row.factory_id, v_row.customer_id, p_id, v_row.sales_rep_id, v_row.grand_total, v_row.amount_paid, v_final_balance,
            CASE WHEN v_row.amount_paid > 0 OR v_credit_to_apply > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END);
  END IF;

  -- Cash alone paying more than the grand total (credit draw-down is
  -- already capped so it can never itself cause this) becomes new credit.
  v_excess := GREATEST(v_row.amount_paid - v_row.grand_total, 0);

  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_row.grand_total,
           outstanding_balance = outstanding_balance + v_final_balance,
           total_transactions = total_transactions + 1,
           credit_balance = credit_balance - v_credit_to_apply + v_excess,
           updated_at = now()
     WHERE id = v_row.customer_id;

    -- Ledger: what was sold and how it was funded, in the same transaction.
    PERFORM public._customer_ledger_post(
      v_row.factory_id, v_row.customer_id, 'SALE', 'sale', p_id, p_id, NULL, NULL,
      v_row.grand_total, v_row.amount_paid, 0, 0, v_final_balance,
      v_row.payment_method, 'Sale ' || v_row.invoice_number, NULL, NULL, NULL, v_uid);
    IF v_credit_to_apply > 0 THEN
      PERFORM public._customer_ledger_post(
        v_row.factory_id, v_row.customer_id, 'ADVANCE_APPLIED', 'sale', p_id, p_id, NULL, NULL,
        0, 0, v_credit_to_apply, -v_credit_to_apply, 0,
        NULL, 'Advance applied to ' || v_row.invoice_number, NULL, NULL, NULL, v_uid);
    END IF;
    IF v_excess > 0 THEN
      PERFORM public._customer_ledger_post(
        v_row.factory_id, v_row.customer_id, 'ADVANCE_PAYMENT', 'sale', p_id, p_id, NULL, NULL,
        0, 0, 0, v_excess, 0,
        v_row.payment_method, 'Overpayment on ' || v_row.invoice_number || ' held as credit', NULL, NULL, NULL, v_uid);
    END IF;
  END IF;

  UPDATE sales SET
    status = 'posted', approved_by = v_uid, approved_at = now(),
    credit_applied = v_credit_to_apply, balance = v_final_balance
  WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'approve', v_row.status, 'posted', p_comment);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_sale', 'sales', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'credit_applied', v_credit_to_apply, 'balance', v_final_balance));

  RETURN jsonb_build_object('sale_id', p_id, 'status', 'posted', 'credit_applied', v_credit_to_apply, 'balance', v_final_balance);
END;
$function$;

-- ============ 7. Sale reversal (delete of a posted sale): compensating entries ============
CREATE OR REPLACE FUNCTION public.approve_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_req delete_requests%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_item RECORD;
  v_before numeric;
  v_debt debts%ROWTYPE;
  v_found_debt boolean;
  v_total_collected numeric;
  v_refund numeric;
  v_orig uuid;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only an admin can approve a deletion request';
  END IF;

  SELECT * INTO v_req FROM delete_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;

  IF v_req.table_name = 'employees' THEN
    DELETE FROM employees WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'employee_documents' THEN
    DELETE FROM employee_documents WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'sales_reps' THEN
    DELETE FROM sales_reps WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'vehicles' THEN
    DELETE FROM vehicles WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'drivers' THEN
    DELETE FROM drivers WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'expenses' THEN
    DELETE FROM expenses WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'cash_transactions' THEN
    DELETE FROM cash_transactions WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'product_units' THEN
    DELETE FROM product_units WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'suppliers' THEN
    DELETE FROM suppliers WHERE id = v_req.entity_id;

  ELSIF v_req.table_name = 'sales' THEN
    SELECT * INTO v_sale FROM sales WHERE id = v_req.entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

    IF v_sale.status = 'posted' THEN
      -- Undo the stock effect applied at approve_sale() time.
      FOR v_item IN SELECT product_id, quantity FROM sale_items WHERE sale_id = v_sale.id LOOP
        IF v_sale.sales_rep_id IS NOT NULL THEN
          UPDATE rep_stock SET quantity = quantity + v_item.quantity, updated_at = now()
           WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = v_item.product_id;
          INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id)
          VALUES (v_sale.factory_id, v_sale.sales_rep_id, v_item.product_id, 'reversal', v_item.quantity, v_sale.invoice_number, 'Sale deleted', v_uid);
        ELSE
          SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
          UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
          INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
          VALUES (v_sale.factory_id, v_item.product_id, 'returned', v_item.quantity, v_sale.invoice_number, 'Sale deleted', v_uid, COALESCE(v_before,0), COALESCE(v_before,0) + v_item.quantity);
        END IF;
      END LOOP;

      -- Refund everything ever actually collected for this sale (register
      -- payments + any later installments against its debt) plus whatever
      -- credit balance was applied to it, back to the customer's credit --
      -- nothing is handed back out of a till here, it just becomes
      -- available to them again.
      SELECT COALESCE(SUM(amount), 0) INTO v_total_collected FROM payments_received WHERE sale_id = v_sale.id;
      v_refund := v_total_collected + v_sale.credit_applied;

      IF v_sale.customer_id IS NOT NULL THEN
        PERFORM 1 FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
      END IF;

      SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale.id FOR UPDATE;
      v_found_debt := FOUND;
      IF v_found_debt THEN
        DELETE FROM debts WHERE id = v_debt.id;
      END IF;

      IF v_sale.customer_id IS NOT NULL THEN
        UPDATE customers SET
          total_purchases = GREATEST(total_purchases - v_sale.grand_total, 0),
          outstanding_balance = GREATEST(outstanding_balance - COALESCE(v_debt.outstanding, 0), 0),
          total_transactions = GREATEST(total_transactions - 1, 0),
          credit_balance = credit_balance + v_refund,
          updated_at = now()
        WHERE id = v_sale.customer_id;

        -- Ledger: compensating entries only; the original SALE / ADVANCE_APPLIED
        -- rows are never edited.
        SELECT id INTO v_orig FROM customer_account_transactions
         WHERE txn_type = 'SALE' AND reference_type = 'sale' AND reference_id = v_sale.id;

        PERFORM public._customer_ledger_post(
          v_sale.factory_id, v_sale.customer_id, 'REVERSAL', 'sale', v_sale.id, v_sale.id, NULL, v_debt.id,
          v_sale.grand_total, 0, 0, 0, -COALESCE(v_debt.outstanding, 0),
          NULL, 'Reversal of sale ' || v_sale.invoice_number, v_req.reason, v_orig, NULL, v_uid);
        IF v_sale.credit_applied > 0 THEN
          PERFORM public._customer_ledger_post(
            v_sale.factory_id, v_sale.customer_id, 'ADVANCE_RESTORED', 'sale', v_sale.id, v_sale.id, NULL, NULL,
            0, 0, v_sale.credit_applied, v_sale.credit_applied, 0,
            NULL, 'Advance restored from reversed sale ' || v_sale.invoice_number, v_req.reason, NULL, NULL, v_uid);
        END IF;
        IF v_total_collected > 0 THEN
          PERFORM public._customer_ledger_post(
            v_sale.factory_id, v_sale.customer_id, 'REVERSAL', 'sale_payments', v_sale.id, v_sale.id, NULL, NULL,
            0, v_total_collected, 0, v_total_collected, 0,
            NULL, 'Payments on reversed sale ' || v_sale.invoice_number || ' returned to account credit', v_req.reason, NULL, NULL, v_uid);
        END IF;
      END IF;
    END IF;

    -- Soft delete either way: 30-day retention, restorable from the
    -- Deleted Sales admin tab (see 20260923130000_...).
    UPDATE sales SET deleted_at = now() WHERE id = v_req.entity_id;
  ELSE
    RAISE EXCEPTION 'Unsupported table for delete requests: %', v_req.table_name;
  END IF;

  UPDATE delete_requests SET review_status = 'approved', reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;

  INSERT INTO notifications(user_id, factory_id, title, body)
  VALUES (v_req.requested_by, v_req.factory_id, 'Deletion approved',
          initcap(replace(v_req.table_name, '_', ' ')) || ' "' || v_req.entity_label || '" was deleted.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'approve_delete', v_req.table_name, v_req.entity_id::text,
          jsonb_build_object('label', v_req.entity_label, 'reason', v_req.reason, 'requested_by', v_req.requested_by),
          jsonb_build_object('deleted', true));

  RETURN jsonb_build_object('approved', true, 'payload', v_req.payload);
END;
$function$;

-- ============ 8. reverse_payment: undo exactly what the payment did ============
CREATE OR REPLACE FUNCTION public.reverse_payment(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row payments_received%ROWTYPE;
  v_uid uuid := auth.uid();
  v_debt debts%ROWTYPE;
  v_led customer_account_transactions%ROWTYPE;
  v_has_ledger boolean;
  v_applied numeric;
  v_credit_cache numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  SELECT EXISTS (
    SELECT 1 FROM customer_account_transactions
     WHERE payment_id = p_id AND txn_type IN ('DEBT_SETTLEMENT','ADVANCE_PAYMENT','CUSTOMER_PAYMENT')
  ) INTO v_has_ledger;

  IF v_has_ledger AND v_row.customer_id IS NOT NULL THEN
    -- Ledger-aware path: reverse each allocation the payment made, newest first.
    PERFORM 1 FROM customers WHERE id = v_row.customer_id FOR UPDATE;

    FOR v_led IN
      SELECT * FROM customer_account_transactions
       WHERE payment_id = p_id AND txn_type IN ('DEBT_SETTLEMENT','ADVANCE_PAYMENT','CUSTOMER_PAYMENT')
       ORDER BY seq DESC
    LOOP
      IF v_led.txn_type = 'DEBT_SETTLEMENT' THEN
        v_applied := v_led.cash_paid;
        SELECT * INTO v_debt FROM debts WHERE id = v_led.debt_id FOR UPDATE;
        IF FOUND THEN
          UPDATE debts SET
            amount_paid = GREATEST(amount_paid - v_applied, 0),
            outstanding = LEAST(outstanding + v_applied, total_amount),
            status = CASE WHEN amount_paid - v_applied <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
            updated_at = now()
          WHERE id = v_debt.id;
          IF v_debt.sale_id IS NOT NULL THEN
            UPDATE sales SET amount_paid = GREATEST(amount_paid - v_applied, 0), balance = balance + v_applied
             WHERE id = v_debt.sale_id;
          END IF;
        END IF;
        UPDATE customers SET outstanding_balance = outstanding_balance + v_applied, updated_at = now()
         WHERE id = v_row.customer_id;
        PERFORM public._customer_ledger_post(
          v_row.factory_id, v_row.customer_id, 'REVERSAL', 'payment_reversal', p_id, v_led.sale_id, p_id, v_led.debt_id,
          0, 0, 0, 0, -v_led.debt_delta,
          v_row.payment_method, 'Reversal of ' || v_row.receipt_number || ' (debt settlement)', p_reason, v_led.id, NULL, v_uid);
      ELSE
        SELECT credit_balance INTO v_credit_cache FROM customers WHERE id = v_row.customer_id;
        IF COALESCE(v_credit_cache, 0) < v_led.credit_delta THEN
          RAISE EXCEPTION 'Cannot reverse: part of this payment (%) has already been used by the customer', v_led.credit_delta;
        END IF;
        UPDATE customers SET credit_balance = credit_balance - v_led.credit_delta, updated_at = now()
         WHERE id = v_row.customer_id;
        PERFORM public._customer_ledger_post(
          v_row.factory_id, v_row.customer_id, 'REVERSAL', 'payment_reversal', p_id, NULL, p_id, NULL,
          0, 0, 0, -v_led.credit_delta, 0,
          v_row.payment_method, 'Reversal of ' || v_row.receipt_number || ' (credit removed)', p_reason, v_led.id, NULL, v_uid);
      END IF;
    END LOOP;
  ELSE
    -- Payments recorded before the ledger existed: original behaviour.
    IF v_row.sale_id IS NOT NULL THEN
      SELECT * INTO v_debt FROM debts WHERE sale_id = v_row.sale_id FOR UPDATE;
      IF FOUND THEN
        UPDATE debts SET
          amount_paid = GREATEST(amount_paid - v_row.amount, 0),
          outstanding = LEAST(outstanding + v_row.amount, total_amount),
          status = CASE WHEN amount_paid - v_row.amount <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
          updated_at = now()
        WHERE id = v_debt.id;
      END IF;
      UPDATE sales SET amount_paid = GREATEST(amount_paid - v_row.amount, 0), balance = balance + v_row.amount WHERE id = v_row.sale_id;
    END IF;
    IF v_row.customer_id IS NOT NULL THEN
      UPDATE customers SET outstanding_balance = outstanding_balance + v_row.amount, updated_at = now()
      WHERE id = v_row.customer_id;
      PERFORM public._customer_ledger_post(
        v_row.factory_id, v_row.customer_id, 'REVERSAL', 'payment_reversal', p_id, v_row.sale_id, p_id, NULL,
        0, 0, 0, 0, v_row.amount,
        v_row.payment_method, 'Reversal of ' || v_row.receipt_number, p_reason, NULL, NULL, v_uid);
    END IF;
  END IF;

  UPDATE payments_received SET status = 'reversed', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('payments', p_id, 'reverse', v_row.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status, 'amount', v_row.amount),
          jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $function$;

-- ============ 9. Debt write-off / its reversal keep the ledger in step ============
CREATE OR REPLACE FUNCTION public.post_debt_writeoff(p_debt_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_written_off numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  -- Lock order: customer before debt (same as payments and sales).
  PERFORM 1 FROM customers WHERE id = (SELECT customer_id FROM debts WHERE id = p_debt_id) FOR UPDATE;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'posted');

  v_written_off := v_debt.outstanding;
  UPDATE debts SET amount_paid = total_amount, outstanding = 0, status = 'paid', updated_at = now(),
    writeoff_status = 'posted', writeoff_amount = v_written_off
  WHERE id = p_debt_id;
  IF v_debt.customer_id IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = v_debt.customer_id FOR UPDATE;
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_written_off, 0), updated_at = now() WHERE id = v_debt.customer_id;
    PERFORM public._customer_ledger_post(
      v_debt.factory_id, v_debt.customer_id, 'CREDIT_ADJUSTMENT', 'debt_writeoff', p_debt_id, v_debt.sale_id, NULL, p_debt_id,
      0, 0, 0, 0, -v_written_off,
      NULL, 'Debt written off', p_comment, NULL, NULL, v_uid);
  END IF;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'post', v_debt.writeoff_status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'post_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('outstanding', v_debt.outstanding, 'status', v_debt.status),
          jsonb_build_object('outstanding', 0, 'status', 'paid', 'written_off', v_written_off));
  RETURN jsonb_build_object('closed', true, 'written_off', v_written_off);
END; $function$;

CREATE OR REPLACE FUNCTION public.reverse_debt_writeoff(p_debt_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_orig uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a write-off'; END IF;
  PERFORM 1 FROM customers WHERE id = (SELECT customer_id FROM debts WHERE id = p_debt_id) FOR UPDATE;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'reversed');
  IF v_debt.writeoff_amount IS NULL THEN RAISE EXCEPTION 'No recorded write-off amount to reverse'; END IF;

  UPDATE debts SET
    amount_paid = GREATEST(amount_paid - v_debt.writeoff_amount, 0),
    outstanding = outstanding + v_debt.writeoff_amount,
    status = CASE WHEN amount_paid - v_debt.writeoff_amount <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
    updated_at = now(), writeoff_status = 'reversed'
  WHERE id = p_debt_id;
  IF v_debt.customer_id IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = v_debt.customer_id FOR UPDATE;
    UPDATE customers SET outstanding_balance = outstanding_balance + v_debt.writeoff_amount, updated_at = now() WHERE id = v_debt.customer_id;
    SELECT id INTO v_orig FROM customer_account_transactions
     WHERE txn_type = 'CREDIT_ADJUSTMENT' AND reference_type = 'debt_writeoff' AND reference_id = p_debt_id;
    PERFORM public._customer_ledger_post(
      v_debt.factory_id, v_debt.customer_id, 'REVERSAL', 'debt_writeoff_reversal', p_debt_id, v_debt.sale_id, NULL, p_debt_id,
      0, 0, 0, 0, v_debt.writeoff_amount,
      NULL, 'Debt write-off reversed', p_reason, v_orig, NULL, v_uid);
  END IF;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'reverse', v_debt.writeoff_status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'reverse_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('status', 'paid', 'outstanding', 0),
          jsonb_build_object('status', 'reversed', 'restored', v_debt.writeoff_amount, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true, 'restored', v_debt.writeoff_amount);
END; $function$;

-- ============ 10. Manual adjustments: maker-checker ============
INSERT INTO public.workflow_configs (module, transaction_type, maker_label, checker_label, final_status, required_approvals, description)
VALUES ('customers', 'customer_account_adjustment', 'Accountant', 'Chairman', 'posted', 1,
        'Manual correction to a customer''s credit or debt, submitted with a reason and approved before it touches the account.')
ON CONFLICT (module) DO NOTHING;

INSERT INTO public.role_permissions (role, module, action) VALUES
  ('accountant', 'customers', 'submit'),
  ('accountant', 'customers', 'cancel')
ON CONFLICT (role, module, action) DO NOTHING;

CREATE TABLE public.customer_account_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  effect text NOT NULL CHECK (effect IN ('credit_up','credit_down','debt_up','debt_down','refund')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  payment_method public.payment_method,
  status public.workflow_status NOT NULL DEFAULT 'pending_approval',
  submitted_by uuid NOT NULL REFERENCES auth.users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  ledger_txn_id uuid
);
CREATE INDEX idx_caa_customer ON public.customer_account_adjustments (customer_id, submitted_at);
CREATE INDEX idx_caa_status ON public.customer_account_adjustments (factory_id, status);

ALTER TABLE public.customer_account_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_account_adjustments FROM anon, authenticated;
GRANT SELECT ON public.customer_account_adjustments TO authenticated;
GRANT ALL ON public.customer_account_adjustments TO service_role;
CREATE POLICY "customer adjustments read" ON public.customer_account_adjustments FOR SELECT TO authenticated
  USING (submitted_by = auth.uid() OR public.has_permission(auth.uid(), 'customers'::module_key, 'view'::action_key));

CREATE OR REPLACE FUNCTION public.request_customer_adjustment(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_effect text := payload->>'effect';
  v_amount numeric := COALESCE((payload->>'amount')::numeric, 0);
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason','')), '');
  v_method payment_method := NULLIF(payload->>'payment_method','')::payment_method;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'customers'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL OR v_customer IS NULL THEN RAISE EXCEPTION 'factory_id and customer_id are required'; END IF;
  IF v_effect NOT IN ('credit_up','credit_down','debt_up','debt_down','refund') THEN RAISE EXCEPTION 'Invalid adjustment type'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF v_effect = 'refund' AND v_method IS NULL THEN RAISE EXCEPTION 'A payment method is required for a refund'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = v_customer AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Customer not found for this factory';
  END IF;

  INSERT INTO customer_account_adjustments(factory_id, customer_id, effect, amount, reason, payment_method, submitted_by)
  VALUES (v_factory, v_customer, v_effect, v_amount, v_reason, v_method, v_uid)
  RETURNING id INTO v_id;

  PERFORM public.record_workflow_action('customers', v_id, 'submit', NULL, 'pending_approval', v_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'request_customer_adjustment', 'customers', v_customer::text, NULL,
          jsonb_build_object('adjustment_id', v_id, 'effect', v_effect, 'amount', v_amount, 'reason', v_reason));
  RETURN jsonb_build_object('adjustment_id', v_id, 'status', 'pending_approval');
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_customer_adjustment(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_customer_adjustment(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_adj customer_account_adjustments%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_debt debts%ROWTYPE;
  v_remaining numeric;
  v_take numeric;
  v_prev jsonb;
  v_type text;
  v_credit_delta numeric := 0;
  v_debt_delta numeric := 0;
  v_txn uuid;
  v_new_debt uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'customers'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_adj FROM customer_account_adjustments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Adjustment not found'; END IF;
  IF v_adj.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve an adjustment you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_adj.status, 'posted');

  SELECT * INTO v_cust FROM customers WHERE id = v_adj.customer_id FOR UPDATE;
  v_prev := jsonb_build_object('credit_balance', v_cust.credit_balance, 'outstanding_balance', v_cust.outstanding_balance);

  IF v_adj.effect IN ('credit_down','refund') THEN
    IF v_cust.credit_balance < v_adj.amount THEN
      RAISE EXCEPTION 'Customer only has % of credit available', v_cust.credit_balance;
    END IF;
    v_credit_delta := -v_adj.amount;
    UPDATE customers SET credit_balance = credit_balance - v_adj.amount, updated_at = now() WHERE id = v_cust.id;
  ELSIF v_adj.effect = 'credit_up' THEN
    v_credit_delta := v_adj.amount;
    UPDATE customers SET credit_balance = credit_balance + v_adj.amount, updated_at = now() WHERE id = v_cust.id;
  ELSIF v_adj.effect = 'debt_down' THEN
    IF v_cust.outstanding_balance < v_adj.amount THEN
      RAISE EXCEPTION 'Customer only owes %', v_cust.outstanding_balance;
    END IF;
    v_debt_delta := -v_adj.amount;
    -- Forgive oldest debts first, keeping the per-invoice debts in step.
    v_remaining := v_adj.amount;
    FOR v_debt IN
      SELECT * FROM debts WHERE customer_id = v_cust.id AND factory_id = v_adj.factory_id
         AND outstanding > 0 AND status <> 'paid'
       ORDER BY created_at, id FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, v_debt.outstanding);
      UPDATE debts SET amount_paid = amount_paid + v_take, outstanding = outstanding - v_take,
             status = CASE WHEN outstanding - v_take = 0 THEN 'paid'::debt_status ELSE 'partial'::debt_status END,
             updated_at = now()
       WHERE id = v_debt.id;
      IF v_debt.sale_id IS NOT NULL THEN
        UPDATE sales SET balance = GREATEST(balance - v_take, 0) WHERE id = v_debt.sale_id;
      END IF;
      v_remaining := v_remaining - v_take;
    END LOOP;
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_adj.amount, 0), updated_at = now() WHERE id = v_cust.id;
  ELSIF v_adj.effect = 'debt_up' THEN
    v_debt_delta := v_adj.amount;
    INSERT INTO debts(factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_adj.factory_id, v_cust.id, NULL, v_adj.amount, 0, v_adj.amount, 'unpaid')
    RETURNING id INTO v_new_debt;
    UPDATE customers SET outstanding_balance = outstanding_balance + v_adj.amount, updated_at = now() WHERE id = v_cust.id;
  END IF;

  v_type := CASE v_adj.effect
              WHEN 'refund' THEN 'REFUND'
              WHEN 'credit_up' THEN 'CREDIT_ADJUSTMENT'
              WHEN 'debt_down' THEN 'CREDIT_ADJUSTMENT'
              ELSE 'DEBIT_ADJUSTMENT' END;
  v_txn := public._customer_ledger_post(
    v_adj.factory_id, v_cust.id, v_type, 'adjustment', v_adj.id, NULL, NULL, v_new_debt,
    0, 0, 0, v_credit_delta, v_debt_delta,
    v_adj.payment_method,
    CASE v_adj.effect
      WHEN 'credit_up' THEN 'Credit added by adjustment'
      WHEN 'credit_down' THEN 'Credit reduced by adjustment'
      WHEN 'debt_up' THEN 'Debt added by adjustment'
      WHEN 'debt_down' THEN 'Debt reduced by adjustment'
      ELSE 'Refund to customer' END,
    v_adj.reason, NULL, NULL, v_uid);

  UPDATE customer_account_adjustments
     SET status = 'posted', reviewed_by = v_uid, reviewed_at = now(), review_note = p_comment, ledger_txn_id = v_txn
   WHERE id = p_id;
  PERFORM public.record_workflow_action('customers', p_id, 'approve', v_adj.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_adj.factory_id, 'approve_customer_adjustment', 'customers', v_cust.id::text, v_prev,
          jsonb_build_object('adjustment_id', p_id, 'effect', v_adj.effect, 'amount', v_adj.amount, 'reason', v_adj.reason));
  RETURN jsonb_build_object('adjustment_id', p_id, 'status', 'posted', 'ledger_txn_id', v_txn);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_customer_adjustment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_customer_adjustment(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid(); v_adj customer_account_adjustments%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'customers'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT * INTO v_adj FROM customer_account_adjustments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Adjustment not found'; END IF;
  IF v_adj.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject an adjustment you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_adj.status, 'rejected');
  UPDATE customer_account_adjustments SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('customers', p_id, 'reject', v_adj.status, 'rejected', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_adj.factory_id, 'reject_customer_adjustment', 'customers', v_adj.customer_id::text, NULL,
          jsonb_build_object('adjustment_id', p_id, 'reason', p_reason));
  RETURN jsonb_build_object('adjustment_id', p_id, 'status', 'rejected');
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_customer_adjustment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_customer_adjustment(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid(); v_adj customer_account_adjustments%ROWTYPE;
BEGIN
  SELECT * INTO v_adj FROM customer_account_adjustments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Adjustment not found'; END IF;
  IF NOT (v_adj.submitted_by = v_uid OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only the submitter or an admin can cancel this adjustment';
  END IF;
  PERFORM public.assert_valid_transition(v_adj.status, 'cancelled');
  UPDATE customer_account_adjustments SET status = 'cancelled', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('customers', p_id, 'cancel', v_adj.status, 'cancelled', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_adj.factory_id, 'cancel_customer_adjustment', 'customers', v_adj.customer_id::text, NULL,
          jsonb_build_object('adjustment_id', p_id, 'reason', p_reason));
  RETURN jsonb_build_object('adjustment_id', p_id, 'status', 'cancelled');
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_customer_adjustment(uuid, text) TO authenticated;

-- ============ 11. Status labels, summary view, reconciliation ============
CREATE OR REPLACE FUNCTION public.customer_account_status(p_credit numeric, p_debt numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN COALESCE(p_debt, 0) > 0 AND COALESCE(p_credit, 0) > 0 THEN 'CREDIT AND DEBT'
    WHEN COALESCE(p_debt, 0) > 0 THEN 'OUTSTANDING DEBT'
    WHEN COALESCE(p_credit, 0) > 0 THEN 'CREDIT BALANCE'
    ELSE 'BALANCED' END
$$;

CREATE OR REPLACE FUNCTION public.sale_payment_status(
  p_status text, p_is_pr boolean, p_amount_paid numeric, p_credit_applied numeric, p_balance numeric
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN COALESCE(p_is_pr, false) THEN 'COMPLIMENTARY'
    WHEN p_status <> 'posted' THEN upper(replace(p_status, '_', ' '))
    WHEN COALESCE(p_balance, 0) <= 0 AND COALESCE(p_credit_applied, 0) > 0 AND COALESCE(p_amount_paid, 0) <= 0 THEN 'PAID VIA CUSTOMER ADVANCE'
    WHEN COALESCE(p_balance, 0) <= 0 THEN 'PAID'
    WHEN COALESCE(p_amount_paid, 0) > 0 OR COALESCE(p_credit_applied, 0) > 0 THEN 'PARTIALLY PAID'
    ELSE 'UNPAID' END
$$;

CREATE OR REPLACE VIEW public.customer_account_summary WITH (security_invoker = true) AS
SELECT
  c.id AS customer_id,
  c.factory_id,
  c.name AS customer_name,
  COALESCE(l.credit_after, 0) AS available_advance,
  COALESCE(l.debt_after, 0) AS outstanding_debt,
  public.customer_account_status(COALESCE(l.credit_after, 0), COALESCE(l.debt_after, 0)) AS account_status,
  COALESCE(a.total_advance_paid, 0) AS total_advance_paid,
  COALESCE(a.advance_used, 0) AS advance_used,
  COALESCE(a.goods_collected, 0) AS goods_collected,
  COALESCE(a.opening_credit, 0) AS opening_credit,
  COALESCE(a.opening_debt, 0) AS opening_debt,
  COALESCE(p.total_payments, 0) AS total_payments,
  a.last_advance_at,
  l.created_at AS last_transaction_at
FROM public.customers c
LEFT JOIN LATERAL (
  SELECT credit_after, debt_after, created_at
    FROM public.customer_account_transactions WHERE customer_id = c.id ORDER BY seq DESC LIMIT 1
) l ON true
LEFT JOIN LATERAL (
  SELECT
    SUM(credit_delta) FILTER (WHERE (txn_type IN ('ADVANCE_PAYMENT','CUSTOMER_PAYMENT') AND credit_delta > 0)
                                 OR (txn_type = 'REVERSAL' AND reference_type = 'payment_reversal' AND credit_delta < 0)) AS total_advance_paid,
    -(COALESCE(SUM(credit_delta) FILTER (WHERE txn_type = 'ADVANCE_APPLIED'), 0)
      + COALESCE(SUM(credit_delta) FILTER (WHERE txn_type = 'ADVANCE_RESTORED'), 0)) AS advance_used,
    COALESCE(SUM(goods_value) FILTER (WHERE txn_type = 'SALE'), 0)
      - COALESCE(SUM(goods_value) FILTER (WHERE txn_type = 'REVERSAL' AND reference_type = 'sale'), 0) AS goods_collected,
    SUM(credit_delta) FILTER (WHERE txn_type = 'OPENING_BALANCE') AS opening_credit,
    SUM(debt_delta) FILTER (WHERE txn_type = 'OPENING_BALANCE') AS opening_debt,
    MAX(created_at) FILTER (WHERE txn_type = 'ADVANCE_PAYMENT') AS last_advance_at
  FROM public.customer_account_transactions WHERE customer_id = c.id
) a ON true
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS total_payments FROM public.payments_received
   WHERE customer_id = c.id AND status NOT IN ('rejected','reversed')
) p ON true;
GRANT SELECT ON public.customer_account_summary TO authenticated;

-- Cache vs ledger vs per-invoice debts. Only rows that disagree are returned.
CREATE OR REPLACE FUNCTION public.reconcile_customer_account(p_customer uuid DEFAULT NULL)
RETURNS TABLE(customer_id uuid, customer_name text,
              cache_credit numeric, ledger_credit numeric,
              cache_debt numeric, ledger_debt numeric, invoice_debts numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'customers'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT c.id, c.name, c.credit_balance, COALESCE(l.credit_after, 0),
         c.outstanding_balance, COALESCE(l.debt_after, 0),
         COALESCE((SELECT SUM(d.outstanding) FROM debts d WHERE d.customer_id = c.id), 0)
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT credit_after, debt_after FROM customer_account_transactions t
       WHERE t.customer_id = c.id ORDER BY t.seq DESC LIMIT 1
    ) l ON true
   WHERE (p_customer IS NULL OR c.id = p_customer)
     AND (c.credit_balance <> COALESCE(l.credit_after, 0)
       OR c.outstanding_balance <> COALESCE(l.debt_after, 0)
       OR c.outstanding_balance <> COALESCE((SELECT SUM(d.outstanding) FROM debts d WHERE d.customer_id = c.id), 0));
END;
$$;
GRANT EXECUTE ON FUNCTION public.reconcile_customer_account(uuid) TO authenticated;

-- ============ 12. Realtime ============
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'customer_account_transactions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_account_transactions;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'customer_account_adjustments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_account_adjustments;
  END IF;
END $$;
