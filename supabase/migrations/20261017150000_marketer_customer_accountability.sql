-- ============================================================================
-- Marketer customer accounts, debt tracking, daily accountability, statements
-- ----------------------------------------------------------------------------
-- Builds on what already exists rather than duplicating it:
--   customers.sales_rep_id          the marketer a customer belongs to
--   sales / sale_items              invoices at their original prices
--   debts + debt_payments           per-invoice outstanding and payments
--   payments_received               every receipt (reference, date, method)
--   customer_account_transactions   the append-only customer ledger; its
--                                   DEBT_SETTLEMENT rows are the payment
--                                   allocation history (payment -> debt -> sale)
--   rep_stock_movements             the marketer's physical stock trail
--   rep_remittances                 money the marketer hands in
--
-- Added here:
--   1. sales_reps.territory; customers.status (active/dormant) and notes.
--   2. Ownership stamps. sales / debts / payments_received.account_rep_id is
--      the marketer a transaction belongs to, fixed when it is recorded:
--        sale     the marketer who sold it from their stock, else the
--                 customer's marketer at the time
--        debt     its sale's marketer (opening/adjustment debts: the
--                 customer's marketer at the time)
--        payment  the marketer who collected it, else its sale's marketer,
--                 else the customer's marketer at the time
--      Reassigning a customer later does NOT move history: reports read these
--      stamps, so every invoice, debt and payment has exactly one marketer and
--      nothing is counted twice. payments_received.at_point_of_sale marks the
--      receipts approve_sale writes for money paid with the sale.
--   3. customer_marketer_history: every marketer (re)assignment, who, when,
--      why. reassign_customer_marketer() requires a reason.
--   4. Duplicate-customer guard: two registered customers of a factory may
--      not share a phone number (compared as digits, +234 = 0).
--   5. customer_followups: notes and follow-ups on a customer.
--   6. marketer_day_closes: end-of-day reconciliation snapshots, immutable.
--   7. Read RPCs for the marketer profile / customer pages and statements.
--   8. Roles: 'marketer' (sees only their own account, through the RPCs)
--      and 'auditor' (read-only).
--
-- Access: every RPC checks permission on the server. A marketer user
-- (sales_reps.user_id = auth.uid()) can read only their own account and
-- customers. Commission is deliberately NOT calculated here: the figures it
-- will need (units and value per product, cash vs credit, collections,
-- remittances) are exposed so a configurable rule can be added later.
-- ============================================================================

-- ============ 1. Profile fields ============
ALTER TABLE public.sales_reps ADD COLUMN IF NOT EXISTS territory text;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_status_check CHECK (status IN ('active','dormant'));
GRANT INSERT (status, notes) ON public.customers TO authenticated;
GRANT UPDATE (status, notes) ON public.customers TO authenticated;

-- ============ 2. Access helpers ============
-- The signed-in user is this marketer (their login is linked on the rep).
CREATE OR REPLACE FUNCTION public._is_own_marketer(p_rep uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM sales_reps WHERE id = p_rep AND user_id = auth.uid())
$$;
REVOKE ALL ON FUNCTION public._is_own_marketer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_own_marketer(uuid) TO authenticated;

-- May the caller see this marketer's account? p_money = the money side
-- (sales values, debts, payments). Without it, stock accountability only,
-- which Distribution (Warehouse) users may also see.
CREATE OR REPLACE FUNCTION public._marketer_can_view(p_rep uuid, p_money boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  IF public._is_own_marketer(p_rep) THEN RETURN true; END IF;
  IF public.has_permission(v_uid, 'marketer-accounts'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'finance'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'payments'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'debts'::module_key, 'view'::action_key) THEN
    RETURN true;
  END IF;
  RETURN NOT p_money AND public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key);
