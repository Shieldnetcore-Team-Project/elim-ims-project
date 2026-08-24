-- ============================================================================
-- FINANCE — module key + role permissions
-- ----------------------------------------------------------------------------
-- Finance was previously just a virtual sidebar grouping over Sales/Cash
-- Ledger/Expenses/Payroll/Reports with no page or permission of its own.
-- Adds a real 'finance' module so a Finance Overview page (cash position,
-- receivables, open PO commitments, this month's cost lines) can be gated
-- and reached directly, independent of which pages a role can also drill
-- into. Read-only: no create/edit/approve actions exist on this module,
-- it aggregates other modules' data rather than recording anything itself.
-- ============================================================================

ALTER DOMAIN public.module_key DROP CONSTRAINT module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard', 'sales', 'production', 'production-requests', 'purchase-orders', 'raw-materials', 'finished-goods',
  'finance', 'inventory', 'expenses', 'payroll', 'payments', 'receipts-payments', 'cash-flow', 'debts',
  'customers', 'suppliers', 'employees', 'reports', 'users', 'account-approvals', 'audit-logs',
  'settings', 'costing', 'logistics', 'approvals', 'goods-receiving'
));

CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS TABLE(module public.module_key, action public.action_key)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_action public.action_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
    'finance','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics','approvals','goods-receiving'
  ]::public.module_key[];
  v_concrete_actions public.action_key[] := ARRAY[
    'view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete'
  ]::public.action_key[];
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF public.has_role(v_uid, 'super_admin') THEN
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
$$;

-- Same roles that already see a finance-flavoured dashboard variant or
-- approve finance transactions get view access to the consolidated page.
INSERT INTO public.role_permissions (role, module, action)
SELECT r, 'finance', a
FROM unnest(ARRAY['accountant','payroll_officer','chairman']) r
CROSS JOIN unnest(ARRAY['view','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;
