-- ============================================================================
-- CRITICAL FIX: has_permission(access_level) was silently broken for every
-- non-super-admin user
-- ----------------------------------------------------------------------------
-- 20260815094000 replaced role_permissions.access (access_level: 'read'/
-- 'write') with role_permissions.action (action_key), and added a NEW
-- has_permission(uuid, module_key, action_key) overload. It never touched the
-- OLDER has_permission(uuid, module_key, access_level) overload -- and
-- roughly 40 RLS policies created before that migration (on products, sales,
-- sale_items, customers, raw_materials, employees, expenses, payments_received,
-- debts, suppliers, audit_logs, settings, and more) are permanently bound to
-- that old overload via an explicit ::access_level cast baked into the policy
-- at CREATE POLICY time -- Postgres resolves a policy's function call to a
-- specific overload when the policy is created, not on each use.
--
-- That old overload's body still runs
-- `SELECT access FROM role_permissions/permission_overrides ...`, but those
-- columns were dropped and replaced with `action` in the same migration that
-- introduced the new overload. So calling it raises
-- `column "access" does not exist` for every non-super-admin caller
-- (super_admin short-circuits before reaching that query, which is exactly
-- why this went unnoticed -- every account that has actually exercised these
-- tables so far has been a super_admin).
--
-- In effect, EVERY one of those ~40 RLS policies has been throwing for any
-- non-super-admin role since 20260815094000. From the app's perspective a
-- failed query just means an empty result set (e.g. the Sales/Store "New
-- Sale" product dropdown showing no products for a cashier), which is what
-- surfaced this, but the same failure applies to every other table still
-- cast to ::access_level.
--
-- Fix: make the legacy access_level overload delegate to the current,
-- already-correct action_key-based has_permission(), which already treats
-- 'read'/'write' as bucket aliases over the real per-action grants (see
-- 20260815094000's CASE _action WHEN 'read'/'write' branches). Both domains
-- accept the literal values 'read' and 'write' (action_key's CHECK
-- constraint lists them as its 2 legacy aliases), so the cast below always
-- succeeds. This repairs every affected policy in one shot with zero policy
-- rewrites and no risk of a transcription mistake across ~40 policies.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.has_permission(
  _user_id uuid,
  _module public.module_key,
  _level public.access_level DEFAULT 'read'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_permission(_user_id, _module, _level::text::public.action_key);
$$;
