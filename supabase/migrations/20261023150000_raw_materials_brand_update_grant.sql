-- ============================================================================
-- Let the Store's Edit form set a material's brand
-- ----------------------------------------------------------------------------
-- UPDATE on raw_materials is granted column by column
-- (20260826090000_stock_adjustment_hardening_and_column_lockdown.sql).
-- raw_materials.brand_id (20261023110000) was applied before its GRANT was
-- added to that file, so saving the Edit form failed with "permission denied
-- for table raw_materials" (seen changing the supplier of Prima 29mm). This
-- grants it. Safe to run again.
-- ============================================================================

GRANT UPDATE (brand_id) ON public.raw_materials TO authenticated;