END;
$$;
REVOKE ALL ON FUNCTION public._marketer_can_view(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._marketer_can_view(uuid, boolean) TO authenticated;

-- May the caller see this customer's account?
CREATE OR REPLACE FUNCTION public._customer_can_view(p_customer uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  IF public.has_permission(v_uid, 'marketer-accounts'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'customers'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'finance'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'payments'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'debts'::module_key, 'view'::action_key) THEN
    RETURN true;
  END IF;
  -- A marketer: their own assigned customers, or anyone they sold to.
  RETURN EXISTS (SELECT 1 FROM customers c JOIN sales_reps r ON r.id = c.sales_rep_id
                  WHERE c.id = p_customer AND r.user_id = v_uid)
      OR EXISTS (SELECT 1 FROM sales s JOIN sales_reps r ON r.id = s.sales_rep_id
                  WHERE s.customer_id = p_customer AND r.user_id = v_uid AND s.deleted_at IS NULL);
END;
$$;
REVOKE ALL ON FUNCTION public._customer_can_view(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._customer_can_view(uuid) TO authenticated;

-- A marketer user reads their own rep row and own customers directly too.
DROP POLICY IF EXISTS "sales reps read own" ON public.sales_reps;
CREATE POLICY "sales reps read own" ON public.sales_reps FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "customers read own marketer" ON public.customers;
CREATE POLICY "customers read own marketer" ON public.customers FOR SELECT TO authenticated
  USING (sales_rep_id IN (SELECT id FROM public.sales_reps WHERE user_id = auth.uid()));

-- ============ 3. Ownership stamps ============
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS account_rep_id uuid REFERENCES public.sales_reps(id);
ALTER TABLE public.debts ADD COLUMN IF NOT EXISTS account_rep_id uuid REFERENCES public.sales_reps(id);
ALTER TABLE public.payments_received
  ADD COLUMN IF NOT EXISTS account_rep_id uuid REFERENCES public.sales_reps(id),
  ADD COLUMN IF NOT EXISTS at_point_of_sale boolean NOT NULL DEFAULT false;

-- Sales: set on insert; follows edits only while the sale is not yet posted.
CREATE OR REPLACE FUNCTION public._sales_stamp_account_rep()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    NEW.account_rep_id := OLD.account_rep_id;
    RETURN NEW;
  END IF;
  NEW.account_rep_id := COALESCE(NEW.sales_rep_id,
    (SELECT sales_rep_id FROM customers WHERE id = NEW.customer_id));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sales_stamp_account_rep ON public.sales;
CREATE TRIGGER trg_sales_stamp_account_rep BEFORE INSERT OR UPDATE OF sales_rep_id, customer_id, status, account_rep_id
  ON public.sales FOR EACH ROW EXECUTE FUNCTION public._sales_stamp_account_rep();

CREATE OR REPLACE FUNCTION public._debts_stamp_account_rep()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.account_rep_id := OLD.account_rep_id;
    RETURN NEW;
  END IF;
  NEW.account_rep_id := COALESCE(
    (SELECT account_rep_id FROM sales WHERE id = NEW.sale_id),
    NEW.sales_rep_id,
    (SELECT sales_rep_id FROM customers WHERE id = NEW.customer_id));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_debts_stamp_account_rep ON public.debts;
CREATE TRIGGER trg_debts_stamp_account_rep BEFORE INSERT OR UPDATE OF account_rep_id
  ON public.debts FOR EACH ROW EXECUTE FUNCTION public._debts_stamp_account_rep();

-- approve_sale writes the point-of-sale receipts while the sale is still
-- pending (it is posted afterwards); record_payment only accepts posted sales.
-- So "the sale is not posted yet" identifies money paid with the sale.
CREATE OR REPLACE FUNCTION public._payments_stamp_account_rep()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sale sales%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.account_rep_id := OLD.account_rep_id;
    NEW.at_point_of_sale := OLD.at_point_of_sale;
    RETURN NEW;
  END IF;
  IF NEW.sale_id IS NOT NULL THEN
    SELECT * INTO v_sale FROM sales WHERE id = NEW.sale_id;
  END IF;
  NEW.at_point_of_sale := v_sale.id IS NOT NULL AND v_sale.status <> 'posted';
  NEW.account_rep_id := COALESCE(NEW.collected_by_rep, v_sale.account_rep_id,
    (SELECT sales_rep_id FROM customers WHERE id = NEW.customer_id));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_payments_stamp_account_rep ON public.payments_received;
CREATE TRIGGER trg_payments_stamp_account_rep BEFORE INSERT OR UPDATE OF account_rep_id, at_point_of_sale
  ON public.payments_received FOR EACH ROW EXECUTE FUNCTION public._payments_stamp_account_rep();

-- Backfill existing history (customer's current marketer is the best record
-- of who owned older transactions). Triggers are bypassed for the backfill.
ALTER TABLE public.sales DISABLE TRIGGER trg_sales_stamp_account_rep;
UPDATE public.sales s SET account_rep_id = COALESCE(s.sales_rep_id, c.sales_rep_id)
  FROM public.customers c WHERE c.id = s.customer_id AND s.account_rep_id IS NULL;
UPDATE public.sales s SET account_rep_id = s.sales_rep_id
 WHERE s.account_rep_id IS NULL AND s.sales_rep_id IS NOT NULL;
ALTER TABLE public.sales ENABLE TRIGGER trg_sales_stamp_account_rep;

ALTER TABLE public.debts DISABLE TRIGGER trg_debts_stamp_account_rep;
UPDATE public.debts d SET account_rep_id = COALESCE(
    (SELECT s.account_rep_id FROM public.sales s WHERE s.id = d.sale_id),
    d.sales_rep_id,
    (SELECT c.sales_rep_id FROM public.customers c WHERE c.id = d.customer_id))
 WHERE d.account_rep_id IS NULL;
ALTER TABLE public.debts ENABLE TRIGGER trg_debts_stamp_account_rep;

ALTER TABLE public.payments_received DISABLE TRIGGER trg_payments_stamp_account_rep;
UPDATE public.payments_received p SET
    at_point_of_sale = (p.sale_id IS NOT NULL AND p.remarks = 'Payment at point of sale'),
    account_rep_id = COALESCE(p.collected_by_rep,
      (SELECT s.account_rep_id FROM public.sales s WHERE s.id = p.sale_id),
      (SELECT c.sales_rep_id FROM public.customers c WHERE c.id = p.customer_id))
 WHERE p.account_rep_id IS NULL;
ALTER TABLE public.payments_received ENABLE TRIGGER trg_payments_stamp_account_rep;

CREATE INDEX IF NOT EXISTS idx_sales_account_rep ON public.sales (account_rep_id, sale_date) WHERE account_rep_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_debts_account_rep ON public.debts (account_rep_id) WHERE account_rep_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_account_rep ON public.payments_received (account_rep_id, payment_date) WHERE account_rep_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rep_remittances_rep ON public.rep_remittances (sales_rep_id, remittance_date);

-- The stamps are system-maintained, never typed in.
REVOKE INSERT (account_rep_id), UPDATE (account_rep_id) ON public.sales FROM authenticated, anon;
REVOKE INSERT (account_rep_id), UPDATE (account_rep_id) ON public.debts FROM authenticated, anon;
REVOKE INSERT (account_rep_id, at_point_of_sale), UPDATE (account_rep_id, at_point_of_sale)
  ON public.payments_received FROM authenticated, anon;

-- ============ 4. Marketer assignment history ============
CREATE TABLE IF NOT EXISTS public.customer_marketer_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  from_rep_id uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  to_rep_id uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  reason text,
  changed_by uuid REFERENCES auth.users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cmh_customer ON public.customer_marketer_history (customer_id, changed_at);
GRANT SELECT ON public.customer_marketer_history TO authenticated;
GRANT ALL ON public.customer_marketer_history TO service_role;
ALTER TABLE public.customer_marketer_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer marketer history read" ON public.customer_marketer_history;
CREATE POLICY "customer marketer history read" ON public.customer_marketer_history FOR SELECT TO authenticated
  USING (public._customer_can_view(customer_id));

CREATE OR REPLACE FUNCTION public._customers_log_marketer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_reason text := NULLIF(current_setting('elim.reassign_reason', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.sales_rep_id IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW.sales_rep_id IS NOT DISTINCT FROM OLD.sales_rep_id THEN
    RETURN NEW;
  END IF;
  INSERT INTO customer_marketer_history(factory_id, customer_id, from_rep_id, to_rep_id, reason, changed_by)
  VALUES (NEW.factory_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.sales_rep_id END, NEW.sales_rep_id,
          COALESCE(v_reason, CASE WHEN TG_OP = 'INSERT' THEN 'Registered under this marketer' END), auth.uid());
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (auth.uid(), NEW.factory_id, 'reassign_customer_marketer', 'customers', NEW.id::text,
            jsonb_build_object('sales_rep_id', OLD.sales_rep_id),
            jsonb_build_object('sales_rep_id', NEW.sales_rep_id, 'reason', v_reason));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_customers_log_marketer ON public.customers;
CREATE TRIGGER trg_customers_log_marketer AFTER INSERT OR UPDATE OF sales_rep_id ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public._customers_log_marketer();

-- Current assignments become the starting point of the history.
INSERT INTO public.customer_marketer_history(factory_id, customer_id, from_rep_id, to_rep_id, reason, changed_at)
SELECT c.factory_id, c.id, NULL, c.sales_rep_id, 'Assignment on record when history began', c.updated_at
  FROM public.customers c
 WHERE c.sales_rep_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.customer_marketer_history h WHERE h.customer_id = c.id);

CREATE OR REPLACE FUNCTION public.reassign_customer_marketer(p_customer uuid, p_rep uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cust customers%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(v_uid, 'customers'::module_key, 'edit'::action_key)
       OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Give a reason for moving this customer';
  END IF;
  SELECT * INTO v_cust FROM customers WHERE id = p_customer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF v_cust.sales_rep_id IS NOT DISTINCT FROM p_rep THEN
    RAISE EXCEPTION 'The customer is already with that marketer';
  END IF;
  PERFORM set_config('elim.reassign_reason', btrim(p_reason), true);
  UPDATE customers SET sales_rep_id = p_rep, updated_at = now() WHERE id = p_customer;
  PERFORM set_config('elim.reassign_reason', '', true);
  RETURN jsonb_build_object('customer_id', p_customer, 'from_rep_id', v_cust.sales_rep_id, 'to_rep_id', p_rep);
END;
$$;
REVOKE ALL ON FUNCTION public.reassign_customer_marketer(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_customer_marketer(uuid, uuid, text) TO authenticated;

-- ============ 5. Duplicate customers ============
CREATE OR REPLACE FUNCTION public._norm_phone(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d IS NULL OR length(d) < 7 THEN NULL
    WHEN d LIKE '234%' AND length(d) = 13 THEN '0' || substr(d, 4)
    ELSE d END
  FROM (SELECT NULLIF(regexp_replace(COALESCE(p, ''), '[^0-9]', '', 'g'), '') AS d) x
$$;

-- Registered customers only: create_sale makes unregistered walk-in records
-- on its own and must never be blocked by this.
CREATE OR REPLACE FUNCTION public._customers_no_duplicate_phone()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_norm text := public._norm_phone(NEW.phone);
  v_other record;
BEGIN
  IF NOT NEW.registered OR v_norm IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone AND OLD.registered THEN RETURN NEW; END IF;
  SELECT c.name, r.full_name AS marketer INTO v_other
    FROM customers c LEFT JOIN sales_reps r ON r.id = c.sales_rep_id
   WHERE c.factory_id = NEW.factory_id AND c.id <> NEW.id AND c.registered
     AND public._norm_phone(c.phone) = v_norm
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Phone % is already used by customer "%"%', NEW.phone, v_other.name,
      COALESCE(' (marketer ' || v_other.marketer || ')', '');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_customers_no_duplicate_phone ON public.customers;
CREATE TRIGGER trg_customers_no_duplicate_phone BEFORE INSERT OR UPDATE OF phone, registered ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public._customers_no_duplicate_phone();

-- Register a customer under a marketer. An unregistered walk-in record with
-- the same phone (made by an earlier sale) is taken over rather than
-- duplicated, so its purchase history comes along.
CREATE OR REPLACE FUNCTION public.register_marketer_customer(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep sales_reps%ROWTYPE;
  v_name text := btrim(COALESCE(payload->>'name', ''));
  v_phone text := NULLIF(btrim(COALESCE(payload->>'phone', '')), '');
  v_address text := NULLIF(btrim(COALESCE(payload->>'address', '')), '');
  v_email text := NULLIF(btrim(COALESCE(payload->>'email', '')), '');
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_status text := COALESCE(NULLIF(payload->>'status', ''), 'active');
  v_existing customers%ROWTYPE;
  v_id uuid;
  v_adopted boolean := false;
BEGIN
  IF NOT (public.has_permission(v_uid, 'customers'::module_key, 'create'::action_key)
       OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = (payload->>'sales_rep_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF length(v_name) < 2 THEN RAISE EXCEPTION 'Enter the customer''s name'; END IF;
  IF v_status NOT IN ('active','dormant') THEN RAISE EXCEPTION 'Status must be active or dormant'; END IF;

  IF public._norm_phone(v_phone) IS NOT NULL THEN
    SELECT * INTO v_existing FROM customers
     WHERE factory_id = v_rep.factory_id AND public._norm_phone(phone) = public._norm_phone(v_phone)
     ORDER BY registered DESC, created_at LIMIT 1 FOR UPDATE;
    IF FOUND AND v_existing.registered THEN
      RAISE EXCEPTION 'Phone % is already used by customer "%"', v_phone, v_existing.name;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM customers WHERE factory_id = v_rep.factory_id AND registered
                 AND lower(btrim(name)) = lower(v_name)) THEN
      RAISE EXCEPTION 'A customer named "%" is already registered. Add a phone number to tell them apart.', v_name;
    END IF;
  END IF;

  IF v_existing.id IS NOT NULL THEN
    PERFORM set_config('elim.reassign_reason', 'Registered under this marketer', true);
    UPDATE customers SET name = v_name, phone = v_phone, address = COALESCE(v_address, address),
           email = COALESCE(v_email, email), notes = v_notes, status = v_status,
           registered = true, sales_rep_id = v_rep.id, updated_at = now()
     WHERE id = v_existing.id;
    PERFORM set_config('elim.reassign_reason', '', true);
    v_id := v_existing.id;
    v_adopted := true;
  ELSE
    INSERT INTO customers(factory_id, name, phone, address, email, notes, status, registered, sales_rep_id, created_by)
    VALUES (v_rep.factory_id, v_name, v_phone, v_address, v_email, v_notes, v_status, true, v_rep.id, v_uid)
    RETURNING id INTO v_id;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_rep.factory_id, 'register_marketer_customer', 'customers', v_id::text,
          jsonb_build_object('name', v_name, 'phone', v_phone, 'sales_rep_id', v_rep.id, 'adopted_walk_in', v_adopted));
  RETURN jsonb_build_object('customer_id', v_id, 'adopted_walk_in', v_adopted);
END;
$$;
REVOKE ALL ON FUNCTION public.register_marketer_customer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_marketer_customer(jsonb) TO authenticated;

-- Status / notes / contact edits from the customer page.
CREATE OR REPLACE FUNCTION public.update_marketer_customer(p_customer uuid, payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old customers%ROWTYPE;
  v_status text := COALESCE(NULLIF(payload->>'status', ''), 'active');
BEGIN
  IF NOT (public.has_permission(v_uid, 'customers'::module_key, 'edit'::action_key)
       OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_old FROM customers WHERE id = p_customer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF length(btrim(COALESCE(payload->>'name', ''))) < 2 THEN RAISE EXCEPTION 'Enter the customer''s name'; END IF;
  IF v_status NOT IN ('active','dormant') THEN RAISE EXCEPTION 'Status must be active or dormant'; END IF;
  UPDATE customers SET
    name = btrim(payload->>'name'),
    phone = NULLIF(btrim(COALESCE(payload->>'phone', '')), ''),
    address = NULLIF(btrim(COALESCE(payload->>'address', '')), ''),
    email = NULLIF(btrim(COALESCE(payload->>'email', '')), ''),
    notes = NULLIF(btrim(COALESCE(payload->>'notes', '')), ''),
    status = v_status,
    updated_at = now()
  WHERE id = p_customer;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_old.factory_id, 'update_customer', 'customers', p_customer::text,
          jsonb_build_object('name', v_old.name, 'phone', v_old.phone, 'address', v_old.address, 'status', v_old.status, 'notes', v_old.notes),
          payload);
  RETURN jsonb_build_object('customer_id', p_customer);
END;
$$;
REVOKE ALL ON FUNCTION public.update_marketer_customer(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_marketer_customer(uuid, jsonb) TO authenticated;

-- Territory / phone on the marketer profile.
CREATE OR REPLACE FUNCTION public.update_marketer_profile(p_rep uuid, payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_old sales_reps%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'edit'::action_key)
       OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_old FROM sales_reps WHERE id = p_rep FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  UPDATE sales_reps SET
    phone = NULLIF(btrim(COALESCE(payload->>'phone', '')), ''),
    territory = NULLIF(btrim(COALESCE(payload->>'territory', '')), ''),
    status = CASE WHEN payload->>'status' IN ('active','inactive') THEN payload->>'status' ELSE status END,
    updated_at = now()
  WHERE id = p_rep;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_old.factory_id, 'update_marketer_profile', 'sales_reps', p_rep::text,
          jsonb_build_object('phone', v_old.phone, 'territory', v_old.territory, 'status', v_old.status), payload);
  RETURN jsonb_build_object('id', p_rep);
END;
$$;
REVOKE ALL ON FUNCTION public.update_marketer_profile(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_marketer_profile(uuid, jsonb) TO authenticated;

-- ============ 6. Notes and follow-ups ============
CREATE TABLE IF NOT EXISTS public.customer_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  sales_rep_id uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  note text NOT NULL CHECK (length(btrim(note)) > 0),
  follow_up_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','note')),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  done_by uuid REFERENCES auth.users(id),
  done_at timestamptz,
  done_note text
);
CREATE INDEX IF NOT EXISTS idx_customer_followups_customer ON public.customer_followups (customer_id, created_at);
GRANT SELECT ON public.customer_followups TO authenticated;
GRANT ALL ON public.customer_followups TO service_role;
ALTER TABLE public.customer_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer followups read" ON public.customer_followups;
CREATE POLICY "customer followups read" ON public.customer_followups FOR SELECT TO authenticated
  USING (public._customer_can_view(customer_id));

CREATE OR REPLACE FUNCTION public.add_customer_followup(p_customer uuid, p_note text, p_follow_up_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_cust customers%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_cust FROM customers WHERE id = p_customer;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT (public.has_permission(v_uid, 'customers'::module_key, 'edit'::action_key)
       OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'create'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'create'::action_key)
       OR (v_cust.sales_rep_id IS NOT NULL AND public._is_own_marketer(v_cust.sales_rep_id))) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_note IS NULL OR btrim(p_note) = '' THEN RAISE EXCEPTION 'Write the note'; END IF;
  INSERT INTO customer_followups(factory_id, customer_id, sales_rep_id, note, follow_up_date, status, created_by)
  VALUES (v_cust.factory_id, p_customer, v_cust.sales_rep_id, btrim(p_note), p_follow_up_date,
          CASE WHEN p_follow_up_date IS NULL THEN 'note' ELSE 'open' END, v_uid)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.add_customer_followup(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_customer_followup(uuid, text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_customer_followup(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row customer_followups%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM customer_followups WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Follow-up not found'; END IF;
  IF NOT (public.has_permission(v_uid, 'customers'::module_key, 'edit'::action_key)
       OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'create'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'create'::action_key)
       OR (v_row.sales_rep_id IS NOT NULL AND public._is_own_marketer(v_row.sales_rep_id))) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.status <> 'open' THEN RAISE EXCEPTION 'This follow-up is not open'; END IF;
  UPDATE customer_followups SET status = 'done', done_by = v_uid, done_at = now(), done_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'status', 'done');
END;
$$;
REVOKE ALL ON FUNCTION public.complete_customer_followup(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_customer_followup(uuid, text) TO authenticated;

-- ============ 7. Figures ============
-- Stock is in units and dated by when each movement was recorded (Lagos
-- time); opening + issued - sold - returned - damaged + corrections = closing
-- by construction. Money is dated by business date (sale_date,
-- payment_date, remittance_date).
--
-- Money held by the marketer = money their customers paid at a sale made
-- from the marketer's own stock (they collected it in the field). It leaves
-- their hands through rep_remittances. Payments recorded with
-- collected_by_rep are entered when Finance receives the money, so they are
-- already with the factory and are not "unremitted".
CREATE OR REPLACE FUNCTION public._marketer_figures(p_rep uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_products jsonb;
  v_stock jsonb;
  v_sales jsonb;
  v_pay jsonb;
  v_methods jsonb;
  v_remit jsonb;
  v_held_cum numeric;
  v_remit_cum numeric;
  v_debt jsonb;
BEGIN
  -- Per product: stock movement in units, and what was sold (all of this
  -- marketer's invoices) at the invoices' own prices.
  WITH mv AS (
    SELECT m.product_id, m.movement_type, m.quantity AS delta,
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM rep_stock_movements m WHERE m.sales_rep_id = p_rep
  ), st AS (
    SELECT product_id,
      COALESCE(SUM(delta) FILTER (WHERE p_from IS NOT NULL AND d < p_from), 0) AS opening,
      COALESCE(SUM(delta) FILTER (WHERE movement_type = 'dispatch_in' AND (p_from IS NULL OR d >= p_from) AND (p_to IS NULL OR d <= p_to)), 0) AS issued,
      COALESCE(-SUM(delta) FILTER (WHERE movement_type = 'sold' AND (p_from IS NULL OR d >= p_from) AND (p_to IS NULL OR d <= p_to)), 0) AS sold,
      COALESCE(-SUM(delta) FILTER (WHERE movement_type = 'returned_out' AND (p_from IS NULL OR d >= p_from) AND (p_to IS NULL OR d <= p_to)), 0) AS returned,
      COALESCE(-SUM(delta) FILTER (WHERE movement_type = 'damaged_out' AND (p_from IS NULL OR d >= p_from) AND (p_to IS NULL OR d <= p_to)), 0) AS damaged,
      COALESCE(SUM(delta) FILTER (WHERE movement_type IN ('reversal','adjustment') AND (p_from IS NULL OR d >= p_from) AND (p_to IS NULL OR d <= p_to)), 0) AS corrections,
      COALESCE(SUM(delta) FILTER (WHERE p_to IS NULL OR d <= p_to), 0) AS closing
    FROM mv GROUP BY product_id
  ), sv AS (
    SELECT si.product_id, SUM(si.quantity) AS qty_invoiced, SUM(si.line_total) AS value_invoiced,
           SUM(si.quantity) FILTER (WHERE s.sales_rep_id = p_rep) AS qty_van,
           SUM(si.line_total) FILTER (WHERE s.sales_rep_id = p_rep) AS value_van
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.account_rep_id = p_rep AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
       AND (p_from IS NULL OR s.sale_date >= p_from) AND (p_to IS NULL OR s.sale_date <= p_to)
     GROUP BY si.product_id
  ), iv AS (
    SELECT sdi.product_id, SUM(sdi.line_value) AS issued_value
      FROM stock_dispatch_items sdi JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
     WHERE sd.sales_rep_id = p_rep AND sd.status = 'posted'
       AND (p_from IS NULL OR sd.dispatch_date >= p_from) AND (p_to IS NULL OR sd.dispatch_date <= p_to)
     GROUP BY sdi.product_id
  ), rv AS (
    SELECT rri.product_id, SUM(rri.quantity_returned * rri.unit_price) AS returned_value
      FROM rep_return_items rri JOIN rep_returns rr ON rr.id = rri.rep_return_id
     WHERE rr.sales_rep_id = p_rep AND rr.status = 'completed'
       AND (p_from IS NULL OR rr.return_date >= p_from) AND (p_to IS NULL OR rr.return_date <= p_to)
     GROUP BY rri.product_id
  ), ids AS (
    SELECT product_id FROM st UNION SELECT product_id FROM sv UNION SELECT product_id FROM iv UNION SELECT product_id FROM rv
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'unit', p.unit,
           'opening', COALESCE(st.opening, 0), 'issued', COALESCE(st.issued, 0),
           'available', COALESCE(st.opening, 0) + COALESCE(st.issued, 0),
           'sold', COALESCE(st.sold, 0), 'returned', COALESCE(st.returned, 0),
           'damaged', COALESCE(st.damaged, 0), 'corrections', COALESCE(st.corrections, 0),
           'closing', COALESCE(st.closing, 0),
           'issued_value', COALESCE(iv.issued_value, 0), 'returned_value', COALESCE(rv.returned_value, 0),
           'qty_invoiced', COALESCE(sv.qty_invoiced, 0), 'value_invoiced', COALESCE(sv.value_invoiced, 0),
           'qty_van', COALESCE(sv.qty_van, 0), 'value_van', COALESCE(sv.value_van, 0)
         ) ORDER BY p.name), '[]'::jsonb)
    INTO v_products
    FROM ids JOIN products p ON p.id = ids.product_id
    LEFT JOIN st ON st.product_id = ids.product_id
    LEFT JOIN sv ON sv.product_id = ids.product_id
    LEFT JOIN iv ON iv.product_id = ids.product_id
    LEFT JOIN rv ON rv.product_id = ids.product_id;

  SELECT jsonb_build_object(
    'opening', COALESCE(SUM((x->>'opening')::numeric), 0),
    'issued', COALESCE(SUM((x->>'issued')::numeric), 0),
    'available', COALESCE(SUM((x->>'available')::numeric), 0),
    'sold', COALESCE(SUM((x->>'sold')::numeric), 0),
    'returned', COALESCE(SUM((x->>'returned')::numeric), 0),
    'damaged', COALESCE(SUM((x->>'damaged')::numeric), 0),
    'corrections', COALESCE(SUM((x->>'corrections')::numeric), 0),
    'closing', COALESCE(SUM((x->>'closing')::numeric), 0),
    'issued_value', COALESCE(SUM((x->>'issued_value')::numeric), 0),
    'returned_value', COALESCE(SUM((x->>'returned_value')::numeric), 0))
    INTO v_stock FROM jsonb_array_elements(v_products) x;

  -- Invoices. Paid at sale = receipts written with the sale; credit = what
  -- the sale left owing when it was approved.
  WITH s AS (
    SELECT s.*, COALESCE((SELECT SUM(p.amount) FROM payments_received p
                           WHERE p.sale_id = s.id AND p.at_point_of_sale
                             AND p.status NOT IN ('reversed','rejected')), 0) AS paid_at_sale
      FROM sales s
     WHERE s.account_rep_id = p_rep AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
       AND (p_from IS NULL OR s.sale_date >= p_from) AND (p_to IS NULL OR s.sale_date <= p_to)
  )
  SELECT jsonb_build_object(
    'count', COUNT(*),
    'customers', COUNT(DISTINCT COALESCE(customer_id::text, lower(customer_name))),
    'value', COALESCE(SUM(grand_total), 0),
    'van_value', COALESCE(SUM(grand_total) FILTER (WHERE sales_rep_id = p_rep), 0),
    'direct_value', COALESCE(SUM(grand_total) FILTER (WHERE sales_rep_id IS DISTINCT FROM p_rep), 0),
    'paid_at_sale', COALESCE(SUM(paid_at_sale), 0),
    'advance_applied', COALESCE(SUM(credit_applied), 0),
    'credit_sales', COALESCE(SUM(GREATEST(grand_total - paid_at_sale - credit_applied, 0)), 0),
    'credit_invoices', COUNT(*) FILTER (WHERE grand_total - paid_at_sale - credit_applied > 0.005))
    INTO v_sales FROM s;

  -- Receipts that belong to this marketer.
  WITH p AS (
    SELECT p.*, s.sales_rep_id AS sale_van_rep
      FROM payments_received p LEFT JOIN sales s ON s.id = p.sale_id
     WHERE p.account_rep_id = p_rep AND p.status NOT IN ('reversed','rejected')
       AND (p_from IS NULL OR p.payment_date >= p_from) AND (p_to IS NULL OR p.payment_date <= p_to)
  )
  SELECT jsonb_build_object(
    'total', COALESCE(SUM(amount), 0),
    'count', COUNT(*),
    'cash', COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0),
    'other', COALESCE(SUM(amount) FILTER (WHERE payment_method <> 'cash'), 0),
    'at_sale', COALESCE(SUM(amount) FILTER (WHERE at_point_of_sale), 0),
    'on_debts', COALESCE(SUM(amount) FILTER (WHERE NOT at_point_of_sale), 0),
    'held_by_marketer', COALESCE(SUM(amount) FILTER (WHERE at_point_of_sale AND sale_van_rep = p_rep), 0),
    'brought_in_by_marketer', COALESCE(SUM(amount) FILTER (WHERE NOT at_point_of_sale AND collected_by_rep = p_rep), 0),
    'received_by_factory', COALESCE(SUM(amount) FILTER (WHERE NOT (at_point_of_sale AND sale_van_rep IS NOT DISTINCT FROM p_rep) AND collected_by_rep IS DISTINCT FROM p_rep), 0),
    'pending_verification', COALESCE(SUM(amount) FILTER (WHERE review_status = 'pending'), 0),
    'pending_count', COUNT(*) FILTER (WHERE review_status = 'pending'))
    INTO v_pay FROM p;

  SELECT COALESCE(jsonb_object_agg(m, amt), '{}'::jsonb) INTO v_methods FROM (
    SELECT payment_method::text AS m, SUM(amount) AS amt
      FROM payments_received
     WHERE account_rep_id = p_rep AND status NOT IN ('reversed','rejected')
       AND (p_from IS NULL OR payment_date >= p_from) AND (p_to IS NULL OR payment_date <= p_to)
     GROUP BY payment_method) x;
  v_pay := v_pay || jsonb_build_object('by_method', v_methods);

  SELECT jsonb_build_object('total', COALESCE(SUM(amount), 0), 'count', COUNT(*),
                            'cash', COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0),
                            'other', COALESCE(SUM(amount) FILTER (WHERE payment_method <> 'cash'), 0))
    INTO v_remit FROM rep_remittances
   WHERE sales_rep_id = p_rep
     AND (p_from IS NULL OR remittance_date >= p_from) AND (p_to IS NULL OR remittance_date <= p_to);

  -- Unremitted is a running figure: everything held up to the end date less
  -- everything handed in up to it.
  SELECT COALESCE(SUM(p.amount), 0) INTO v_held_cum
    FROM payments_received p JOIN sales s ON s.id = p.sale_id
   WHERE p.account_rep_id = p_rep AND p.at_point_of_sale AND s.sales_rep_id = p_rep
     AND p.status NOT IN ('reversed','rejected') AND (p_to IS NULL OR p.payment_date <= p_to);
  SELECT COALESCE(SUM(amount), 0) INTO v_remit_cum FROM rep_remittances
   WHERE sales_rep_id = p_rep AND (p_to IS NULL OR remittance_date <= p_to);

  -- Customer debt as it stands now (each debt belongs to one marketer).
  SELECT jsonb_build_object(
    'outstanding', COALESCE(SUM(d.outstanding) FILTER (WHERE d.status <> 'paid'), 0),
    'open_debts', COUNT(*) FILTER (WHERE d.status <> 'paid' AND d.outstanding > 0),
    'customers_owing', COUNT(DISTINCT COALESCE(d.customer_id::text, d.id::text)) FILTER (WHERE d.status <> 'paid' AND d.outstanding > 0),
    'overdue', COALESCE(SUM(d.outstanding) FILTER (WHERE d.status <> 'paid' AND d.due_date < CURRENT_DATE), 0),
    'written_off', COALESCE(SUM(d.writeoff_amount) FILTER (WHERE d.writeoff_status = 'posted'), 0),
    'from_period', COALESCE(SUM(d.outstanding) FILTER (WHERE d.status <> 'paid'
        AND (p_from IS NULL OR COALESCE(s.sale_date, (d.created_at AT TIME ZONE 'Africa/Lagos')::date) >= p_from)
        AND (p_to IS NULL OR COALESCE(s.sale_date, (d.created_at AT TIME ZONE 'Africa/Lagos')::date) <= p_to)), 0))
    INTO v_debt
    FROM debts d LEFT JOIN sales s ON s.id = d.sale_id
   WHERE d.account_rep_id = p_rep AND (s.id IS NULL OR s.deleted_at IS NULL);

  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to,
    'products', v_products, 'stock', v_stock, 'sales', v_sales,
    'collections', v_pay, 'remittances', v_remit,
    'held_cumulative', v_held_cum, 'remitted_cumulative', v_remit_cum,
    'unremitted', v_held_cum - v_remit_cum,
    'debt', v_debt);
END;
$$;
REVOKE ALL ON FUNCTION public._marketer_figures(uuid, date, date) FROM PUBLIC, anon, authenticated;

-- The marketer statement: the period, and everything up to its end.
CREATE OR REPLACE FUNCTION public.marketer_statement(p_rep uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_stock_drift jsonb;
  v_items jsonb;
  v_customers jsonb;
BEGIN
  IF NOT public._marketer_can_view(p_rep, true) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_rep;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN RAISE EXCEPTION 'The start date is after the end date'; END IF;

  -- Stock trail vs the live balance: any difference is a ledger problem.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('product', p.name, 'trail', t.q, 'on_record', COALESCE(rs.quantity, 0))), '[]'::jsonb)
    INTO v_stock_drift
    FROM (SELECT product_id, SUM(quantity) AS q FROM rep_stock_movements WHERE sales_rep_id = p_rep GROUP BY product_id) t
    JOIN products p ON p.id = t.product_id
    LEFT JOIN rep_stock rs ON rs.sales_rep_id = p_rep AND rs.product_id = t.product_id
   WHERE abs(t.q - COALESCE(rs.quantity, 0)) > 0.0005;

  -- Open items needing attention.
  SELECT jsonb_build_object(
    'pending_payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('receipt', receipt_number, 'date', payment_date, 'amount', amount) ORDER BY payment_date)
                         FROM payments_received WHERE account_rep_id = p_rep AND review_status = 'pending'
                          AND status NOT IN ('reversed','rejected') AND (p_to IS NULL OR payment_date <= p_to)), '[]'::jsonb),
    'pending_sales', COALESCE((SELECT jsonb_agg(jsonb_build_object('invoice', invoice_number, 'date', sale_date, 'amount', grand_total) ORDER BY sale_date)
                         FROM sales WHERE account_rep_id = p_rep AND status = 'pending_approval' AND deleted_at IS NULL), '[]'::jsonb),
    'overdue_debts', COALESCE((SELECT jsonb_agg(jsonb_build_object('invoice', s.invoice_number, 'customer', COALESCE(c.name, s.customer_name, 'Walk-in'),
                                  'due', d.due_date, 'outstanding', d.outstanding) ORDER BY d.due_date)
                         FROM debts d LEFT JOIN sales s ON s.id = d.sale_id LEFT JOIN customers c ON c.id = d.customer_id
                        WHERE d.account_rep_id = p_rep AND d.status <> 'paid' AND d.outstanding > 0 AND d.due_date < CURRENT_DATE), '[]'::jsonb),
    'stock_drift', v_stock_drift)
    INTO v_items;

  -- Customer balances (for the statement's debtor list).
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'outstanding')::numeric DESC), '[]'::jsonb) INTO v_customers
    FROM (SELECT jsonb_build_object('customer', COALESCE(c.name, s.customer_name, 'Walk-in'),
                                    'phone', COALESCE(c.phone, s.customer_phone),
                                    'invoices', COUNT(*), 'outstanding', SUM(d.outstanding)) AS x
            FROM debts d LEFT JOIN sales s ON s.id = d.sale_id LEFT JOIN customers c ON c.id = d.customer_id
           WHERE d.account_rep_id = p_rep AND d.status <> 'paid' AND d.outstanding > 0
             AND (s.id IS NULL OR s.deleted_at IS NULL)
           GROUP BY COALESCE(c.name, s.customer_name, 'Walk-in'), COALESCE(c.phone, s.customer_phone)) q;

  RETURN jsonb_build_object(
    'marketer', jsonb_build_object('id', v_rep.id, 'code', v_rep.code, 'name', v_rep.full_name, 'phone', v_rep.phone,
                                   'territory', v_rep.territory, 'status', v_rep.status, 'kind', v_rep.kind,
                                   'registered', v_rep.created_at),
    'period', public._marketer_figures(p_rep, p_from, p_to),
    'cumulative', public._marketer_figures(p_rep, NULL, p_to),
    'debtors', v_customers,
    'reconciliation', v_items,
    'first_activity', LEAST(
       (SELECT MIN(sale_date) FROM sales WHERE account_rep_id = p_rep AND status = 'posted'),
       (SELECT MIN(dispatch_date) FROM stock_dispatches WHERE sales_rep_id = p_rep)),
    'generated_at', now());
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_statement(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_statement(uuid, date, date) TO authenticated;

-- Stock-only figures (Warehouse can see these without the money side).
CREATE OR REPLACE FUNCTION public.marketer_stock_accountability(p_rep uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT public._marketer_can_view(p_rep, false) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  v := public._marketer_figures(p_rep, p_from, p_to);
  RETURN jsonb_build_object('products', v->'products', 'stock', v->'stock');
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_stock_accountability(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_stock_accountability(uuid, date, date) TO authenticated;

-- One row per day: stock in units, then money. Customer debt at day end is
-- every debt raised by then, less what had been paid on it by then (later
-- write-offs and adjustments are not added back).
CREATE OR REPLACE FUNCTION public.marketer_daily_accountability(p_rep uuid, p_from date, p_to date)
RETURNS TABLE(
  day date, opening_qty numeric, issued_qty numeric, available_qty numeric, sold_qty numeric,
  returned_qty numeric, damaged_qty numeric, corrections_qty numeric, closing_qty numeric,
  sales_count bigint, sales_value numeric, cash_collected numeric, other_collected numeric,
  credit_sales numeric, debt_collections numeric, held_by_marketer numeric, remitted numeric,
  unremitted numeric, debt_outstanding numeric, pending_verification numeric,
  closed boolean, variances text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_money boolean := public._marketer_can_view(p_rep, true);
BEGIN
  IF NOT public._marketer_can_view(p_rep, false) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Pick at most a year of days'; END IF;

  RETURN QUERY
  WITH days AS (SELECT g::date AS d FROM generate_series(p_from, p_to, interval '1 day') g),
  mv AS (
    SELECT m.movement_type, m.quantity AS delta, (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM rep_stock_movements m WHERE m.sales_rep_id = p_rep
  ),
  st AS (
    SELECT days.d,
      (SELECT COALESCE(SUM(delta), 0) FROM mv WHERE mv.d < days.d) AS opening,
      (SELECT COALESCE(SUM(delta), 0) FROM mv WHERE mv.d = days.d AND movement_type = 'dispatch_in') AS issued,
      (SELECT COALESCE(-SUM(delta), 0) FROM mv WHERE mv.d = days.d AND movement_type = 'sold') AS sold,
      (SELECT COALESCE(-SUM(delta), 0) FROM mv WHERE mv.d = days.d AND movement_type = 'returned_out') AS returned,
      (SELECT COALESCE(-SUM(delta), 0) FROM mv WHERE mv.d = days.d AND movement_type = 'damaged_out') AS damaged,
      (SELECT COALESCE(SUM(delta), 0) FROM mv WHERE mv.d = days.d AND movement_type IN ('reversal','adjustment')) AS corrections
    FROM days
  ),
  sl AS (
    SELECT s.sale_date AS d, COUNT(*) AS n, SUM(s.grand_total) AS value,
           SUM(GREATEST(s.grand_total - s.credit_applied - COALESCE((SELECT SUM(p.amount) FROM payments_received p
                 WHERE p.sale_id = s.id AND p.at_point_of_sale AND p.status NOT IN ('reversed','rejected')), 0), 0)) AS credit
      FROM sales s
     WHERE s.account_rep_id = p_rep AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
       AND s.sale_date BETWEEN p_from AND p_to
     GROUP BY s.sale_date
  ),
  pm AS (
    SELECT p.payment_date AS d,
           SUM(p.amount) FILTER (WHERE p.payment_method = 'cash') AS cash,
           SUM(p.amount) FILTER (WHERE p.payment_method <> 'cash') AS other,
           SUM(p.amount) FILTER (WHERE NOT p.at_point_of_sale) AS on_debts,
           SUM(p.amount) FILTER (WHERE p.at_point_of_sale AND s.sales_rep_id = p_rep) AS held,
           SUM(p.amount) FILTER (WHERE p.review_status = 'pending') AS pending
      FROM payments_received p LEFT JOIN sales s ON s.id = p.sale_id
     WHERE p.account_rep_id = p_rep AND p.status NOT IN ('reversed','rejected')
       AND p.payment_date BETWEEN p_from AND p_to
     GROUP BY p.payment_date
  ),
  rm AS (
    SELECT remittance_date AS d, SUM(amount) AS amt FROM rep_remittances
     WHERE sales_rep_id = p_rep AND remittance_date BETWEEN p_from AND p_to GROUP BY remittance_date
  ),
  held_before AS (
    SELECT COALESCE(SUM(p.amount), 0) AS amt FROM payments_received p JOIN sales s ON s.id = p.sale_id
     WHERE p.account_rep_id = p_rep AND p.at_point_of_sale AND s.sales_rep_id = p_rep
       AND p.status NOT IN ('reversed','rejected') AND p.payment_date < p_from
  ),
  remit_before AS (
    SELECT COALESCE(SUM(amount), 0) AS amt FROM rep_remittances WHERE sales_rep_id = p_rep AND remittance_date < p_from
  ),
  dbt AS (
    SELECT d.id, d.outstanding,
           COALESCE(s.sale_date, (d.created_at AT TIME ZONE 'Africa/Lagos')::date) AS raised
      FROM debts d LEFT JOIN sales s ON s.id = d.sale_id
     WHERE d.account_rep_id = p_rep AND (s.id IS NULL OR s.deleted_at IS NULL)
  ),
  r_all AS (
    SELECT st.*, COALESCE(sl.n, 0) AS n, COALESCE(sl.value, 0) AS value, COALESCE(sl.credit, 0) AS credit,
           COALESCE(pm.cash, 0) AS cash, COALESCE(pm.other, 0) AS other, COALESCE(pm.on_debts, 0) AS on_debts,
           COALESCE(pm.held, 0) AS held, COALESCE(pm.pending, 0) AS pending, COALESCE(rm.amt, 0) AS remitted,
           (SELECT amt FROM held_before) - (SELECT amt FROM remit_before)
             + SUM(COALESCE(pm.held, 0) - COALESCE(rm.amt, 0)) OVER (ORDER BY st.d) AS unremitted,
           (SELECT COALESCE(SUM(dbt.outstanding + COALESCE((SELECT SUM(dp.amount) FROM debt_payments dp
                      WHERE dp.debt_id = dbt.id AND dp.payment_date > st.d), 0)), 0)
              FROM dbt WHERE dbt.raised <= st.d) AS debt_out,
           EXISTS (SELECT 1 FROM marketer_day_closes c WHERE c.sales_rep_id = p_rep AND c.close_date = st.d) AS is_closed
      FROM st
      LEFT JOIN sl ON sl.d = st.d LEFT JOIN pm ON pm.d = st.d LEFT JOIN rm ON rm.d = st.d
  )
  SELECT r.d, r.opening, r.issued, r.opening + r.issued, r.sold, r.returned, r.damaged, r.corrections,
         r.opening + r.issued - r.sold - r.returned - r.damaged + r.corrections,
         CASE WHEN v_money THEN r.n ELSE NULL END,
         CASE WHEN v_money THEN r.value END, CASE WHEN v_money THEN r.cash END, CASE WHEN v_money THEN r.other END,
         CASE WHEN v_money THEN r.credit END, CASE WHEN v_money THEN r.on_debts END, CASE WHEN v_money THEN r.held END,
         CASE WHEN v_money THEN r.remitted END, CASE WHEN v_money THEN r.unremitted END,
         CASE WHEN v_money THEN r.debt_out END, CASE WHEN v_money THEN r.pending END,
         r.is_closed,
         array_remove(ARRAY[
           CASE WHEN r.opening + r.issued - r.sold - r.returned - r.damaged + r.corrections < 0 THEN 'Closing stock below zero' END,
           CASE WHEN v_money AND r.unremitted > 0.005 THEN 'Collections not yet remitted' END,
           CASE WHEN v_money AND r.unremitted < -0.005 THEN 'Remitted more than recorded collections (goods payment or missing sale)' END,
           CASE WHEN v_money AND r.pending > 0 THEN 'Payments awaiting Finance verification' END,
           CASE WHEN r.corrections <> 0 THEN 'Stock corrections / reversals recorded' END
         ], NULL)
    FROM r_all r ORDER BY r.d DESC;
END;
$$;

-- ============ 8. End-of-day close ============
CREATE TABLE IF NOT EXISTS public.marketer_day_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  sales_rep_id uuid NOT NULL REFERENCES public.sales_reps(id) ON DELETE CASCADE,
  close_date date NOT NULL,
  figures jsonb NOT NULL,
  notes text,
  closed_by uuid REFERENCES auth.users(id),
  closed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sales_rep_id, close_date)
);
GRANT SELECT ON public.marketer_day_closes TO authenticated;
GRANT ALL ON public.marketer_day_closes TO service_role;
ALTER TABLE public.marketer_day_closes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "marketer day closes read" ON public.marketer_day_closes;
CREATE POLICY "marketer day closes read" ON public.marketer_day_closes FOR SELECT TO authenticated
  USING (public._marketer_can_view(sales_rep_id, false));

REVOKE ALL ON FUNCTION public.marketer_daily_accountability(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_daily_accountability(uuid, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.close_marketer_day(p_rep uuid, p_date date, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep sales_reps%ROWTYPE;
  v_row record;
  v_fig jsonb;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'marketer-accounts'::module_key, 'confirm'::action_key)
       OR public.has_permission(v_uid, 'distribution'::module_key, 'post'::action_key)
       OR public.has_permission(v_uid, 'finance'::module_key, 'post'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_rep;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF p_date IS NULL OR p_date > CURRENT_DATE THEN RAISE EXCEPTION 'A day in the future cannot be closed'; END IF;
  IF EXISTS (SELECT 1 FROM marketer_day_closes WHERE sales_rep_id = p_rep AND close_date = p_date) THEN
    RAISE EXCEPTION '% is already closed for %', to_char(p_date, 'DD Mon YYYY'), v_rep.full_name;
  END IF;
  SELECT * INTO v_row FROM public.marketer_daily_accountability(p_rep, p_date, p_date) LIMIT 1;
  v_fig := to_jsonb(v_row) || jsonb_build_object('products', public._marketer_figures(p_rep, p_date, p_date)->'products');
  IF COALESCE(array_length(v_row.variances, 1), 0) > 0 AND (p_notes IS NULL OR btrim(p_notes) = '') THEN
    RAISE EXCEPTION 'This day has items to explain (%). Add a note before closing it.', array_to_string(v_row.variances, '; ');
  END IF;
  INSERT INTO marketer_day_closes(factory_id, sales_rep_id, close_date, figures, notes, closed_by)
  VALUES (v_rep.factory_id, p_rep, p_date, v_fig, NULLIF(btrim(COALESCE(p_notes, '')), ''), v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_rep.factory_id, 'close_marketer_day', 'sales_reps', p_rep::text,
          jsonb_build_object('close_date', p_date, 'notes', p_notes, 'close_id', v_id));
  RETURN jsonb_build_object('id', v_id, 'close_date', p_date);
END;
$$;
REVOKE ALL ON FUNCTION public.close_marketer_day(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_marketer_day(uuid, date, text) TO authenticated;

-- ============ 9. Lists for the profile pages ============
-- Every marketer with their headline figures.
CREATE OR REPLACE FUNCTION public.marketer_directory(p_factory uuid)
RETURNS TABLE(
  id uuid, code text, full_name text, phone text, territory text, status text, kind text, created_at timestamptz,
  customers bigint, sales_value numeric, collected numeric, outstanding numeric, remitted numeric,
  unremitted numeric, stock_units numeric, last_sale date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_uid uuid := auth.uid(); v_all boolean;
BEGIN
  v_all := public.has_permission(v_uid, 'marketer-accounts'::module_key, 'view'::action_key)
        OR public.has_permission(v_uid, 'finance'::module_key, 'view'::action_key)
        OR public.has_permission(v_uid, 'payments'::module_key, 'view'::action_key)
        OR public.has_permission(v_uid, 'debts'::module_key, 'view'::action_key);
  RETURN QUERY
  SELECT r.id, r.code, r.full_name, r.phone, r.territory, r.status, r.kind, r.created_at,
    (SELECT COUNT(*) FROM customers c WHERE c.sales_rep_id = r.id AND c.registered),
    (SELECT COALESCE(SUM(s.grand_total), 0) FROM sales s WHERE s.account_rep_id = r.id AND s.status = 'posted'
        AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)),
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments_received p WHERE p.account_rep_id = r.id
        AND p.status NOT IN ('reversed','rejected')),
    (SELECT COALESCE(SUM(d.outstanding), 0) FROM debts d LEFT JOIN sales s ON s.id = d.sale_id
      WHERE d.account_rep_id = r.id AND d.status <> 'paid' AND (s.id IS NULL OR s.deleted_at IS NULL)),
    (SELECT COALESCE(SUM(m.amount), 0) FROM rep_remittances m WHERE m.sales_rep_id = r.id),
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments_received p JOIN sales s ON s.id = p.sale_id
      WHERE p.account_rep_id = r.id AND p.at_point_of_sale AND s.sales_rep_id = r.id
        AND p.status NOT IN ('reversed','rejected'))
      - (SELECT COALESCE(SUM(m.amount), 0) FROM rep_remittances m WHERE m.sales_rep_id = r.id),
    (SELECT COALESCE(SUM(rs.quantity), 0) FROM rep_stock rs WHERE rs.sales_rep_id = r.id),
    (SELECT MAX(s.sale_date) FROM sales s WHERE s.account_rep_id = r.id AND s.status = 'posted' AND s.deleted_at IS NULL)
  FROM sales_reps r
  WHERE r.factory_id = p_factory AND (v_all OR r.user_id = v_uid)
  ORDER BY r.kind, r.full_name;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_directory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_directory(uuid) TO authenticated;

-- The consolidated customer report: one row per customer whose invoices or
-- debts belong to this marketer, or who is assigned to them. Money columns
-- cover only this marketer's invoices, so the rows add up to the marketer's
-- total debt with nothing counted twice. account_debt is the customer's whole
-- account (it can be larger when another marketer also sold to them).
CREATE OR REPLACE FUNCTION public.marketer_customer_report(p_rep uuid)
RETURNS TABLE(
  customer_id uuid, name text, phone text, address text, status text, registered boolean,
  assigned boolean, registered_at timestamptz, invoices bigint, total_purchases numeric, total_paid numeric,
  written_off numeric, outstanding numeric, unpaid_invoices bigint, overdue numeric, last_purchase date,
  account_debt numeric, advance numeric, open_followups bigint, credit_limit numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._marketer_can_view(p_rep, true) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH inv AS (
    SELECT s.id, s.customer_id, s.customer_name, s.customer_phone, s.grand_total, s.sale_date
      FROM sales s
     WHERE s.account_rep_id = p_rep AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
  ), dbt AS (
    SELECT d.* FROM debts d LEFT JOIN sales s ON s.id = d.sale_id
     WHERE d.account_rep_id = p_rep AND (s.id IS NULL OR (s.deleted_at IS NULL AND s.status = 'posted'))
  ), keys AS (
    SELECT c.id AS cid, NULL::text AS walk FROM customers c WHERE c.sales_rep_id = p_rep
    UNION SELECT customer_id, NULL FROM inv WHERE customer_id IS NOT NULL
    UNION SELECT customer_id, NULL FROM dbt WHERE customer_id IS NOT NULL
    UNION SELECT NULL, 'walk-in' FROM inv WHERE customer_id IS NULL
    UNION SELECT NULL, 'walk-in' FROM dbt WHERE customer_id IS NULL
  ), agg AS (
    SELECT k.cid, k.walk,
      (SELECT COUNT(*) FROM inv WHERE inv.customer_id IS NOT DISTINCT FROM k.cid) AS n,
      (SELECT COALESCE(SUM(grand_total), 0) FROM inv WHERE inv.customer_id IS NOT DISTINCT FROM k.cid) AS purchases,
      (SELECT COALESCE(SUM(outstanding) FILTER (WHERE status <> 'paid'), 0) FROM dbt WHERE dbt.customer_id IS NOT DISTINCT FROM k.cid) AS owed,
      (SELECT COALESCE(SUM(outstanding) FILTER (WHERE status <> 'paid' AND due_date < CURRENT_DATE), 0) FROM dbt WHERE dbt.customer_id IS NOT DISTINCT FROM k.cid) AS overdue,
      (SELECT COALESCE(SUM(writeoff_amount) FILTER (WHERE writeoff_status = 'posted'), 0) FROM dbt WHERE dbt.customer_id IS NOT DISTINCT FROM k.cid AND dbt.sale_id IS NOT NULL) AS wo,
      (SELECT COALESCE(SUM(outstanding) FILTER (WHERE status <> 'paid'), 0) FROM dbt WHERE dbt.customer_id IS NOT DISTINCT FROM k.cid AND dbt.sale_id IS NOT NULL) AS owed_on_invoices,
      (SELECT COUNT(*) FILTER (WHERE status <> 'paid' AND outstanding > 0) FROM dbt WHERE dbt.customer_id IS NOT DISTINCT FROM k.cid) AS unpaid,
      (SELECT MAX(sale_date) FROM inv WHERE inv.customer_id IS NOT DISTINCT FROM k.cid) AS last_sale
    FROM keys k
  )
  SELECT a.cid,
         CASE WHEN a.cid IS NULL THEN 'Walk-in / unregistered' ELSE c.name END,
         c.phone, c.address, COALESCE(c.status, 'active'), COALESCE(c.registered, false),
         COALESCE(c.sales_rep_id = p_rep, false), c.created_at,
         a.n, a.purchases,
         GREATEST(a.purchases - a.owed_on_invoices - a.wo, 0),
         a.wo, a.owed, a.unpaid, a.overdue, a.last_sale,
         COALESCE(c.outstanding_balance, a.owed), COALESCE(c.credit_balance, 0),
         (SELECT COUNT(*) FROM customer_followups f WHERE f.customer_id = a.cid AND f.status = 'open'),
         c.credit_limit
    FROM agg a LEFT JOIN customers c ON c.id = a.cid
   ORDER BY a.owed DESC, a.purchases DESC, 2;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_customer_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_customer_report(uuid) TO authenticated;

-- The marketer's invoices (daily sales), with items at their own prices.
CREATE OR REPLACE FUNCTION public.marketer_invoices(p_rep uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_owing_only boolean DEFAULT false)
RETURNS TABLE(
  sale_id uuid, invoice_number text, sale_date date, customer_id uuid, customer_name text, customer_phone text,
  grand_total numeric, paid_at_sale numeric, paid_later numeric, advance_applied numeric, written_off numeric,
  outstanding numeric, payment_method text, van_sale boolean, due_date date, status text, items jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._marketer_can_view(p_rep, true) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT s.id, s.invoice_number, s.sale_date, s.customer_id,
         COALESCE(c.name, NULLIF(btrim(s.customer_name), ''), 'Walk-in'),
         COALESCE(c.phone, s.customer_phone),
         s.grand_total, pa.at_sale,
         GREATEST(s.grand_total - pa.at_sale - s.credit_applied - COALESCE(d.outstanding, 0) - wo.amt, 0),
         s.credit_applied, wo.amt, COALESCE(d.outstanding, 0),
         s.payment_method::text, s.sales_rep_id IS NOT DISTINCT FROM p_rep, d.due_date,
         CASE WHEN wo.amt > 0 AND COALESCE(d.outstanding, 0) = 0 THEN 'written_off'
              WHEN COALESCE(d.outstanding, 0) <= 0 THEN 'paid'
              WHEN d.due_date < CURRENT_DATE THEN 'overdue'
              WHEN s.grand_total - COALESCE(d.outstanding, 0) > 0 THEN 'part_paid'
              ELSE 'unpaid' END,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('product', p.name, 'unit', p.unit, 'quantity', si.quantity,
                     'unit_price', si.unit_price, 'line_total', si.line_total) ORDER BY p.name)
                     FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = s.id), '[]'::jsonb)
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN debts d ON d.sale_id = s.id
    CROSS JOIN LATERAL (SELECT COALESCE(SUM(p.amount), 0) AS at_sale FROM payments_received p
                         WHERE p.sale_id = s.id AND p.at_point_of_sale AND p.status NOT IN ('reversed','rejected')) pa
    CROSS JOIN LATERAL (SELECT CASE WHEN d.writeoff_status = 'posted' THEN COALESCE(d.writeoff_amount, 0) ELSE 0 END AS amt) wo
   WHERE s.account_rep_id = p_rep AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
     AND (p_from IS NULL OR s.sale_date >= p_from) AND (p_to IS NULL OR s.sale_date <= p_to)
     AND (NOT p_owing_only OR COALESCE(d.outstanding, 0) > 0)
   ORDER BY s.sale_date DESC, s.invoice_number DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_invoices(uuid, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_invoices(uuid, date, date, boolean) TO authenticated;

-- Receipts belonging to the marketer, each with the invoices it paid.
CREATE OR REPLACE FUNCTION public.marketer_payments(p_rep uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE(
  payment_id uuid, receipt_number text, payment_date date, customer_id uuid, customer_name text,
  amount numeric, payment_method text, at_point_of_sale boolean, collected_by_marketer boolean,
  held_by_marketer boolean, review_status text, status text, remarks text, allocations jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._marketer_can_view(p_rep, true) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT p.id, p.receipt_number, p.payment_date, p.customer_id,
         COALESCE(c.name, NULLIF(btrim(s.customer_name), ''), 'Walk-in'),
         p.amount, p.payment_method::text, p.at_point_of_sale,
         p.collected_by_rep IS NOT DISTINCT FROM p_rep,
         p.at_point_of_sale AND s.sales_rep_id IS NOT DISTINCT FROM p_rep,
         p.review_status::text, p.status::text, p.remarks,
         CASE WHEN p.at_point_of_sale THEN jsonb_build_array(jsonb_build_object('invoice', s.invoice_number, 'amount', p.amount))
              ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('invoice', COALESCE(ss.invoice_number, 'Opening / adjusted debt'),
                                 'amount', t.cash_paid) ORDER BY t.seq)
                               FROM customer_account_transactions t LEFT JOIN sales ss ON ss.id = t.sale_id
                              WHERE t.payment_id = p.id AND t.txn_type = 'DEBT_SETTLEMENT'), '[]'::jsonb)
                   || COALESCE((SELECT jsonb_agg(jsonb_build_object('invoice', 'Held as advance', 'amount', t.credit_delta))
                               FROM customer_account_transactions t
                              WHERE t.payment_id = p.id AND t.txn_type IN ('CUSTOMER_PAYMENT','ADVANCE_PAYMENT')), '[]'::jsonb)
         END
    FROM payments_received p
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN sales s ON s.id = p.sale_id
   WHERE p.account_rep_id = p_rep
     AND (p_from IS NULL OR p.payment_date >= p_from) AND (p_to IS NULL OR p.payment_date <= p_to)
   ORDER BY p.payment_date DESC, p.receipt_number DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_payments(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_payments(uuid, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.marketer_remittances(p_rep uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE(id uuid, remittance_number text, remittance_date date, amount numeric, payment_method text, remarks text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._marketer_can_view(p_rep, true) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT m.id, m.remittance_number, m.remittance_date, m.amount, m.payment_method::text, m.remarks, m.created_at
    FROM rep_remittances m
   WHERE m.sales_rep_id = p_rep
     AND (p_from IS NULL OR m.remittance_date >= p_from) AND (p_to IS NULL OR m.remittance_date <= p_to)
   ORDER BY m.remittance_date DESC, m.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_remittances(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_remittances(uuid, date, date) TO authenticated;

-- Month by month (performance data for commission later).
CREATE OR REPLACE FUNCTION public.marketer_monthly_performance(p_rep uuid, p_months int DEFAULT 12)
RETURNS TABLE(month date, sales_count bigint, units numeric, sales_value numeric, credit_sales numeric,
              collected numeric, cash numeric, other numeric, remitted numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_start date := (date_trunc('month', CURRENT_DATE) - make_interval(months => GREATEST(p_months, 1) - 1))::date;
BEGIN
  IF NOT public._marketer_can_view(p_rep, true) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH m AS (SELECT g::date AS m FROM generate_series(v_start, date_trunc('month', CURRENT_DATE)::date, interval '1 month') g)
  SELECT m.m,
    (SELECT COUNT(*) FROM sales s WHERE s.account_rep_id = p_rep AND s.status = 'posted' AND s.deleted_at IS NULL
        AND NOT COALESCE(s.is_pr, false) AND date_trunc('month', s.sale_date) = m.m),
    (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.account_rep_id = p_rep AND s.status = 'posted' AND s.deleted_at IS NULL
        AND NOT COALESCE(s.is_pr, false) AND date_trunc('month', s.sale_date) = m.m),
    (SELECT COALESCE(SUM(s.grand_total), 0) FROM sales s WHERE s.account_rep_id = p_rep AND s.status = 'posted'
        AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false) AND date_trunc('month', s.sale_date) = m.m),
    (SELECT COALESCE(SUM(GREATEST(s.grand_total - s.credit_applied - COALESCE((SELECT SUM(p.amount) FROM payments_received p
          WHERE p.sale_id = s.id AND p.at_point_of_sale AND p.status NOT IN ('reversed','rejected')), 0), 0)), 0)
       FROM sales s WHERE s.account_rep_id = p_rep AND s.status = 'posted' AND s.deleted_at IS NULL
        AND NOT COALESCE(s.is_pr, false) AND date_trunc('month', s.sale_date) = m.m),
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments_received p WHERE p.account_rep_id = p_rep
        AND p.status NOT IN ('reversed','rejected') AND date_trunc('month', p.payment_date) = m.m),
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments_received p WHERE p.account_rep_id = p_rep AND p.payment_method = 'cash'
        AND p.status NOT IN ('reversed','rejected') AND date_trunc('month', p.payment_date) = m.m),
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments_received p WHERE p.account_rep_id = p_rep AND p.payment_method <> 'cash'
        AND p.status NOT IN ('reversed','rejected') AND date_trunc('month', p.payment_date) = m.m),
    (SELECT COALESCE(SUM(r.amount), 0) FROM rep_remittances r WHERE r.sales_rep_id = p_rep
        AND date_trunc('month', r.remittance_date) = m.m)
  FROM m ORDER BY m.m DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_monthly_performance(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_monthly_performance(uuid, int) TO authenticated;

-- ============ 10. The customer's account ============
-- Everything about one customer, from the actual records: the account
-- ledger for the period (opening and closing balance, every sale, payment,
-- allocation, return credit and adjustment), every invoice with its items at
-- the prices charged and the payments that reduced it, every receipt with
-- where it went, and goods returned.
CREATE OR REPLACE FUNCTION public.customer_statement(p_customer uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cust customers%ROWTYPE;
  v_rep sales_reps%ROWTYPE;
  v_open record;
  v_close record;
  v_lines jsonb;
  v_invoices jsonb;
  v_payments jsonb;
  v_returns jsonb;
  v_history jsonb;
BEGIN
  IF NOT public._customer_can_view(p_customer) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_cust FROM customers WHERE id = p_customer;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = v_cust.sales_rep_id;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN RAISE EXCEPTION 'The start date is after the end date'; END IF;

  SELECT credit_after, debt_after INTO v_open FROM customer_account_transactions
   WHERE customer_id = p_customer AND p_from IS NOT NULL AND (created_at AT TIME ZONE 'Africa/Lagos')::date < p_from
   ORDER BY seq DESC LIMIT 1;
  SELECT credit_after, debt_after INTO v_close FROM customer_account_transactions
   WHERE customer_id = p_customer AND (p_to IS NULL OR (created_at AT TIME ZONE 'Africa/Lagos')::date <= p_to)
   ORDER BY seq DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'seq', t.seq, 'date', (t.created_at AT TIME ZONE 'Africa/Lagos')::date, 'type', t.txn_type,
           'reference', COALESCE(s.invoice_number, p.receipt_number, t.reference_type),
           'invoice', s.invoice_number, 'invoice_date', s.sale_date,
           'receipt', p.receipt_number, 'payment_date', p.payment_date,
           'description', t.description, 'notes', t.notes,
           'goods', t.goods_value, 'paid', t.cash_paid, 'advance_used', t.advance_used,
           'debt_delta', t.debt_delta, 'credit_delta', t.credit_delta,
           'debt_after', t.debt_after, 'credit_after', t.credit_after,
           'method', COALESCE(p.payment_method::text, t.payment_method::text),
           'items', CASE WHEN t.txn_type = 'SALE' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'product', pr.name, 'unit', pr.unit, 'quantity', si.quantity, 'unit_price', si.unit_price,
                        'line_total', si.line_total) ORDER BY pr.name)
                      FROM sale_items si JOIN products pr ON pr.id = si.product_id WHERE si.sale_id = t.sale_id), '[]'::jsonb) END
         ) ORDER BY t.seq), '[]'::jsonb)
    INTO v_lines
    FROM customer_account_transactions t
    LEFT JOIN sales s ON s.id = t.sale_id
    LEFT JOIN payments_received p ON p.id = t.payment_id
   WHERE t.customer_id = p_customer
     AND (p_from IS NULL OR (t.created_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
     AND (p_to IS NULL OR (t.created_at AT TIME ZONE 'Africa/Lagos')::date <= p_to);

  -- Invoices dated in the period, plus any older invoice still owing.
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'sale_date'), (x->>'invoice_number')), '[]'::jsonb) INTO v_invoices FROM (
    SELECT jsonb_build_object(
      'sale_id', s.id, 'invoice_number', s.invoice_number, 'sale_date', s.sale_date, 'status', s.status,
      'in_period', (p_from IS NULL OR s.sale_date >= p_from) AND (p_to IS NULL OR s.sale_date <= p_to),
      'marketer', ar.full_name, 'van_sale', s.sales_rep_id IS NOT NULL,
      'grand_total', s.grand_total, 'advance_applied', s.credit_applied,
      'written_off', CASE WHEN d.writeoff_status = 'posted' THEN COALESCE(d.writeoff_amount, 0) ELSE 0 END,
      'outstanding', COALESCE(d.outstanding, 0), 'due_date', d.due_date, 'paid_at', d.paid_at,
      'paid', s.grand_total - COALESCE(d.outstanding, 0) - CASE WHEN d.writeoff_status = 'posted' THEN COALESCE(d.writeoff_amount, 0) ELSE 0 END,
      'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('product', pr.name, 'unit', pr.unit, 'quantity', si.quantity,
                   'unit_price', si.unit_price, 'line_total', si.line_total) ORDER BY pr.name)
                 FROM sale_items si JOIN products pr ON pr.id = si.product_id WHERE si.sale_id = s.id), '[]'::jsonb),
      'payments', COALESCE((
          SELECT jsonb_agg(y ORDER BY y->>'date', y->>'receipt') FROM (
            SELECT jsonb_build_object('receipt', p.receipt_number, 'date', p.payment_date, 'method', p.payment_method,
                                      'amount', p.amount, 'kind', 'at sale') AS y
              FROM payments_received p WHERE p.sale_id = s.id AND p.at_point_of_sale AND p.status NOT IN ('reversed','rejected')
            UNION ALL
            SELECT jsonb_build_object('receipt', p.receipt_number, 'date', COALESCE(p.payment_date, (t.created_at AT TIME ZONE 'Africa/Lagos')::date),
                                      'method', COALESCE(p.payment_method, t.payment_method), 'amount', t.cash_paid, 'kind', 'allocated')
              FROM customer_account_transactions t LEFT JOIN payments_received p ON p.id = t.payment_id
             WHERE t.sale_id = s.id AND t.txn_type = 'DEBT_SETTLEMENT'
            UNION ALL
            SELECT jsonb_build_object('receipt', NULL, 'date', (t.created_at AT TIME ZONE 'Africa/Lagos')::date,
                                      'method', NULL, 'amount', t.advance_used, 'kind', 'advance')
              FROM customer_account_transactions t
             WHERE t.sale_id = s.id AND t.txn_type = 'ADVANCE_APPLIED'
          ) z), '[]'::jsonb)
    ) AS x
    FROM sales s
    LEFT JOIN debts d ON d.sale_id = s.id
    LEFT JOIN sales_reps ar ON ar.id = s.account_rep_id
   WHERE s.customer_id = p_customer AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
     AND (p_to IS NULL OR s.sale_date <= p_to)
     AND ((p_from IS NULL OR s.sale_date >= p_from) OR COALESCE(d.outstanding, 0) > 0)
  ) q;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'payment_id', p.id, 'receipt', p.receipt_number, 'date', p.payment_date, 'amount', p.amount,
           'method', p.payment_method, 'status', p.status, 'review_status', p.review_status, 'remarks', p.remarks,
           'at_point_of_sale', p.at_point_of_sale, 'collected_by', cr.full_name,
           'allocations', CASE WHEN p.at_point_of_sale THEN jsonb_build_array(jsonb_build_object('invoice', ps.invoice_number, 'amount', p.amount))
             ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('invoice', COALESCE(ss.invoice_number, 'Opening / adjusted debt'), 'amount', t.cash_paid) ORDER BY t.seq)
                     FROM customer_account_transactions t LEFT JOIN sales ss ON ss.id = t.sale_id
                    WHERE t.payment_id = p.id AND t.txn_type = 'DEBT_SETTLEMENT'), '[]'::jsonb)
                || COALESCE((SELECT jsonb_agg(jsonb_build_object('invoice', 'Held as advance', 'amount', t.credit_delta))
                     FROM customer_account_transactions t
                    WHERE t.payment_id = p.id AND t.txn_type IN ('CUSTOMER_PAYMENT','ADVANCE_PAYMENT')), '[]'::jsonb) END
         ) ORDER BY p.payment_date DESC, p.receipt_number DESC), '[]'::jsonb)
    INTO v_payments
    FROM payments_received p
    LEFT JOIN sales ps ON ps.id = p.sale_id
    LEFT JOIN sales_reps cr ON cr.id = p.collected_by_rep
   WHERE p.customer_id = p_customer
     AND (p_from IS NULL OR p.payment_date >= p_from) AND (p_to IS NULL OR p.payment_date <= p_to);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'return_number', r.return_number, 'date', (r.received_at AT TIME ZONE 'Africa/Lagos')::date,
           'product', pr.name, 'unit', COALESCE(r.unit, pr.unit), 'quantity', r.quantity_returned,
           'accepted', r.accepted_quantity, 'status', r.status, 'reason', r.reason, 'invoice', s.invoice_number)
           ORDER BY r.received_at), '[]'::jsonb)
    INTO v_returns
    FROM sales_returns r
    JOIN products pr ON pr.id = r.product_id
    LEFT JOIN sales s ON s.id = r.sale_id
   WHERE r.customer_id = p_customer
     AND (p_from IS NULL OR (r.received_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
     AND (p_to IS NULL OR (r.received_at AT TIME ZONE 'Africa/Lagos')::date <= p_to);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('from', fr.full_name, 'to', tr.full_name, 'reason', h.reason,
                                               'changed_at', h.changed_at) ORDER BY h.changed_at), '[]'::jsonb)
    INTO v_history
    FROM customer_marketer_history h
    LEFT JOIN sales_reps fr ON fr.id = h.from_rep_id
    LEFT JOIN sales_reps tr ON tr.id = h.to_rep_id
   WHERE h.customer_id = p_customer;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object('id', v_cust.id, 'name', v_cust.name, 'phone', v_cust.phone, 'address', v_cust.address,
                                   'email', v_cust.email, 'status', v_cust.status, 'notes', v_cust.notes,
                                   'registered', v_cust.registered, 'registered_at', v_cust.created_at,
                                   'credit_limit', v_cust.credit_limit, 'credit_days', v_cust.credit_days,
                                   'outstanding_balance', v_cust.outstanding_balance, 'advance', v_cust.credit_balance),
    'marketer', CASE WHEN v_rep.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_rep.id, 'name', v_rep.full_name, 'code', v_rep.code) END,
    'from', p_from, 'to', p_to,
    'opening', jsonb_build_object('debt', COALESCE(v_open.debt_after, 0), 'advance', COALESCE(v_open.credit_after, 0)),
    'closing', jsonb_build_object('debt', COALESCE(v_close.debt_after, 0), 'advance', COALESCE(v_close.credit_after, 0)),
    'lines', v_lines, 'invoices', v_invoices, 'payments', v_payments, 'returns', v_returns,
    'marketer_history', v_history,
    'first_purchase', (SELECT MIN(sale_date) FROM sales WHERE customer_id = p_customer AND status = 'posted' AND deleted_at IS NULL),
    'generated_at', now());
