-- ============================================================================
-- Warehouse sales: let the store officer sell finished products straight from
-- the warehouse (Finished Products page -> New Sale), to walk-in customers,
-- registered customers/distributors and sales reps, using the same PosDialog
-- and create_sale() as the Sales page.
-- ----------------------------------------------------------------------------
-- store_officer already holds sales:view/confirm and distribution:view (so the
-- sales-rep and van-stock pickers load). What was missing:
--   * sales:create   -- create_sale() checks has_permission(...,'sales','write'),
--                       which resolves to create/edit/delete; the New Sale
--                       button is gated on the same grant (canWrite('sales')).
--   * customers:view -- the customer picker reads customers, whose RLS policy
--                       is has_permission(...,'customers','read').
-- Sales still go through the existing approval workflow, so a sale the store
-- officer creates waits for approval like any other.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT 'store_officer', 'sales', 'create'::action_key
UNION ALL
SELECT 'store_officer', 'customers', 'view'::action_key
ON CONFLICT DO NOTHING;
