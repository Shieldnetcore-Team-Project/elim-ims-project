-- ============================================================================
-- Sales staff see every finished product (the shop's POS list)
-- ----------------------------------------------------------------------------
-- User request (2026-11-01): every product should appear on the Retail
-- shop's sales screen -- including the dispensers as Water + Jug and as
-- Water only (empty jug in). products is readable with finished-goods read
-- (20260814093000) and a few narrow policies (QC bottles 20261027090000,
-- Production 20261031170000); shop staff without finished-goods rights got
-- a short list. Anyone who can view Sales may now read the finished
-- products -- read only, nothing else of the catalogue.
-- ============================================================================

DROP POLICY IF EXISTS "sales read finished products" ON public.products;
CREATE POLICY "sales read finished products" ON public.products FOR SELECT TO authenticated
  USING (product_type::text = 'finished'
         AND (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
              OR public.has_permission(auth.uid(), 'sales'::module_key, 'create'::action_key)));

NOTIFY pgrst, 'reload schema';
