-- ============================================================================
-- Marketers don't sign in
-- ----------------------------------------------------------------------------
-- 20261017150000 let a marketer with a linked login read their own account.
-- Marketers don't use the system: the accountant keeps each marketer's
-- records on their profile. Removed: the 'marketer' role (nobody holds it),
-- the "own account" paths in the access checks and RLS, and the follow-up
-- exception for a marketer's own customers. Access to marketer accounts is
-- now by module permission only. Distribution (Warehouse) users get the
-- marketer list with stock only; money columns come back empty for them.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._marketer_can_view(p_rep uuid, p_money boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  IF public.has_permission(v_uid, 'marketer-accounts'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'finance'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'payments'::module_key, 'view'::action_key)
     OR public.has_permission(v_uid, 'debts'::module_key, 'view'::action_key) THEN
    RETURN true;
  END IF;
  RETURN NOT p_money AND public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key);
END;
$$;

CREATE OR REPLACE FUNCTION public._customer_can_view(p_customer uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  RETURN public.has_permission(v_uid, 'marketer-accounts'::module_key, 'view'::action_key)
      OR public.has_permission(v_uid, 'customers'::module_key, 'view'::action_key)
      OR public.has_permission(v_uid, 'finance'::module_key, 'view'::action_key)
      OR public.has_permission(v_uid, 'payments'::module_key, 'view'::action_key)
      OR public.has_permission(v_uid, 'debts'::module_key, 'view'::action_key);
END;
$$;

DROP POLICY IF EXISTS "sales reps read own" ON public.sales_reps;
DROP POLICY IF EXISTS "customers read own marketer" ON public.customers;

CREATE OR REPLACE FUNCTION public.add_customer_followup(p_customer uuid, p_note text, p_follow_up_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_cust customers%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_cust FROM customers WHERE id = p_customer;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT (public.has_permission(v_uid, 'customers'::module_key, 'edit'::action_key)
       OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'create'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'create'::action_key)) THEN
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

CREATE OR REPLACE FUNCTION public.complete_customer_followup(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row customer_followups%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM customer_followups WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Follow-up not found'; END IF;
  IF NOT (public.has_permission(v_uid, 'customers'::module_key, 'edit'::action_key)
       OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'create'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.status <> 'open' THEN RAISE EXCEPTION 'This follow-up is not open'; END IF;
  UPDATE customer_followups SET status = 'done', done_by = v_uid, done_at = now(), done_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'status', 'done');
END;
$$;

-- Everyone who may see marketer accounts gets every marketer; Warehouse
-- (distribution view) gets the list with stock and customer counts only.
CREATE OR REPLACE FUNCTION public.marketer_directory(p_factory uuid)
RETURNS TABLE(
  id uuid, code text, full_name text, phone text, territory text, status text, kind text, created_at timestamptz,
  customers bigint, sales_value numeric, collected numeric, outstanding numeric, remitted numeric,
  unremitted numeric, stock_units numeric, last_sale date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_uid uuid := auth.uid(); v_money boolean; v_stock boolean;
BEGIN
  v_money := public.has_permission(v_uid, 'marketer-accounts'::module_key, 'view'::action_key)
          OR public.has_permission(v_uid, 'finance'::module_key, 'view'::action_key)
          OR public.has_permission(v_uid, 'payments'::module_key, 'view'::action_key)
          OR public.has_permission(v_uid, 'debts'::module_key, 'view'::action_key);
  v_stock := v_money OR public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key);
  IF NOT v_stock THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT r.id, r.code, r.full_name, r.phone, r.territory, r.status, r.kind, r.created_at,
    (SELECT COUNT(*) FROM customers c WHERE c.sales_rep_id = r.id AND c.registered),
    CASE WHEN v_money THEN (SELECT COALESCE(SUM(s.grand_total), 0) FROM sales s WHERE s.account_rep_id = r.id
        AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)) END,
    CASE WHEN v_money THEN (SELECT COALESCE(SUM(p.amount), 0) FROM payments_received p WHERE p.account_rep_id = r.id
        AND p.status NOT IN ('reversed','rejected')) END,
    CASE WHEN v_money THEN (SELECT COALESCE(SUM(d.outstanding), 0) FROM debts d LEFT JOIN sales s ON s.id = d.sale_id
      WHERE d.account_rep_id = r.id AND d.status <> 'paid' AND (s.id IS NULL OR s.deleted_at IS NULL)) END,
    CASE WHEN v_money THEN (SELECT COALESCE(SUM(m.amount), 0) FROM rep_remittances m WHERE m.sales_rep_id = r.id) END,
    CASE WHEN v_money THEN (SELECT COALESCE(SUM(p.amount), 0) FROM payments_received p JOIN sales s ON s.id = p.sale_id
      WHERE p.account_rep_id = r.id AND p.at_point_of_sale AND s.sales_rep_id = r.id
        AND p.status NOT IN ('reversed','rejected'))
      - (SELECT COALESCE(SUM(m.amount), 0) FROM rep_remittances m WHERE m.sales_rep_id = r.id) END,
    (SELECT COALESCE(SUM(rs.quantity), 0) FROM rep_stock rs WHERE rs.sales_rep_id = r.id),
    (SELECT MAX(s.sale_date) FROM sales s WHERE s.account_rep_id = r.id AND s.status = 'posted' AND s.deleted_at IS NULL)
  FROM sales_reps r
  WHERE r.factory_id = p_factory
  ORDER BY r.kind, r.full_name;
END;
$$;

DROP FUNCTION IF EXISTS public._is_own_marketer(uuid);
DELETE FROM public.roles r
 WHERE r.slug = 'marketer'
   AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.role = r.slug);

