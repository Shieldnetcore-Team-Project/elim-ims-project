-- ============================================================================
-- Removing customers who no longer buy, and duplicate marketers
-- ----------------------------------------------------------------------------
-- Customers -- remove_customer(customer, reason) / restore_customer(customer)
--   * Never bought, never paid (no invoices, receipts, debts, account
--     entries, adjustments, returns or containers): deleted outright.
--   * Has history: removed, not deleted -- invoices, receipts and statements
--     must keep pointing at them. They come off the customer and distributor
--     lists and pickers (removed_at set, registered cleared) and can't be
--     sold to until restored. Refused while they still owe money, hold an
--     advance or containers, or have a sale waiting for approval.
--   Needs customers:delete (granted to the accountant here).
--
-- Marketers -- remove_marketer(marketer, reason, merge_into)
--   * No history and no customers: deleted.
--   * A duplicate: merged into the marketer it duplicates (merge_into).
--     Everything moves across -- stock held and its trail, dispatches,
--     returns, remittances, sales, debts, receipts, customers, follow-ups,
--     day closes, and containers held (moved with a 'merge' movement, as
--     container history is append-only) -- then the duplicate is deleted.
--   * Has history but isn't a duplicate: refused; set them inactive instead.
--   Needs distribution:delete (admins).
-- Both are written to the audit log with the reason.
-- ============================================================================

-- ============ Customers ============
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS removed_reason text;
CREATE INDEX IF NOT EXISTS idx_customers_removed ON public.customers (factory_id) WHERE removed_at IS NULL;

-- What a customer has on record, by kind (empty object = nothing).
CREATE OR REPLACE FUNCTION public._customer_history(p_customer uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'invoices',      NULLIF((SELECT COUNT(*) FROM sales WHERE customer_id = p_customer), 0),
    'receipts',      NULLIF((SELECT COUNT(*) FROM payments_received WHERE customer_id = p_customer), 0),
    'debts',         NULLIF((SELECT COUNT(*) FROM debts WHERE customer_id = p_customer), 0),
    'account_lines', NULLIF((SELECT COUNT(*) FROM customer_account_transactions WHERE customer_id = p_customer), 0),
    'adjustments',   NULLIF((SELECT COUNT(*) FROM customer_account_adjustments WHERE customer_id = p_customer), 0),
    'returns',       NULLIF((SELECT COUNT(*) FROM sales_returns WHERE customer_id = p_customer), 0),
    'containers',    NULLIF((SELECT COUNT(*) FROM container_movements
                              WHERE (from_type = 'customer' AND from_id = p_customer)
                                 OR (to_type = 'customer' AND to_id = p_customer)), 0)))
