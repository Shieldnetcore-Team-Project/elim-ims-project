-- ============================================================================
-- ACTION-LEVEL PERMISSIONS + WORKFLOW STATUS ENGINE — CORE
-- ----------------------------------------------------------------------------
-- Replaces the ranked read/write/approve access_level model with independent,
-- non-hierarchical action grants (view/create/edit/submit/approve/reject/
-- confirm/post/reverse/cancel/export/print/delete). A role can hold APPROVE
-- on a module with zero create ability, or CREATE with zero approve ability —
-- these are no longer linked.
--
-- SAFETY: has_permission() keeps accepting the legacy 'read'/'write' values
-- as aliases (resolved against the new action grants) so every RLS policy
-- and RPC guard elsewhere in the app that still calls has_permission(x,'read'
-- /'write') keeps working unchanged. Only the 6 maker-checker flows are
-- converted to the fine-grained actions in this pass; the remaining ~18
-- modules keep functioning under the legacy alias until a follow-up pass
-- converts their RLS policies to explicit actions too.
--
-- Also introduces a single, reusable workflow_status vocabulary and a
-- workflow_transitions table that is the one source of truth for which
-- status jumps are legal — no RPC hardcodes its own transition logic.
-- ============================================================================

-- ============ action_key domain (14 values: 12 real + 2 legacy aliases) ====
DO $$ BEGIN
  CREATE DOMAIN public.action_key AS text CHECK (VALUE IN (
    'view','create','edit','submit','approve','reject','confirm','post',
    'reverse','cancel','export','print','delete',
    'read','write' -- legacy aliases, resolved specially in has_permission()
  ));
EXCEPTION WHEN duplicate_object THEN
  ALTER DOMAIN public.action_key DROP CONSTRAINT IF EXISTS action_key_check;
  ALTER DOMAIN public.action_key ADD CONSTRAINT action_key_check CHECK (VALUE IN (
    'view','create','edit','submit','approve','reject','confirm','post',
    'reverse','cancel','export','print','delete','read','write'
  ));
END $$;

