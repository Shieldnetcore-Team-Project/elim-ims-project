-- ============================================================================
-- ROLE PERMISSIONS — costing dual control
-- ----------------------------------------------------------------------------
-- Checker: both accountant and chairman, matching the payments flow's
-- existing "Accountant / Chairman" combined checker precedent -- costing
-- feeds product cost_price, which feeds margin/finance reporting.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT 'costing_officer','costing', a FROM unnest(ARRAY['submit','cancel']::action_key[]) a
UNION ALL
SELECT r,'costing', a FROM unnest(ARRAY['accountant','chairman']) r, unnest(ARRAY['view','approve','reject']::action_key[]) a
ON CONFLICT DO NOTHING;
