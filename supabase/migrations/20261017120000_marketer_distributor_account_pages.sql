-- ============================================================================
-- Marketer & retail accounts and Distributor accounts: their own pages
-- ----------------------------------------------------------------------------
-- Both lived only as tabs of the Accountant page (finance). They are now also
-- pages of their own under Finance → Marketer & Retail Accounts, each behind
-- its own module so they can be granted without the rest of Accounting:
--
--   marketer-accounts     /marketer-accounts     each marketer's / the retail
--                                               shop's account: goods out,
--                                               returns, cash remitted, owed
--   distributor-accounts  /distributor-accounts  each distributor's invoiced,
--                                               paid, outstanding and advance
--
-- Holding either does not switch on money anywhere else (the app's
-- "can see money" check stays Finance / Payments / Debts).
--
-- The Warehouse role (store_officer) gets view on both, for Kemi.
-- ============================================================================

-- ============ 1. New module keys ============
ALTER DOMAIN public.module_key DROP CONSTRAINT IF EXISTS module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
  'finance','inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
  'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
  'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns',
  'delete-requests','deleted-sales','permissions','auth-users',
  'marketer-accounts','distributor-accounts'
));

-- ============ 2. get_my_permissions(): include them ============
-- Same as 20261014210000, with the two new modules in the list.
CREATE OR REPLACE FUNCTION public.get_my_permissions()
 RETURNS TABLE(module module_key, action action_key)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_action public.action_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
    'finance','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns',
    'delete-requests','deleted-sales','permissions','auth-users',
    'marketer-accounts','distributor-accounts'
  ]::public.module_key[];
  v_concrete_actions public.action_key[] := ARRAY[
    'view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete'
  ]::public.action_key[];
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman') THEN
    FOREACH v_module IN ARRAY v_modules LOOP
      FOREACH v_action IN ARRAY v_concrete_actions LOOP
        module := v_module; action := v_action; RETURN NEXT;
      END LOOP;
    END LOOP;
    RETURN;
  END IF;
  FOREACH v_module IN ARRAY v_modules LOOP
    FOREACH v_action IN ARRAY v_concrete_actions LOOP
      IF public.has_permission(v_uid, v_module, v_action) THEN
        module := v_module; action := v_action; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  RETURN;
END;
$function$;

-- ============ 3. Distributor accounts: readable with the new module ============
-- Same as 20261015190000, accepting distributor-accounts view as well as finance.
CREATE OR REPLACE FUNCTION public.distributor_accounts(p_factory uuid)
RETURNS TABLE(customer_id uuid, name text, phone text, marketer text,
              invoices bigint, invoiced numeric, paid numeric, outstanding numeric,
              advance numeric, last_sale date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distributor-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.phone, sr.full_name,
         COALESCE(t.n, 0), COALESCE(t.invoiced, 0), COALESCE(t.paid, 0), COALESCE(t.outstanding, 0),
         COALESCE(c.credit_balance, 0)::numeric, t.last_sale
    FROM customers c
    LEFT JOIN sales_reps sr ON sr.id = c.sales_rep_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS n,
             SUM(s.grand_total)::numeric AS invoiced,
             SUM(s.amount_paid)::numeric AS paid,
             SUM(GREATEST(s.balance, 0))::numeric AS outstanding,
             MAX(s.sale_date)::date AS last_sale
        FROM sales s
       WHERE s.customer_id = c.id AND s.status = 'posted' AND s.deleted_at IS NULL
         AND NOT COALESCE(s.is_pr, false)
    ) t ON true
   WHERE c.factory_id = p_factory AND c.registered
   ORDER BY COALESCE(t.outstanding, 0) DESC, c.name;
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_accounts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_accounts(uuid) TO authenticated;

-- A distributor's receipts, for the account drill-down on that page.
DROP POLICY IF EXISTS "payments read for distributor accounts" ON public.payments_received;
CREATE POLICY "payments read for distributor accounts" ON public.payments_received FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distributor-accounts'::module_key, 'view'::action_key));

-- ============ 4. Who opens them ============
-- The Warehouse role (Kemi), and the accountant, who had both as Accountant
-- tabs already. super_admin / chairman have every module anyway.
INSERT INTO public.role_permissions (role, module, action) VALUES
  ('store_officer', 'marketer-accounts', 'view'),
  ('store_officer', 'distributor-accounts', 'view'),
  ('accountant', 'marketer-accounts', 'view'),
  ('accountant', 'distributor-accounts', 'view')
ON CONFLICT (role, module, action) DO NOTHING;