-- ============ workflow_status domain (13 canonical values) ============
DO $$ BEGIN
  CREATE DOMAIN public.workflow_status AS text CHECK (VALUE IN (
    'draft','submitted','pending_review','pending_approval','approved','rejected',
    'processing','completed','pending_confirmation','confirmed','posted','cancelled','reversed'
  ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============ workflow_transitions: the one source of truth for legal jumps ============
CREATE TABLE IF NOT EXISTS public.workflow_transitions (
  from_status public.workflow_status NOT NULL,
  to_status public.workflow_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
GRANT SELECT ON public.workflow_transitions TO authenticated;

TRUNCATE public.workflow_transitions;
INSERT INTO public.workflow_transitions (from_status, to_status) VALUES
  ('draft','submitted'), ('draft','cancelled'),
  ('submitted','pending_review'), ('submitted','pending_approval'), ('submitted','cancelled'),
  ('pending_review','pending_approval'), ('pending_review','rejected'), ('pending_review','cancelled'),
  ('pending_approval','approved'), ('pending_approval','rejected'), ('pending_approval','cancelled'),
  ('pending_approval','posted'), -- explicit business rule for flows with no separate manual post step
  ('approved','processing'), ('approved','posted'), ('approved','cancelled'),
  ('processing','completed'), ('processing','cancelled'),
  ('completed','posted'),
  ('pending_confirmation','confirmed'), ('pending_confirmation','rejected'),
  ('confirmed','posted'), ('confirmed','reversed'), -- payments: confirmed reverses directly, no separate posted state
  ('posted','reversed'),
  ('rejected','submitted'); -- allow resubmission after rejection
-- cancelled and reversed are terminal: no outgoing rows.

CREATE OR REPLACE FUNCTION public.assert_valid_transition(p_from public.workflow_status, p_to public.workflow_status)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflow_transitions WHERE from_status = p_from AND to_status = p_to) THEN
    RAISE EXCEPTION 'Invalid status transition: % -> %', p_from, p_to;
  END IF;
END;
$$;

-- ============ role_permissions / permission_overrides: junction-table shape ============
-- Dropping and recreating: the previous single-ranked `access` column can't
-- express independent action grants. This is pure permission CONFIGURATION
-- data (no transactional history), safe to rebuild and reseed in one step.
DROP TABLE IF EXISTS public.role_permissions CASCADE;
CREATE TABLE public.role_permissions (
  role public.app_role NOT NULL,
  module public.module_key NOT NULL,
  action public.action_key NOT NULL,
  PRIMARY KEY (role, module, action)
);
GRANT SELECT ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "role permissions read" ON public.role_permissions FOR SELECT TO authenticated USING (true);

DROP TABLE IF EXISTS public.permission_overrides CASCADE;
CREATE TABLE public.permission_overrides (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module public.module_key NOT NULL,
  action public.action_key NOT NULL,
  granted boolean NOT NULL,
  granted_by uuid REFERENCES auth.users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module, action)
);
GRANT SELECT ON public.permission_overrides TO authenticated;
GRANT ALL ON public.permission_overrides TO service_role;
ALTER TABLE public.permission_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "permission overrides read own" ON public.permission_overrides FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin'));

-- ============ has_permission() — action-based, with legacy read/write aliases ============
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _module public.module_key, _action public.action_key DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actions public.action_key[];
  v_result boolean;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;
  IF public.has_role(_user_id, 'super_admin') THEN RETURN true; END IF;

  -- Legacy aliases resolve against a bucket of concrete actions so existing
  -- RLS policies/RPC guards calling has_permission(x,'read'/'write') keep
  -- working unchanged against the new fine-grained grants.
  v_actions := CASE _action
    WHEN 'read' THEN ARRAY['view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete']::public.action_key[]
    WHEN 'write' THEN ARRAY['create','edit','delete']::public.action_key[]
    ELSE ARRAY[_action]
  END;

  SELECT EXISTS (
    SELECT 1 FROM unnest(v_actions) AS a(action)
    WHERE COALESCE(
      (SELECT po.granted FROM public.permission_overrides po
        WHERE po.user_id = _user_id AND po.module = _module AND po.action = a.action),
      EXISTS (
        SELECT 1 FROM public.role_permissions rp
        JOIN public.user_roles ur ON ur.role = rp.role
        WHERE ur.user_id = _user_id AND rp.module = _module AND rp.action = a.action
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ============ get_my_permissions() — returns every (module, action) the caller holds ============
-- Explicit DROP first: CREATE OR REPLACE cannot change a function's return
-- row type, and this changes TABLE(module, access) -> TABLE(module, action).
DROP FUNCTION IF EXISTS public.get_my_permissions();
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS TABLE(module public.module_key, action public.action_key)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_action public.action_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','raw-materials','finished-goods',
    'inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics','approvals'
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

-- ============================================================================
-- COMPREHENSIVE RESEED — every module/role, so nothing loses access.
-- Legacy 'read' role -> 'view'. Legacy 'write' role -> full CRUD bundle
-- (view/create/edit/delete/export/print), matching exactly what has_permission
-- (x,'write') used to unlock, so every existing RLS policy keeps behaving
-- identically. The 6 workflow-flow modules additionally get the fine-grained
-- submit/approve/reject/post/reverse/cancel actions per the design below.
-- super_admin is granted nothing here — it bypasses has_permission() entirely.
-- ============================================================================

-- ---- plain "view" (read-only) grants: every role that only had 'read' before ----
INSERT INTO public.role_permissions (role, module, action)
SELECT r, m, 'view' FROM
  unnest(ARRAY['chairman','accountant','cashier','sales','production','inventory_officer','store_officer','costing_officer','logistics','hr','payroll_officer']::app_role[]) r,
  unnest(ARRAY['dashboard']::module_key[]) m
UNION ALL SELECT 'chairman','sales','view'
UNION ALL SELECT 'chairman','production','view'
UNION ALL SELECT 'store_officer','production','view'
UNION ALL SELECT 'costing_officer','production','view'
UNION ALL SELECT 'chairman','production-requests','view'
UNION ALL SELECT 'inventory_officer','production-requests','view'
UNION ALL SELECT 'chairman','raw-materials','view'
UNION ALL SELECT 'production','raw-materials','view'
UNION ALL SELECT 'costing_officer','raw-materials','view'
UNION ALL SELECT 'chairman','finished-goods','view'
UNION ALL SELECT 'sales','finished-goods','view'
UNION ALL SELECT 'production','finished-goods','view'
UNION ALL SELECT 'chairman','inventory','view'
UNION ALL SELECT 'store_officer','inventory','view'
UNION ALL SELECT 'chairman','expenses','view'
UNION ALL SELECT 'chairman','payroll','view'
UNION ALL SELECT 'hr','payroll','view'
UNION ALL SELECT 'chairman','payments','view'
UNION ALL SELECT 'chairman','receipts-payments','view'
UNION ALL SELECT 'chairman','cash-flow','view'
UNION ALL SELECT 'chairman','debts','view'
UNION ALL SELECT 'cashier','debts','view'
UNION ALL SELECT 'sales','debts','view'
UNION ALL SELECT 'chairman','customers','view'
UNION ALL SELECT 'accountant','customers','view'
UNION ALL SELECT 'chairman','suppliers','view'
UNION ALL SELECT 'chairman','employees','view'
UNION ALL SELECT 'payroll_officer','employees','view'
UNION ALL SELECT 'chairman','reports','view'
UNION ALL SELECT 'sales','reports','view'
UNION ALL SELECT 'chairman','audit-logs','view'
UNION ALL SELECT 'chairman','costing','view'
UNION ALL SELECT 'chairman','logistics','view'
ON CONFLICT DO NOTHING;

-- ---- full CRUD bundle for roles that had 'write' before (non-workflow modules) ----
INSERT INTO public.role_permissions (role, module, action)
SELECT r::app_role, m::module_key, a FROM (VALUES
  ('cashier','sales'), ('sales','sales'),
  ('production','production'),
  ('production','production-requests'),
  ('inventory_officer','raw-materials'),
  ('store_officer','finished-goods'),
  ('inventory_officer','inventory'),
  ('sales','customers'),
  ('inventory_officer','suppliers'),
  ('hr','employees'),
  ('accountant','reports'),
  ('costing_officer','costing'),
  ('logistics','logistics'),
  ('accountant','receipts-payments'),
  ('cashier','receipts-payments')
) AS grants(r, m) CROSS JOIN unnest(ARRAY['view','create','edit','delete','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;

-- ---- 6 workflow flows: full action set, per the maker/checker design ----
-- Expenses: accountant is maker+checker (self-block via submitted_by protects
-- against self-approval); chairman is checker-only.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'accountant'::app_role,'expenses'::module_key, a FROM unnest(ARRAY['view','create','edit','delete','submit','cancel','approve','reject','post','reverse','export','print']::action_key[]) a
UNION ALL
SELECT 'chairman'::app_role,'expenses'::module_key, a FROM unnest(ARRAY['view','approve','reject','post','reverse','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Debt write-offs: accountant maker-only; chairman sole checker.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'accountant'::app_role,'debts'::module_key, a FROM unnest(ARRAY['view','create','submit','cancel','export','print']::action_key[]) a
UNION ALL
SELECT 'chairman'::app_role,'debts'::module_key, a FROM unnest(ARRAY['view','approve','reject','post','reverse','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Payments (confirm/reject/reverse — no separate approve/post step since the
-- money already moved at record time): cashier maker-only; accountant is
-- maker+checker (self-blocked); chairman checker-only.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'cashier'::app_role,'payments'::module_key, a FROM unnest(ARRAY['view','create','submit','export','print']::action_key[]) a
UNION ALL
SELECT 'accountant'::app_role,'payments'::module_key, a FROM unnest(ARRAY['view','create','submit','confirm','reject','reverse','export','print']::action_key[]) a
UNION ALL
SELECT 'chairman'::app_role,'payments'::module_key, a FROM unnest(ARRAY['view','confirm','reject','reverse','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Payroll: payroll_officer maker-only; chairman sole checker.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'payroll_officer'::app_role,'payroll'::module_key, a FROM unnest(ARRAY['view','create','submit','cancel','export','print']::action_key[]) a
UNION ALL
SELECT 'chairman'::app_role,'payroll'::module_key, a FROM unnest(ARRAY['view','approve','reject','post','reverse','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Stock write-offs (raw-materials / finished-goods reductions): the
-- inventory_officer/store_officer keep their routine CRUD from above (receive/
-- issue/transfer/positive-adjust are NOT part of this approval chain) plus
-- submit/cancel for write-off requests; chairman is sole checker.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'inventory_officer'::app_role,'raw-materials'::module_key, a FROM unnest(ARRAY['submit','cancel']::action_key[]) a
UNION ALL
SELECT 'chairman'::app_role,'raw-materials'::module_key, a FROM unnest(ARRAY['approve','reject','post','reverse']::action_key[]) a
UNION ALL
SELECT 'store_officer'::app_role,'finished-goods'::module_key, a FROM unnest(ARRAY['submit','cancel']::action_key[]) a
UNION ALL
SELECT 'chairman'::app_role,'finished-goods'::module_key, a FROM unnest(ARRAY['approve','reject','post','reverse']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Role grants: chairman is the only seeded maker+checker today (self-blocked
-- from approving their own request) — matches the original finding that
-- nobody but super_admin had any 'users' access at all.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'chairman'::app_role,'users'::module_key, a FROM unnest(ARRAY['view','create','submit','cancel','approve','reject','post','reverse','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;

-- Approvals queue page: read-only visibility for the checker roles.
INSERT INTO public.role_permissions (role, module, action) VALUES
  ('chairman','approvals','view'), ('accountant','approvals','view')
ON CONFLICT DO NOTHING;
