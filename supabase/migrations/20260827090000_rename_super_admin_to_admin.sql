-- ============================================================================
-- RENAME 'super_admin' ROLE LABEL -> 'Admin'
-- ----------------------------------------------------------------------------
-- Display-name change only. The slug stays 'super_admin' because it is
-- hard-wired into RLS policies, is_admin(), has_role(auth.uid(),'super_admin'),
-- and the has_permission() short-circuit — renaming the slug would break
-- access control. public.roles is the single source of truth for the label
-- shown in every role dropdown (signup, Users & Roles, Account Approvals),
-- so this one UPDATE relabels it everywhere.
-- ============================================================================

UPDATE public.roles SET label = 'Admin' WHERE slug = 'super_admin';
