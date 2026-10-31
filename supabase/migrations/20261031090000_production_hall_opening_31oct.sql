-- ============================================================================
-- Production hall: remove this morning's 50cl / 75cl batches; opening balance
-- 50cl 2,571 Pack, 75cl 1,612 Pack as at 31 Oct 2026
-- ----------------------------------------------------------------------------
-- The user (2026-10-31): clear this morning's production batch entries --
-- 50cl Bottle Water 556 Pack, 75cl Bottle Water 795 Pack -- and make the
-- production hall's opening balance this morning 50cl 2,571 Pack and 75cl
-- 1,612 Pack. The batches are removed, not cleared, so they leave Production
-- Runs and the report (an audit row keeps a copy). Warehouse stock is not
-- touched.
--
-- production_hall_openings   a product's hall balance at the start of a day
--                            (opening_date). The latest one per product is
--                            the starting point: the hall is that quantity
--                            plus batches produced on or after that day, less
--                            releases and clearances made on or after it
--                            (Lagos day). Everything before it is history.
--
-- Used by _production_hall_available (release checks), production_hall_stock
-- (Production page, dashboard) and the production report, which shows it as
-- the Opening. A batch produced before its product's opening can no longer be
-- edited or cancelled (_production_guard_cleared), as after a clearance.
--
-- Today's other batches and releases still count on top of the opening.
-- Stops without changing anything if 31 Oct has batches but none of 556 / 795
-- (with no batch that day, only the opening is recorded). Safe to run again.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.production_hall_openings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  opening_date date NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity >= 0),
  reason text NOT NULL,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (factory_id, product_id, opening_date)
);
GRANT SELECT ON public.production_hall_openings TO authenticated;
GRANT ALL ON public.production_hall_openings TO service_role;
ALTER TABLE public.production_hall_openings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "production hall openings read" ON public.production_hall_openings;
CREATE POLICY "production hall openings read" ON public.production_hall_openings FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key));
-- No write policy: rows are only written by migrations / SECURITY DEFINER code.

-- The day a product's hall starts from, or -infinity when it has no opening.
CREATE OR REPLACE FUNCTION public._production_hall_opening(p_factory uuid, p_product uuid)
RETURNS TABLE(opening_date date, quantity numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(o.opening_date, '-infinity'::date), COALESCE(o.quantity, 0)
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT h.opening_date, h.quantity FROM production_hall_openings h
       WHERE h.factory_id = p_factory AND h.product_id = p_product
       ORDER BY h.opening_date DESC LIMIT 1) o ON true;
$$;
REVOKE ALL ON FUNCTION public._production_hall_opening(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- hall = opening + good batches - releases (pending/accepted) - clearances,
-- each from the opening day on.
CREATE OR REPLACE FUNCTION public._production_hall_available(p_factory uuid, p_product uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH o AS (SELECT * FROM public._production_hall_opening(p_factory, p_product))
  SELECT
    (SELECT quantity FROM o)
  + COALESCE((SELECT SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0))
                FROM production p
               WHERE p.factory_id = p_factory AND p.product_id = p_product
                 AND p.status = 'pending_confirmation'
                 AND p.production_date >= (SELECT opening_date FROM o)), 0)
  - COALESCE((SELECT SUM(r.quantity)
                FROM production_releases r
               WHERE r.factory_id = p_factory AND r.product_id = p_product
                 AND r.status IN ('pending','accepted')
                 AND (r.released_at AT TIME ZONE 'Africa/Lagos')::date >= (SELECT opening_date FROM o)), 0)
  - COALESCE((SELECT SUM(c.quantity)
                FROM production_hall_clearances c
               WHERE c.factory_id = p_factory AND c.product_id = p_product
                 AND (c.cleared_at AT TIME ZONE 'Africa/Lagos')::date >= (SELECT opening_date FROM o)), 0);
$$;
REVOKE ALL ON FUNCTION public._production_hall_available(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- As 20261029130000 (Produced / Released since the latest clearance), now
-- also from the opening day; In hall is the true balance above.
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
    SELECT h.product_id, MAX(h.opening_date) AS opening_date
      FROM production_hall_openings h
     WHERE h.factory_id = p_factory
     GROUP BY h.product_id
  ), made AS (
    SELECT p.product_id,
           SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0))
             FILTER (WHERE (c.last_at IS NULL OR p.created_at > c.last_at)
                       AND (o.opening_date IS NULL OR p.production_date >= o.opening_date)) AS qty_since
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

-- A batch produced before its product's opening balance is history, like one
-- entered before a clearance: editing or cancelling it is refused.
CREATE OR REPLACE FUNCTION public._production_guard_cleared()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_at timestamptz;
  v_open date;
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
    v_open := (SELECT MAX(opening_date) FROM production_hall_openings
                WHERE factory_id = OLD.factory_id AND product_id = OLD.product_id);
    IF v_open IS NOT NULL AND OLD.production_date < v_open THEN
      RAISE EXCEPTION 'Batch % is before the production hall opening balance of % -- it can no longer be edited or cancelled',
        OLD.production_number, to_char(v_open, 'DD Mon YYYY');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Remove this morning's batches and record the opening balances. All or
