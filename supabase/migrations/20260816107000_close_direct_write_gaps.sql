-- ============================================================================
-- CLOSE REMAINING DIRECT-WRITE GAPS (spec 32/33)
-- ----------------------------------------------------------------------------
-- Every legitimate writer of the columns/tables below is already a
-- SECURITY DEFINER RPC (verified exhaustively — see plan notes), so these
-- REVOKEs only close the direct-client bypass; nothing legitimate breaks.
-- Column-level REVOKE is used (a new pattern in this codebase, previously
-- always table-level) specifically where a protected balance column shares
-- a row/edit-form with legitimately-directly-editable master-data columns.
-- ============================================================================

-- ============ Column-level: protect specific balance columns ============
REVOKE UPDATE (current_stock, cost_price) ON public.products FROM authenticated;
REVOKE UPDATE (current_stock) ON public.raw_materials FROM authenticated;
REVOKE UPDATE (outstanding_balance, total_purchases) ON public.customers FROM authenticated;

-- ============ Table-level: sales/sale_items are write-once-via-RPC only ============
REVOKE INSERT, UPDATE, DELETE ON public.sales FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.sale_items FROM authenticated;
DROP POLICY IF EXISTS "sales write" ON public.sales;
DROP POLICY IF EXISTS "sales write items" ON public.sale_items;
-- "sales read" / "sales read items" (SELECT) stay unchanged.

-- ============ Table-level: the ledgers themselves ============
REVOKE INSERT, UPDATE, DELETE ON public.raw_material_movements FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.inventory_movements FROM authenticated;
DROP POLICY IF EXISTS "raw-materials write movements" ON public.raw_material_movements;
DROP POLICY IF EXISTS "inventory write movements" ON public.inventory_movements;
-- "raw-materials read movements" / "inventory read movements" (SELECT) stay unchanged.
