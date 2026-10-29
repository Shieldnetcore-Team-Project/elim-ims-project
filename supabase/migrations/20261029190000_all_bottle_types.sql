-- ============================================================================
-- Every bottle size in Production → Process Material
-- ----------------------------------------------------------------------------
-- The user (2026-10-29): the PM's material dropdown must offer every bottle
-- type -- 35cl, 50cl, 75cl, 1Ltr, 1.5Ltr -- not only the ones QC has blown so
-- far. The dropdown lists the blown-bottle products (semi-finished,
-- 20261029110000), so each size missing one gets it here, in pieces, named
-- the way QC's blowing finds a size ("<n>cl" in the name, 20261024000000) so
-- QC's later blowing of that size uses it instead of adding a duplicate:
--   35cl Bottle, 50cl Bottle, 75cl Bottle, 1Ltr Bottle (100cl),
--   1.5Ltr Bottle (150cl)
-- A size that already has an active semi-finished bottle product, however it
-- is written ("50cl Bottle", "Empty Bottle (50cl)", "Empty Bottle (1.5L)",
-- "1Ltr ..."), is left alone. The list now shows bottles only, not every
-- semi-finished item (_pm_bottle_product). Needs 20261029110000 first.
-- Safe to run again.
-- ============================================================================

INSERT INTO public.products(factory_id, name, unit, unit_price, cost_price, current_stock, product_type, active)
SELECT f.id, s.name, 'Piece', 0, 0, 0, 'semi_finished', true
  FROM public.factories f
 CROSS JOIN (VALUES
   ('\m35\s*cl\M', '35cl Bottle'),
   ('\m50\s*cl\M', '50cl Bottle'),
   ('\m75\s*cl\M', '75cl Bottle'),
   ('\m100\s*cl\M|(^|[^0-9.])1\s*(l|ltr|litre|liter)\M', '1Ltr Bottle (100cl)'),
   ('\m150\s*cl\M|\m1\.5\s*(l|ltr|litre|liter)\M', '1.5Ltr Bottle (150cl)')) AS s(pattern, name)
 WHERE f.code = 'water'
   AND NOT EXISTS (
     SELECT 1 FROM public.products p
      WHERE p.factory_id = f.id AND p.product_type = 'semi_finished' AND p.active
        AND p.name ~* s.pattern);

-- Only bottles in the PM's list: a semi-finished product named as a bottle,
-- or one QC has sent the PM -- not every semi-finished item (e.g. a preform).
CREATE OR REPLACE FUNCTION public._pm_bottle_product(p_product uuid, p_factory uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM products p
     WHERE p.id = p_product AND p.factory_id = p_factory
       AND ((p.product_type = 'semi_finished' AND p.name ~* 'bottle')
            OR EXISTS (SELECT 1 FROM bottle_transfers t WHERE t.product_id = p.id)));
$$;
REVOKE ALL ON FUNCTION public._pm_bottle_product(uuid, uuid) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
