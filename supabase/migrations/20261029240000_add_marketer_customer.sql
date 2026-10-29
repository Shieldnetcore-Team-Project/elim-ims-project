-- ============================================================================
-- add_marketer_customer: put a customer under a marketer from their account
-- ----------------------------------------------------------------------------
-- User request (2026-10-29): "Customers of <marketer>" on the marketer's
-- account (Accountant → Marketer & retail accounts) gets an "Add customer"
-- button, so all of e.g. Sunday's customers are listed there and the
-- accountant records their payments (full or part) per customer.
--
-- Either a new customer (name, phone, address) is created already assigned to
-- the marketer, or an existing customer (p_customer) is moved under them
-- (customers.sales_rep_id). Done here rather than by a direct insert because
-- the accountant usually has no customers write right. Same people who record
-- payments or post to marketers. A new name that is already on the customer
-- list is refused with a hint to pick them from the list instead; the
-- duplicate-phone check (trigger) still applies. Logged in the audit trail.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_marketer_customer(
  p_rep uuid,
  p_customer uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_address text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep sales_reps%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_old_rep uuid;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'distribution'::module_key, 'post'::action_key)
       OR public.has_permission(v_uid, 'customers'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_rep;
  IF NOT FOUND OR v_rep.kind <> 'rep' THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  IF p_customer IS NOT NULL THEN
    SELECT * INTO v_cust FROM customers WHERE id = p_customer AND factory_id = v_rep.factory_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
    IF v_cust.removed_at IS NOT NULL THEN
      RAISE EXCEPTION '% was removed from the customer list. Restore them on the Customers page first.', v_cust.name;
    END IF;
    v_old_rep := v_cust.sales_rep_id;
    IF v_old_rep IS NOT DISTINCT FROM p_rep THEN
      RAISE EXCEPTION '% is already one of %''s customers', v_cust.name, v_rep.full_name;
    END IF;
    UPDATE customers SET sales_rep_id = p_rep, updated_at = now() WHERE id = p_customer;
    v_id := p_customer;
    v_name := v_cust.name;
  ELSE
    IF v_name IS NULL THEN RAISE EXCEPTION 'Enter the customer''s name'; END IF;
    SELECT * INTO v_cust FROM customers
     WHERE factory_id = v_rep.factory_id AND lower(btrim(name)) = lower(v_name) AND removed_at IS NULL
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION '% is already on the customer list — pick them under "Existing customer" instead', v_cust.name;
    END IF;
    INSERT INTO customers(factory_id, name, phone, address, sales_rep_id, registered)
    VALUES (v_rep.factory_id, v_name, NULLIF(btrim(COALESCE(p_phone, '')), ''),
            NULLIF(btrim(COALESCE(p_address, '')), ''), p_rep, true)
    RETURNING id INTO v_id;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_rep.factory_id, 'add_marketer_customer', 'customers', v_id::text,
          CASE WHEN p_customer IS NOT NULL THEN jsonb_build_object('sales_rep_id', v_old_rep) END,
          jsonb_build_object('customer', v_name, 'sales_rep_id', p_rep, 'marketer', v_rep.full_name,
                             'new_customer', p_customer IS NULL));
  RETURN jsonb_build_object('customer_id', v_id, 'name', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public.add_marketer_customer(uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_marketer_customer(uuid, uuid, text, text, text) TO authenticated;