END;
$$;
REVOKE ALL ON FUNCTION public.customer_statement(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_statement(uuid, date, date) TO authenticated;

-- ============ 11. Roles ============
INSERT INTO public.roles (slug, label, description, is_system) VALUES
  ('marketer', 'Marketer', 'Field marketer: sees only their own account and customers (link the login on the marketer).', true),
  ('auditor', 'Auditor', 'Read-only: transactions, statements and audit records.', true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.role_permissions (role, module, action) VALUES
  ('auditor', 'marketer-accounts', 'view'), ('auditor', 'marketer-accounts', 'print'), ('auditor', 'marketer-accounts', 'export'),
  ('auditor', 'customers', 'view'), ('auditor', 'sales', 'view'), ('auditor', 'debts', 'view'),
  ('auditor', 'payments', 'view'), ('auditor', 'distribution', 'view'), ('auditor', 'reports', 'view'),
  ('auditor', 'audit-logs', 'view'),
  ('sales', 'marketer-accounts', 'view'), ('sales', 'marketer-accounts', 'create'), ('sales', 'marketer-accounts', 'edit'),
  ('sales', 'marketer-accounts', 'print'),
  ('accountant', 'marketer-accounts', 'create'), ('accountant', 'marketer-accounts', 'edit'),
  ('accountant', 'marketer-accounts', 'confirm'), ('accountant', 'marketer-accounts', 'print'),
  ('accountant', 'marketer-accounts', 'export'),
  ('store_officer', 'marketer-accounts', 'confirm')
ON CONFLICT (role, module, action) DO NOTHING;
