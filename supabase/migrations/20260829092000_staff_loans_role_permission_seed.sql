-- ============================================================================
-- STAFF LOANS + FINES/CONTRIBUTIONS — role permission seed
-- ----------------------------------------------------------------------------
-- Loans and fines/contributions reuse the payroll module's actions:
--   create  -> record a loan / fine / contribution
--   approve/reject -> the checker step
--   cancel  -> cancel an active loan
--
-- payroll_officer already holds create/submit/cancel; chairman already holds
-- approve/reject. This adds:
--   hr          -> payroll.create   (HR logs loans/fines; today has view only)
--   accountant  -> payroll.view/approve/reject  (a second checker beside chairman)
-- super_admin needs no row (has_permission short-circuits).
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT 'hr', 'payroll', a FROM unnest(ARRAY['create']::action_key[]) a
UNION ALL
SELECT 'accountant', 'payroll', a FROM unnest(ARRAY['view','approve','reject']::action_key[]) a
ON CONFLICT DO NOTHING;