$$;
REVOKE ALL ON FUNCTION public._customer_history(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.remove_customer(p_customer uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_c customers%ROWTYPE;
  v_hist jsonb;
  v_containers numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'customers'::module_key, 'delete'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN RAISE EXCEPTION 'Give a reason for removing this customer'; END IF;
  SELECT * INTO v_c FROM customers WHERE id = p_customer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF v_c.removed_at IS NOT NULL THEN RAISE EXCEPTION '% has already been removed', v_c.name; END IF;

  v_hist := public._customer_history(p_customer);
  IF v_hist = '{}'::jsonb THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_c.factory_id, 'delete_customer', 'customers', p_customer::text, to_jsonb(v_c),
            jsonb_build_object('reason', btrim(p_reason)));
    DELETE FROM customers WHERE id = p_customer;
    RETURN jsonb_build_object('customer_id', p_customer, 'result', 'deleted');
  END IF;

  IF COALESCE(v_c.outstanding_balance, 0) > 0 THEN
    RAISE EXCEPTION '% still owes %. Collect it or write it off before removing them.', v_c.name, v_c.outstanding_balance;
  END IF;
  IF COALESCE(v_c.credit_balance, 0) > 0 THEN
    RAISE EXCEPTION '% has % paid in advance. Use it on a sale or refund it before removing them.', v_c.name, v_c.credit_balance;
  END IF;
  IF EXISTS (SELECT 1 FROM sales WHERE customer_id = p_customer AND status = 'pending_approval' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '% has a sale waiting for approval.', v_c.name;
  END IF;
  SELECT COALESCE(SUM(balance), 0) INTO v_containers FROM container_balances
   WHERE holder_type = 'customer' AND holder_id = p_customer;
  IF v_containers > 0 THEN
    RAISE EXCEPTION '% still holds % container(s). Record their return first.', v_c.name, v_containers;
  END IF;

  UPDATE customers SET removed_at = now(), removed_by = v_uid, removed_reason = btrim(p_reason),
         registered = false, updated_at = now()
   WHERE id = p_customer;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_c.factory_id, 'remove_customer', 'customers', p_customer::text,
          jsonb_build_object('registered', v_c.registered),
          jsonb_build_object('reason', btrim(p_reason), 'history', v_hist));
  RETURN jsonb_build_object('customer_id', p_customer, 'result', 'removed', 'history', v_hist);
END;
$$;
REVOKE ALL ON FUNCTION public.remove_customer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_customer(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_customer(p_customer uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_c customers%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(v_uid, 'customers'::module_key, 'delete'::action_key)
       OR public.has_permission(v_uid, 'customers'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_c FROM customers WHERE id = p_customer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF v_c.removed_at IS NULL THEN RAISE EXCEPTION '% is not removed', v_c.name; END IF;
  UPDATE customers SET removed_at = NULL, removed_by = NULL, removed_reason = NULL,
         registered = true, updated_at = now()
   WHERE id = p_customer;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_c.factory_id, 'restore_customer', 'customers', p_customer::text,
          jsonb_build_object('removed_at', v_c.removed_at, 'reason', v_c.removed_reason), NULL);
  RETURN jsonb_build_object('customer_id', p_customer, 'result', 'restored');
END;
$$;
REVOKE ALL ON FUNCTION public.restore_customer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_customer(uuid) TO authenticated;

-- Registering under a marketer: a removed customer's phone is refused with
-- a pointer to Restore (it used to be taken over like a walk-in record).
-- Same as 20261017150000 apart from that check.
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
    IF FOUND AND v_existing.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Phone % belongs to removed customer "%". Restore them on the Customers page instead.', v_phone, v_existing.name;
    END IF;
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

-- No new sale to a removed customer (create_sale also finds walk-ins by
-- name / phone, which could pick up a removed record).
CREATE OR REPLACE FUNCTION public._sales_no_removed_customer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text;
BEGIN
  SELECT name INTO v_name FROM customers WHERE id = NEW.customer_id AND removed_at IS NOT NULL;
  IF FOUND THEN
    RAISE EXCEPTION '% was removed from the customer list. Restore them on the Customers page before selling to them.', v_name;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sales_no_removed_customer ON public.sales;
CREATE TRIGGER trg_sales_no_removed_customer BEFORE INSERT ON public.sales
  FOR EACH ROW WHEN (NEW.customer_id IS NOT NULL) EXECUTE FUNCTION public._sales_no_removed_customer();

-- The duplicate-phone check covers removed customers too, with a hint.
CREATE OR REPLACE FUNCTION public._customers_no_duplicate_phone()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_norm text := public._norm_phone(NEW.phone);
  v_other record;
BEGIN
  IF NOT NEW.registered OR v_norm IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone AND OLD.registered THEN RETURN NEW; END IF;
  SELECT c.name, c.removed_at, r.full_name AS marketer INTO v_other
    FROM customers c LEFT JOIN sales_reps r ON r.id = c.sales_rep_id
   WHERE c.factory_id = NEW.factory_id AND c.id <> NEW.id
     AND (c.registered OR c.removed_at IS NOT NULL)
     AND public._norm_phone(c.phone) = v_norm
   LIMIT 1;
  IF FOUND THEN
    IF v_other.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Phone % belongs to removed customer "%". Restore them on the Customers page instead.', NEW.phone, v_other.name;
    END IF;
    RAISE EXCEPTION 'Phone % is already used by customer "%"%', NEW.phone, v_other.name,
      COALESCE(' (marketer ' || v_other.marketer || ')', '');
  END IF;
  RETURN NEW;
END;
$$;

-- ============ Marketers ============
-- Ownership stamps are frozen once set; a merge is the one thing allowed to
-- move them (elim.rep_merge = 'on' for the merging transaction only).
CREATE OR REPLACE FUNCTION public._sales_stamp_account_rep()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('elim.rep_merge', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    NEW.account_rep_id := OLD.account_rep_id;
    RETURN NEW;
  END IF;
  NEW.account_rep_id := COALESCE(NEW.sales_rep_id,
    (SELECT sales_rep_id FROM customers WHERE id = NEW.customer_id));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._debts_stamp_account_rep()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('elim.rep_merge', true) = 'on' THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION public._payments_stamp_account_rep()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sale sales%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('elim.rep_merge', true) = 'on' THEN RETURN NEW; END IF;
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

-- Container moves between holders on a merge.
ALTER TABLE public.container_movements DROP CONSTRAINT IF EXISTS container_movements_source_check;
ALTER TABLE public.container_movements ADD CONSTRAINT container_movements_source_check CHECK (source IN (
  'dispatch','dispatch_reversal','sale','sale_reversal','rep_return','rep_return_cancelled',
  'sales_return','sales_return_cancelled','return','issue','lost','purchase','damaged','merge'));

CREATE OR REPLACE FUNCTION public._marketer_history(p_rep uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'dispatches',  NULLIF((SELECT COUNT(*) FROM stock_dispatches WHERE sales_rep_id = p_rep), 0),
    'returns',     NULLIF((SELECT COUNT(*) FROM rep_returns WHERE sales_rep_id = p_rep), 0),
    'remittances', NULLIF((SELECT COUNT(*) FROM rep_remittances WHERE sales_rep_id = p_rep), 0),
    'sales',       NULLIF((SELECT COUNT(*) FROM sales WHERE sales_rep_id = p_rep OR account_rep_id = p_rep), 0),
    'debts',       NULLIF((SELECT COUNT(*) FROM debts WHERE sales_rep_id = p_rep OR account_rep_id = p_rep), 0),
    'receipts',    NULLIF((SELECT COUNT(*) FROM payments_received WHERE collected_by_rep = p_rep OR account_rep_id = p_rep), 0),
    'stock_moves', NULLIF((SELECT COUNT(*) FROM rep_stock_movements WHERE sales_rep_id = p_rep), 0),
    'containers',  NULLIF((SELECT COUNT(*) FROM container_movements
                            WHERE (from_type = 'sales_rep' AND from_id = p_rep) OR (to_type = 'sales_rep' AND to_id = p_rep)), 0),
    'customers',   NULLIF((SELECT COUNT(*) FROM customers WHERE sales_rep_id = p_rep), 0)))
$$;
REVOKE ALL ON FUNCTION public._marketer_history(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.remove_marketer(p_rep uuid, p_reason text, p_merge_into uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_src sales_reps%ROWTYPE;
  v_dst sales_reps%ROWTYPE;
  v_hist jsonb;
  v_row record;
  v_label text;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'delete'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_src FROM sales_reps WHERE id = p_rep FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  v_hist := public._marketer_history(p_rep);

  IF p_merge_into IS NULL THEN
    IF v_hist <> '{}'::jsonb THEN
      RAISE EXCEPTION '% has records (%). If they are a duplicate, merge them into the marketer they duplicate; otherwise set them inactive.',
        v_src.full_name, (SELECT string_agg(key || ' ' || value, ', ') FROM jsonb_each_text(v_hist));
    END IF;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_src.factory_id, 'delete_marketer', 'sales_reps', p_rep::text, to_jsonb(v_src),
            jsonb_build_object('reason', btrim(p_reason)));
    DELETE FROM rep_stock WHERE sales_rep_id = p_rep;
    DELETE FROM sales_reps WHERE id = p_rep;
    RETURN jsonb_build_object('result', 'deleted');
  END IF;

  -- Merge.
  IF p_merge_into = p_rep THEN RAISE EXCEPTION 'Pick the other marketer to merge into'; END IF;
  SELECT * INTO v_dst FROM sales_reps WHERE id = p_merge_into FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer to merge into not found'; END IF;
  IF v_dst.factory_id <> v_src.factory_id THEN RAISE EXCEPTION 'Both marketers must belong to the same factory'; END IF;
  IF v_dst.kind <> v_src.kind THEN RAISE EXCEPTION 'A marketer and a retail outlet cannot be merged'; END IF;
  v_label := 'Merged from duplicate ' || v_src.full_name || COALESCE(' (' || v_src.code || ')', '');

  PERFORM set_config('elim.rep_merge', 'on', true);
  PERFORM set_config('elim.reassign_reason', v_label || ': ' || btrim(p_reason), true);

  -- Stock held, and its trail (so the trail still adds up to what is held).
  FOR v_row IN SELECT * FROM rep_stock WHERE sales_rep_id = p_rep LOOP
    INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
    VALUES (p_merge_into, v_row.product_id, v_row.factory_id, v_row.quantity)
    ON CONFLICT (sales_rep_id, product_id) DO UPDATE SET quantity = rep_stock.quantity + EXCLUDED.quantity, updated_at = now();
  END LOOP;
  DELETE FROM rep_stock WHERE sales_rep_id = p_rep;
  UPDATE rep_stock_movements SET sales_rep_id = p_merge_into WHERE sales_rep_id = p_rep;

  UPDATE stock_dispatches SET sales_rep_id = p_merge_into WHERE sales_rep_id = p_rep;
  UPDATE rep_returns SET sales_rep_id = p_merge_into WHERE sales_rep_id = p_rep;
  UPDATE rep_remittances SET sales_rep_id = p_merge_into WHERE sales_rep_id = p_rep;
  UPDATE sales SET sales_rep_id = p_merge_into WHERE sales_rep_id = p_rep;
  UPDATE sales SET account_rep_id = p_merge_into WHERE account_rep_id = p_rep;
  UPDATE debts SET sales_rep_id = p_merge_into WHERE sales_rep_id = p_rep;
  UPDATE debts SET account_rep_id = p_merge_into WHERE account_rep_id = p_rep;
  UPDATE payments_received SET collected_by_rep = p_merge_into WHERE collected_by_rep = p_rep;
  UPDATE payments_received SET account_rep_id = p_merge_into WHERE account_rep_id = p_rep;
  UPDATE customers SET sales_rep_id = p_merge_into, updated_at = now() WHERE sales_rep_id = p_rep;
  UPDATE customer_followups SET sales_rep_id = p_merge_into WHERE sales_rep_id = p_rep;
  UPDATE customer_marketer_history SET from_rep_id = p_merge_into WHERE from_rep_id = p_rep;
  UPDATE customer_marketer_history SET to_rep_id = p_merge_into WHERE to_rep_id = p_rep;
  -- Day closes: keep the surviving marketer's where both closed the same day.
  DELETE FROM marketer_day_closes s
   WHERE s.sales_rep_id = p_rep
     AND EXISTS (SELECT 1 FROM marketer_day_closes d WHERE d.sales_rep_id = p_merge_into AND d.close_date = s.close_date);
  UPDATE marketer_day_closes SET sales_rep_id = p_merge_into WHERE sales_rep_id = p_rep;

  -- Containers held move across (container history is append-only).
  FOR v_row IN SELECT container_type_id, balance FROM container_balances
                WHERE holder_type = 'sales_rep' AND holder_id = p_rep AND balance > 0 LOOP
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id,
                                    quantity, source, reference, notes, created_by)
    VALUES (v_src.factory_id, v_row.container_type_id, 'sales_rep', p_rep, 'sales_rep', p_merge_into,
            v_row.balance, 'merge', v_src.code, v_label, v_uid);
  END LOOP;

  PERFORM set_config('elim.rep_merge', '', true);
  PERFORM set_config('elim.reassign_reason', '', true);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_src.factory_id, 'merge_marketer', 'sales_reps', p_rep::text, to_jsonb(v_src),
          jsonb_build_object('merged_into', p_merge_into, 'merged_into_name', v_dst.full_name,
                             'reason', btrim(p_reason), 'moved', v_hist));
  DELETE FROM sales_reps WHERE id = p_rep;
  RETURN jsonb_build_object('result', 'merged', 'merged_into', p_merge_into, 'moved', v_hist);
END;
$$;
REVOKE ALL ON FUNCTION public.remove_marketer(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_marketer(uuid, text, uuid) TO authenticated;

-- The accountant removes customers who no longer buy.
INSERT INTO public.role_permissions (role, module, action) VALUES ('accountant', 'customers', 'delete')
ON CONFLICT (role, module, action) DO NOTHING;
