-- ============================================================================
-- Production Hall shows only what came after the last clear-out
-- ----------------------------------------------------------------------------
-- After the hall was cleared (20261029120000) the Production Hall still listed
-- each product with its old Produced and Cleared figures (50cl 820 / 820,
-- 75cl 1,487 / 1,487, In hall 0). The user (2026-10-29): take the figures out
-- and leave it empty so batches are entered afresh.
--
-- production_hall_stock now reports, per product, Produced and Released
-- counted only after that product's latest clearance (batches by when they
-- were entered, releases by when they were released), and Cleared as 0 --
-- a cleared product starts from nothing. In hall now is unchanged: the true
-- balance (batches - releases - clearances), so releasing still checks the
-- real figure. Products never cleared show their full history as before.
-- The Production page lists only rows with something in them, so a cleared
-- product with no new batch drops off. History stays in the tables and the
-- production report.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.production_hall_stock(p_factory uuid)
RETURNS TABLE(product_id uuid, product_name text, unit text,
              produced numeric, released numeric, awaiting_warehouse numeric, in_hall numeric,
              cleared numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  WITH clr AS (
    SELECT c.product_id, SUM(c.quantity) AS qty, MAX(c.cleared_at) AS last_at
      FROM production_hall_clearances c
     WHERE c.factory_id = p_factory
     GROUP BY c.product_id
  ), made AS (
    SELECT p.product_id,
           SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0)) AS qty,
           SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0))
             FILTER (WHERE c.last_at IS NULL OR p.created_at > c.last_at) AS qty_since
      FROM production p LEFT JOIN clr c ON c.product_id = p.product_id
     WHERE p.factory_id = p_factory AND p.status = 'pending_confirmation'
     GROUP BY p.product_id
  ), out AS (
    SELECT r.product_id,
           SUM(r.quantity) FILTER (WHERE r.status IN ('pending','accepted')) AS released,
           SUM(r.quantity) FILTER (WHERE r.status IN ('pending','accepted')
                                     AND (c.last_at IS NULL OR r.released_at > c.last_at)) AS released_since,
           SUM(r.quantity) FILTER (WHERE r.status = 'pending') AS pending
      FROM production_releases r LEFT JOIN clr c ON c.product_id = r.product_id
     WHERE r.factory_id = p_factory
     GROUP BY r.product_id
  )
  SELECT pr.id, pr.name, pr.unit,
         COALESCE(m.qty_since, 0), COALESCE(o.released_since, 0), COALESCE(o.pending, 0),
         COALESCE(m.qty, 0) - COALESCE(o.released, 0) - COALESCE(c.qty, 0),
         0::numeric
    FROM products pr
    LEFT JOIN made m ON m.product_id = pr.id
    LEFT JOIN out o ON o.product_id = pr.id
    LEFT JOIN clr c ON c.product_id = pr.id
   WHERE pr.factory_id = p_factory
     AND (m.qty IS NOT NULL OR o.released IS NOT NULL OR pr.active)
   ORDER BY pr.name;
END;
$$;
REVOKE ALL ON FUNCTION public.production_hall_stock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_hall_stock(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
