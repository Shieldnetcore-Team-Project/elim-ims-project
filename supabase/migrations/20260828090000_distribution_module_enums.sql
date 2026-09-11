-- ============================================================================
-- DISTRIBUTION (Sales Reps) — enum / domain groundwork
-- ----------------------------------------------------------------------------
-- Adds the goods layer that sits between the Store (products.current_stock,
-- filled by confirm_production_batch) and a Sale: Store -> Sales Rep (van
-- stock) -> Sale. This first migration only touches the enum/domain
-- vocabulary, because a Postgres ENUM value added with ALTER TYPE ... ADD
-- VALUE cannot be used in the same transaction it is added in (same reason
-- 20260816095000_raw_material_movement_types.sql is its own migration).
-- The tables, RPCs and role grants that USE these values live in the next
-- three migrations.
-- ============================================================================

-- ============ 1. module_key: new 'distribution' module ============
-- Copy of the current list from 20260817093000_finance_module.sql, plus
-- 'distribution'. module_key is a DOMAIN, so this is a constraint swap, not
-- a type rebuild.
ALTER DOMAIN public.module_key DROP CONSTRAINT module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard', 'sales', 'production', 'production-requests', 'purchase-orders', 'raw-materials', 'finished-goods',
  'finance', 'inventory', 'expenses', 'payroll', 'payments', 'receipts-payments', 'cash-flow', 'debts',
  'customers', 'suppliers', 'employees', 'reports', 'users', 'account-approvals', 'audit-logs',
  'settings', 'costing', 'logistics', 'approvals', 'goods-receiving', 'distribution'
));

-- ============ 2. movement_type: store <-> rep transfers ============
-- inventory_movements.movement_type is a real ENUM. These two values make
-- the store side of a dispatch / accepted rep-return self-describing in the
-- finished-goods stock card instead of overloading 'transferred'/'returned'.
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'dispatched_to_rep';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'return_from_rep';

-- ============ 3. get_my_permissions(): surface the new module to the UI ============
-- Re-declared verbatim from 20260817093000_finance_module.sql with
-- 'distribution' appended to v_modules so usePermissions()/RequireAccess
-- can gate the new page.
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
    'settings','costing','logistics','approvals','goods-receiving','distribution'
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
