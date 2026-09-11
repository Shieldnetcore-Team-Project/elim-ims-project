-- ============================================================================
-- FIX: role_permissions / permission_overrides were read-only for authenticated
-- ----------------------------------------------------------------------------
-- 20260814090000 created both tables with
--   GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated
-- but 20260815094000 rewrote the permission engine and did
--   DROP TABLE ... CASCADE; CREATE TABLE ...; GRANT SELECT ... TO authenticated;
-- Dropping a table drops its grants, and only SELECT was handed back.
--
-- 20260816092000 then added "role permissions write" / "permission overrides
-- write" RLS policies (re-created again in 20260816093000), which looks like it
-- restored write access — but it doesn't. Postgres checks the table-level
-- privilege AND the RLS policy; a policy cannot grant a privilege that was
-- never given. Net effect: every write to these two tables has been failing for
-- authenticated callers since 20260815094000, which silently broke
--   * the Role x Action matrix on the Roles & Permissions page
--   * the per-user override editor (that page and the Account Approvals
--     approve dialog)
-- Reads were unaffected, so the UI rendered correctly and only failed on save.
--
-- This restores the missing DML privileges. Authorisation is unchanged and
-- still enforced by the existing policies, which require
-- has_role(auth.uid(), 'super_admin') for any write. service_role already holds
-- GRANT ALL and was never affected.
-- ============================================================================

GRANT INSERT, UPDATE, DELETE ON public.role_permissions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.permission_overrides TO authenticated;
