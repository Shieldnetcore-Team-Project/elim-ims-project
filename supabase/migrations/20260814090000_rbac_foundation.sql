
-- ============================================================
-- RBAC foundation. Rebuilds the role model around the confirmed org
-- structure and introduces a single source of truth for permissions
-- (data, not code) that RLS policies, RPC guards, and the frontend all
-- read from the same place via has_permission()/get_my_permissions().
-- No live user_roles/profiles.role_requested data exists yet, so the
-- role enum is rebuilt cleanly rather than accumulating retired values.
-- ============================================================

-- ---------- 1. Rebuild the role enum ----------
ALTER TYPE public.app_role RENAME TO app_role_old;

CREATE TYPE public.app_role AS ENUM (
  'super_admin','chairman','accountant','cashier','sales','production',
  'inventory_officer','store_officer','costing_officer','logistics','hr','payroll_officer'
);

ALTER TABLE public.user_roles ALTER COLUMN role TYPE public.app_role USING (role::text::public.app_role);
ALTER TABLE public.profiles ALTER COLUMN role_requested TYPE public.app_role USING (role_requested::text::public.app_role);

DROP TYPE public.app_role_old CASCADE;

-- Rebind to the new enum. is_admin() drops the retired factory_manager role.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'super_admin');
$$;

-- Two live spots referenced retired enum values and would break at runtime
-- the moment those values stopped existing -- fixed here, not left dangling
-- until the M4 RLS rewrite.
DROP POLICY IF EXISTS "read audit logs" ON public.audit_logs;
CREATE POLICY "read audit logs" ON public.audit_logs FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.approve_user(target_id uuid, granted_role public.app_role DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
  v_role app_role;
BEGIN
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  v_role := COALESCE(granted_role, v_profile.role_requested);
  IF v_role IS NULL THEN RAISE EXCEPTION 'A role must be selected to approve this account'; END IF;

  UPDATE profiles SET
    status = 'approved',
    approved_by = v_uid,
    approved_at = now(),
    rejected_by = NULL, rejected_reason = NULL, rejected_at = NULL
  WHERE id = target_id;

  INSERT INTO user_roles (user_id, role, factory_id)
  VALUES (target_id, v_role, v_profile.requested_factory_id)
  ON CONFLICT (user_id, role, factory_id) DO NOTHING;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id, 'Account approved', 'Your account has been approved. You can now log in.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'approve_user', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status),
          jsonb_build_object('status', 'approved', 'role', v_role));

  RETURN jsonb_build_object('status', 'approved', 'role', v_role);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_user(uuid, public.app_role) TO anon, authenticated;

-- ---------- 2. Module key / access level domains ----------
-- Mirrors ModuleKey in src/lib/permissions.ts. A domain (not an enum) so
-- adding a module later is an ALTER DOMAIN, not another type-rebuild.
CREATE DOMAIN public.module_key AS text CHECK (
  VALUE IN (
    'dashboard','sales','production','production-requests','raw-materials','finished-goods',
    'inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics'
  )
);

CREATE DOMAIN public.access_level AS text CHECK (VALUE IN ('read','write'));

