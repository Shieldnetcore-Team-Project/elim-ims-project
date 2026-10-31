-- ============================================================================
-- Production hall: batches entered after the opening count, whatever their date
-- ----------------------------------------------------------------------------
-- User report (2026-10-31): Ruth entered 50cl Bottle Water 556 Pack this
-- morning but could not release it. Before noon a new entry is suggested as
-- last night's batch (production-shift.ts), so it was dated 30 Oct -- before
-- the hall's 31 Oct opening (20261031090000), which treated every batch
-- dated before it as history. The hall showed 0 and the batch was locked.
--
-- The opening is the hall's count when it was recorded. Now a batch counts
-- on top of it when it is dated on or after the opening day OR was entered
-- after the opening was recorded; only batches already in the system then
-- (dated earlier) are history. Releases and clearances are unchanged (from
-- the opening day on). Same rule in _production_hall_available (release
-- checks), production_hall_stock (Production page), the guard that locks
-- history batches, and the production report. Nothing else changes; Ruth's
-- batch is in the hall as soon as this runs.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._production_hall_available(p_factory uuid, p_product uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH o AS (
    SELECT h.opening_date, h.quantity, h.created_at FROM production_hall_openings h
     WHERE h.factory_id = p_factory AND h.product_id = p_product
     ORDER BY h.opening_date DESC LIMIT 1
  )
  SELECT
    COALESCE((SELECT quantity FROM o), 0)
  + COALESCE((SELECT SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0))
                FROM production p
               WHERE p.factory_id = p_factory AND p.product_id = p_product
                 AND p.status = 'pending_confirmation'
                 AND (NOT EXISTS (SELECT 1 FROM o)
                      OR p.production_date >= (SELECT opening_date FROM o)
                      OR p.created_at > (SELECT created_at FROM o))), 0)
  - COALESCE((SELECT SUM(r.quantity)
                FROM production_releases r
               WHERE r.factory_id = p_factory AND r.product_id = p_product
                 AND r.status IN ('pending','accepted')
                 AND (NOT EXISTS (SELECT 1 FROM o)
                      OR (r.released_at AT TIME ZONE 'Africa/Lagos')::date >= (SELECT opening_date FROM o))), 0)
  - COALESCE((SELECT SUM(c.quantity)
                FROM production_hall_clearances c
               WHERE c.factory_id = p_factory AND c.product_id = p_product
                 AND (NOT EXISTS (SELECT 1 FROM o)
                      OR (c.cleared_at AT TIME ZONE 'Africa/Lagos')::date >= (SELECT opening_date FROM o))), 0);
$$;
REVOKE ALL ON FUNCTION public._production_hall_available(uuid, uuid) FROM PUBLIC, anon, authenticated;

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
    SELECT c.product_id, MAX(c.cleared_at) AS last_at
      FROM production_hall_clearances c
     WHERE c.factory_id = p_factory
     GROUP BY c.product_id
  ), opn AS (
    SELECT DISTINCT ON (h.product_id) h.product_id, h.opening_date, h.created_at
      FROM production_hall_openings h
     WHERE h.factory_id = p_factory
     ORDER BY h.product_id, h.opening_date DESC
  ), made AS (
    SELECT p.product_id,
           SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0))
             FILTER (WHERE (c.last_at IS NULL OR p.created_at > c.last_at)
                       AND (o.opening_date IS NULL OR p.production_date >= o.opening_date
                            OR p.created_at > o.created_at)) AS qty_since
      FROM production p
      LEFT JOIN clr c ON c.product_id = p.product_id
      LEFT JOIN opn o ON o.product_id = p.product_id
     WHERE p.factory_id = p_factory AND p.status = 'pending_confirmation'
     GROUP BY p.product_id
  ), out AS (
    SELECT r.product_id,
           SUM(r.quantity) FILTER (WHERE r.status IN ('pending','accepted')) AS released,
           SUM(r.quantity) FILTER (WHERE r.status IN ('pending','accepted')
                                     AND (c.last_at IS NULL OR r.released_at > c.last_at)
                                     AND (o.opening_date IS NULL
                                          OR (r.released_at AT TIME ZONE 'Africa/Lagos')::date >= o.opening_date))
             AS released_since,
           SUM(r.quantity) FILTER (WHERE r.status = 'pending') AS pending
      FROM production_releases r
      LEFT JOIN clr c ON c.product_id = r.product_id
      LEFT JOIN opn o ON o.product_id = r.product_id
     WHERE r.factory_id = p_factory
     GROUP BY r.product_id
  )
  SELECT pr.id, pr.name, pr.unit,
         COALESCE(m.qty_since, 0), COALESCE(x.released_since, 0), COALESCE(x.pending, 0),
         public._production_hall_available(p_factory, pr.id),
         0::numeric
    FROM products pr
    LEFT JOIN made m ON m.product_id = pr.id
    LEFT JOIN out x ON x.product_id = pr.id
    LEFT JOIN opn o ON o.product_id = pr.id
   WHERE pr.factory_id = p_factory
     AND (m.product_id IS NOT NULL OR x.released IS NOT NULL OR o.product_id IS NOT NULL OR pr.active)
   ORDER BY pr.name;
END;
$$;
REVOKE ALL ON FUNCTION public.production_hall_stock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_hall_stock(uuid) TO authenticated;

-- History = dated before the opening AND already entered when it was recorded.
CREATE OR REPLACE FUNCTION public._production_guard_cleared()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_at timestamptz;
  v_open date;
  v_open_at timestamptz;
BEGIN
  IF OLD.status = 'pending_confirmation'
     AND (NEW.quantity_produced IS DISTINCT FROM OLD.quantity_produced
          OR NEW.damaged_quantity IS DISTINCT FROM OLD.damaged_quantity
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    v_at := (SELECT MAX(cleared_at) FROM production_hall_clearances
              WHERE factory_id = OLD.factory_id AND product_id = OLD.product_id);
    IF v_at IS NOT NULL AND OLD.created_at <= v_at THEN
      RAISE EXCEPTION 'Batch % was cleared from the production hall on % -- it can no longer be edited or cancelled',
        OLD.production_number, to_char(v_at AT TIME ZONE 'Africa/Lagos', 'DD Mon YYYY');
    END IF;
    v_open := (SELECT opening_date FROM production_hall_openings
                WHERE factory_id = OLD.factory_id AND product_id = OLD.product_id
                ORDER BY opening_date DESC LIMIT 1);
    v_open_at := (SELECT created_at FROM production_hall_openings
                   WHERE factory_id = OLD.factory_id AND product_id = OLD.product_id
                   ORDER BY opening_date DESC LIMIT 1);
    IF v_open IS NOT NULL AND OLD.production_date < v_open AND OLD.created_at <= v_open_at THEN
      RAISE EXCEPTION 'Batch % is before the production hall opening balance of % -- it can no longer be edited or cancelled',
        OLD.production_number, to_char(v_open, 'DD Mon YYYY');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE v_p record;
BEGIN
  FOR v_p IN
    SELECT p.name, public._production_hall_available(p.factory_id, p.id) AS hall
      FROM products p
     WHERE EXISTS (SELECT 1 FROM production_hall_openings h WHERE h.product_id = p.id)
     ORDER BY p.name
  LOOP
    RAISE NOTICE '%: in hall now %', v_p.name, v_p.hall;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
