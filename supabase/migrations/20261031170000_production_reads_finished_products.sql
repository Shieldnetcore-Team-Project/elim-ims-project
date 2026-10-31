-- ============================================================================
-- Production staff see every finished product they can record
-- ----------------------------------------------------------------------------
-- User report (2026-10-31): Joy (Quality Control, with the Production page)
-- must record dispenser water -- Dispenser/Jug Water (New Jug) / (Old Jug)
-- -- but they were missing from her product box on Production, while an
-- admin saw them. products is readable with finished-goods read
-- (20260814093000) or, for QC, the bottle products only (20261027090000);
-- Joy has neither for the dispensers, so the rows were hidden.
--
-- "production read finished products": anyone who can view Production may
-- read the finished products -- exactly what the Production page lists
-- (active, product_type 'finished'). Nothing else of the catalogue, and no
-- write access.
-- ============================================================================

DROP POLICY IF EXISTS "production read finished products" ON public.products;
CREATE POLICY "production read finished products" ON public.products FOR SELECT TO authenticated
  USING (product_type::text = 'finished'
         AND public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key));

NOTIFY pgrst, 'reload schema';
