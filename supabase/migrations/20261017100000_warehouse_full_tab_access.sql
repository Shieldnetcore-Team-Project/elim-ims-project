-- ============================================================================
-- Warehouse manager: every Warehouse tab, to post and to take returns
-- ----------------------------------------------------------------------------
-- The Warehouse role (slug store_officer) gets what each Warehouse tab needs
-- to be opened and worked, not just viewed:
--
--   Stock                finished-goods       view, create, submit, cancel
--   Store requests       production-requests  view, submit
--   Orders               sales                view, create, submit, print, export
--   Returns              sales-returns        view, submit, cancel, confirm
--   Reps & outlet stock  distribution         view, create, edit, submit,
--   Bottle tracking                           confirm, cancel
--   Customers            customers            view, create, edit
--
-- distribution:submit is what logs a marketer's return (create_rep_return);
-- the Returns tab's "Marketer" box uses it. Inspecting a return stays
-- maker-checker: inspect_sales_return / inspect_rep_return refuse whoever
-- logged it, so someone else still inspects what she receives.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT 'store_officer', 'finished-goods'::module_key, a
  FROM unnest(ARRAY['view','create','submit','cancel']::action_key[]) a
UNION ALL
SELECT 'store_officer', 'production-requests'::module_key, a
  FROM unnest(ARRAY['view','submit']::action_key[]) a
UNION ALL
SELECT 'store_officer', 'sales'::module_key, a
  FROM unnest(ARRAY['view','create','submit','print','export']::action_key[]) a
UNION ALL
SELECT 'store_officer', 'sales-returns'::module_key, a
  FROM unnest(ARRAY['view','submit','cancel','confirm']::action_key[]) a
UNION ALL
SELECT 'store_officer', 'distribution'::module_key, a
  FROM unnest(ARRAY['view','create','edit','submit','confirm','cancel']::action_key[]) a
UNION ALL
SELECT 'store_officer', 'customers'::module_key, a
  FROM unnest(ARRAY['view','create','edit']::action_key[]) a
ON CONFLICT (role, module, action) DO NOTHING;