-- nothing: any surprise stops the whole block.
DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_t record;
  v_product uuid;
  v_unit text;
  v_today uuid[];
  v_batches uuid[];
  v_found text;
  v_copy jsonb := '[]'::jsonb;
  v_hall numeric;
BEGIN
  IF v_factory IS NULL THEN
    RAISE EXCEPTION 'No Water factory -- nothing changed';
  END IF;

  FOR v_t IN
    SELECT * FROM (VALUES ('50cl bottle water', 556::numeric, 2571::numeric),
                          ('75cl bottle water', 795::numeric, 1612::numeric))
           AS t(name, batch_qty, opening)
  LOOP
    v_product := (SELECT id FROM products
                   WHERE factory_id = v_factory AND product_type = 'finished'
                     AND lower(btrim(name)) = v_t.name);
    IF v_product IS NULL THEN
      RAISE NOTICE '% not found -- not changed', v_t.name;
      CONTINUE;
    END IF;
    v_unit := (SELECT unit FROM products WHERE id = v_product);

    IF EXISTS (SELECT 1 FROM production_hall_openings
                WHERE factory_id = v_factory AND product_id = v_product AND opening_date = '2026-10-31') THEN
      RAISE NOTICE '%: opening balance for 31 Oct already recorded -- left as it is', v_t.name;
      CONTINUE;
    END IF;

    -- This morning's batches: produced or entered on 31 Oct, still in the hall.
    v_today := ARRAY(
      SELECT id FROM production
       WHERE factory_id = v_factory AND product_id = v_product AND status = 'pending_confirmation'
         AND (production_date = '2026-10-31'
              OR (created_at AT TIME ZONE 'Africa/Lagos')::date = '2026-10-31')
       ORDER BY created_at);
    -- The one batch of exactly that quantity, else all of today's if together
    -- they make it.
    v_batches := ARRAY(SELECT id FROM production WHERE id = ANY (v_today) AND v_t.batch_qty IN (quantity_produced, quantity_produced - COALESCE(damaged_quantity, 0)));
    IF cardinality(v_batches) > 1 THEN
      RAISE EXCEPTION '%: % batches of % today -- say which one to remove; nothing changed',
        v_t.name, cardinality(v_batches), v_t.batch_qty;
    END IF;
    IF cardinality(v_batches) = 0
       AND (SELECT COALESCE(SUM(quantity_produced), 0) FROM production WHERE id = ANY (v_today)) = v_t.batch_qty THEN
      v_batches := v_today;
    END IF;
    -- None at all on 31 Oct (already removed by hand): just the opening.
    IF cardinality(v_today) = 0 THEN
      RAISE NOTICE '%: no batch on 31 Oct to remove', v_t.name;
    ELSIF cardinality(v_batches) = 0 THEN
      v_found := (SELECT string_agg(production_number || ' ' || quantity_produced::text || ' (' || production_date::text || ')', ', ')
                    FROM production WHERE id = ANY (v_today));
      RAISE EXCEPTION '%: no batch of % found for 31 Oct (today: %) -- nothing changed',
        v_t.name, v_t.batch_qty, COALESCE(v_found, 'none');
    END IF;

    v_copy := v_copy || jsonb_build_object(
      'product', v_t.name,
      'batches', (SELECT jsonb_agg(to_jsonb(b)) FROM production b WHERE b.id = ANY (v_batches)),
      'opening', v_t.opening,
      'hall_before', public._production_hall_available(v_factory, v_product));
    UPDATE production_requests SET production_id = NULL WHERE production_id = ANY (v_batches);
    DELETE FROM workflow_approval_history WHERE module = 'production' AND entity_id = ANY (v_batches);
    DELETE FROM production WHERE id = ANY (v_batches);

    INSERT INTO production_hall_openings(factory_id, product_id, opening_date, quantity, reason, created_by)
    VALUES (v_factory, v_product, '2026-10-31', v_t.opening,
            'Production hall opening balance as at the morning of 31 Oct 2026 (user)', auth.uid());

    v_hall := public._production_hall_available(v_factory, v_product);
    RAISE NOTICE '%: % batch(es) removed; opening % %, in hall now % %',
      v_t.name, cardinality(v_batches), v_t.opening, COALESCE(v_unit, ''), v_hall, COALESCE(v_unit, '');
  END LOOP;

  IF jsonb_array_length(v_copy) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (auth.uid(), v_factory, 'delete', 'production', 'production-hall-opening-2026-10-31', v_copy,
            jsonb_build_object('reason',
              'This morning''s 50cl/75cl batches removed; hall opening 50cl 2,571 / 75cl 1,612 Pack as at 31 Oct 2026'));
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
