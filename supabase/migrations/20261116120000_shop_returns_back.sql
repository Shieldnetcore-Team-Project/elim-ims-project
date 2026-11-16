-- ============================================================================
-- The Retail Shop returns products to the Warehouse again
-- ----------------------------------------------------------------------------
-- User (2026-11-16): "return the tab for retail shop to return products".
-- Undoes 20261104130000_shop_no_returns: the trigger that refused every
-- return from a retail outlet is dropped, so the shop's "Return unsold to
-- Warehouse" (return_shop_stock_to_warehouse), the Warehouse's Return
-- products for the shop (create_rep_return) and close_shop_day with unsold
-- work as they did before 4 Nov. Nothing else changes.
-- Paste into the Supabase SQL Editor. Safe to run again.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_no_shop_returns ON public.rep_returns;
DROP FUNCTION IF EXISTS public._no_shop_returns();

NOTIFY pgrst, 'reload schema';