-- ---------- 3. Permission matrix as data ----------
CREATE TABLE public.role_permissions (
  role public.app_role NOT NULL,
  module public.module_key NOT NULL,
  access public.access_level NOT NULL,
  PRIMARY KEY (role, module)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read role permissions" ON public.role_permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin manage role permissions" ON public.role_permissions FOR ALL TO authenticated
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

CREATE TABLE public.permission_overrides (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module public.module_key NOT NULL,
  access public.access_level NOT NULL,
  granted_by uuid REFERENCES auth.users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.permission_overrides TO authenticated;
GRANT ALL ON public.permission_overrides TO service_role;
ALTER TABLE public.permission_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own overrides" ON public.permission_overrides FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "admin read all overrides" ON public.permission_overrides FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "admin manage overrides" ON public.permission_overrides FOR ALL TO authenticated
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- ---------- 4. has_permission() / get_my_permissions() ----------
-- Single source of truth: RLS policies, RPC guards, and the frontend
-- (via get_my_permissions()) all resolve access through this one function.
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _module public.module_key, _level public.access_level DEFAULT 'read')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_override public.access_level;
  v_best public.access_level;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;

  IF public.has_role(_user_id, 'super_admin') THEN
    RETURN true;
  END IF;

  SELECT access INTO v_override FROM public.permission_overrides
   WHERE user_id = _user_id AND module = _module;
  IF v_override IS NOT NULL THEN
    RETURN (_level = 'read') OR (v_override = 'write');
  END IF;

  SELECT rp.access INTO v_best
    FROM public.role_permissions rp
    JOIN public.user_roles ur ON ur.role = rp.role
   WHERE ur.user_id = _user_id AND rp.module = _module
   ORDER BY (rp.access = 'write') DESC
   LIMIT 1;

  IF v_best IS NULL THEN RETURN false; END IF;
  RETURN (_level = 'read') OR (v_best = 'write');
END;
$$;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, public.module_key, public.access_level) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS TABLE(module public.module_key, access public.access_level)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','raw-materials','finished-goods',
    'inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics'
  ]::public.module_key[];
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  FOREACH v_module IN ARRAY v_modules LOOP
    IF public.has_permission(v_uid, v_module, 'write') THEN
      module := v_module; access := 'write'; RETURN NEXT;
    ELSIF public.has_permission(v_uid, v_module, 'read') THEN
      module := v_module; access := 'read'; RETURN NEXT;
    END IF;
  END LOOP;
  RETURN;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_permissions() TO authenticated;

-- ---------- 5. Seed the role -> module -> access matrix ----------
-- super_admin is intentionally not seeded here: has_permission() short-circuits
-- to true for super_admin regardless of what's in this table.
INSERT INTO public.role_permissions (role, module, access) VALUES
  ('chairman','dashboard','read'), ('chairman','sales','read'), ('chairman','production','read'),
  ('chairman','production-requests','read'), ('chairman','raw-materials','read'), ('chairman','finished-goods','read'),
  ('chairman','inventory','read'), ('chairman','expenses','read'), ('chairman','payroll','read'),
  ('chairman','payments','read'), ('chairman','receipts-payments','read'), ('chairman','cash-flow','read'),
  ('chairman','debts','read'), ('chairman','customers','read'), ('chairman','suppliers','read'),
  ('chairman','employees','read'), ('chairman','reports','read'), ('chairman','audit-logs','read'),
  ('chairman','costing','read'), ('chairman','logistics','read'),

  ('accountant','dashboard','read'), ('accountant','sales','read'), ('accountant','customers','read'),
  ('accountant','debts','write'), ('accountant','payments','write'), ('accountant','receipts-payments','write'),
  ('accountant','cash-flow','write'), ('accountant','expenses','write'), ('accountant','reports','write'),

  ('cashier','dashboard','read'), ('cashier','debts','read'),
  ('cashier','sales','write'), ('cashier','payments','write'), ('cashier','receipts-payments','write'),

  ('sales','dashboard','read'), ('sales','finished-goods','read'), ('sales','debts','read'), ('sales','reports','read'),
  ('sales','sales','write'), ('sales','customers','write'),

  ('production','dashboard','read'), ('production','raw-materials','read'), ('production','finished-goods','read'),
  ('production','production','write'), ('production','production-requests','write'),

  ('inventory_officer','dashboard','read'), ('inventory_officer','production-requests','read'),
  ('inventory_officer','raw-materials','write'), ('inventory_officer','suppliers','write'), ('inventory_officer','inventory','write'),

  ('store_officer','dashboard','read'), ('store_officer','production','read'), ('store_officer','inventory','read'),
  ('store_officer','finished-goods','write'),

  ('costing_officer','dashboard','read'), ('costing_officer','raw-materials','read'), ('costing_officer','production','read'),
  ('costing_officer','costing','write'),

  ('logistics','dashboard','read'),
  ('logistics','logistics','write'),

  ('hr','dashboard','read'), ('hr','payroll','read'),
  ('hr','employees','write'),

  ('payroll_officer','dashboard','read'), ('payroll_officer','employees','read'),
  ('payroll_officer','payroll','write');
