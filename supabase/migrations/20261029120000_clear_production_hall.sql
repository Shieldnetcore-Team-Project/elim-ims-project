-- ============================================================================
-- Clear the Production Hall, to start entering production afresh
-- ----------------------------------------------------------------------------
-- The user asked (2026-10-29) for the stock Production produced and entered
-- but has NOT released to the Warehouse to be cleared, so the Production
-- Manager starts entering it afresh. Warehouse stock, and the releases the
-- Warehouse received, are not touched.
--
-- Hall stock per product = good quantity of batches in the hall - releases
-- pending or accepted (20261014190000). Nothing is deleted: the batches and
-- releases stay as history. Instead a clearance is recorded:
--
--   production_hall_clearances   quantity taken off a product's hall stock,
--                                with the reason, who and when
--
-- and the hall balance now also subtracts clearances:
--   hall = good batches - releases (pending/accepted) - clearances
-- (_production_hall_available, used by release_to_warehouse, and
-- production_hall_stock, which gains a 'cleared' column -- its return type
-- changes, so it is dropped and re-created).
--
-- Then, for every product with stock in the hall, one clearance of exactly
-- that stock is recorded, so every product's hall is 0. A release already
-- awaiting the Warehouse is not hall stock and stays for the Warehouse to
-- accept. Audited. Safe to run again (the second run finds the hall at 0).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.production_hall_clearances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  reason text NOT NULL,
  cleared_by uuid REFERENCES auth.users(id),
  cleared_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_hall_clearances_product_idx
  ON public.production_hall_clearances (factory_id, product_id, cleared_at);
GRANT SELECT ON public.production_hall_clearances TO authenticated;
GRANT ALL ON public.production_hall_clearances TO service_role;
ALTER TABLE public.production_hall_clearances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "production hall clearances read" ON public.production_hall_clearances;
CREATE POLICY "production hall clearances read" ON public.production_hall_clearances FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key));
-- No write policy: rows are only written by migrations / SECURITY DEFINER code.

CREATE OR REPLACE FUNCTION public._production_hall_available(p_factory uuid, p_product uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE((SELECT SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0))
                FROM production p
               WHERE p.factory_id = p_factory AND p.product_id = p_product
                 AND p.status = 'pending_confirmation'), 0)
  - COALESCE((SELECT SUM(r.quantity)
                FROM production_releases r
               WHERE r.factory_id = p_factory AND r.product_id = p_product
                 AND r.status IN ('pending','accepted')), 0)
  - COALESCE((SELECT SUM(c.quantity)
                FROM production_hall_clearances c
               WHERE c.factory_id = p_factory AND c.product_id = p_product), 0);
$$;
REVOKE ALL ON FUNCTION public._production_hall_available(uuid, uuid) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.production_hall_stock(uuid);
CREATE FUNCTION public.production_hall_stock(p_factory uuid)
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
  WITH made AS (
    SELECT p.product_id, SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0)) AS qty
      FROM production p
     WHERE p.factory_id = p_factory AND p.status = 'pending_confirmation'
     GROUP BY p.product_id
  ), out AS (
    SELECT r.product_id,
           SUM(r.quantity) FILTER (WHERE r.status IN ('pending','accepted')) AS released,
           SUM(r.quantity) FILTER (WHERE r.status = 'pending') AS pending
      FROM production_releases r
     WHERE r.factory_id = p_factory
     GROUP BY r.product_id
  ), clr AS (
    SELECT c.product_id, SUM(c.quantity) AS qty
      FROM production_hall_clearances c
     WHERE c.factory_id = p_factory
     GROUP BY c.product_id
  )
  SELECT pr.id, pr.name, pr.unit,
         COALESCE(m.qty, 0), COALESCE(o.released, 0), COALESCE(o.pending, 0),
         COALESCE(m.qty, 0) - COALESCE(o.released, 0) - COALESCE(c.qty, 0),
         COALESCE(c.qty, 0)
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

-- A batch entered before its product's hall was cleared is history: editing
-- or cancelling it would count as goods released and could reverse real
-- releases (cancel_production_with_releases), so it is refused. The whole
-- action rolls back, so nothing is reversed.
CREATE OR REPLACE FUNCTION public._production_guard_cleared()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_at timestamptz;
BEGIN
  IF OLD.status = 'pending_confirmation'
     AND (NEW.quantity_produced IS DISTINCT FROM OLD.quantity_produced
          OR NEW.damaged_quantity IS DISTINCT FROM OLD.damaged_quantity
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    SELECT MAX(cleared_at) INTO v_at FROM production_hall_clearances
     WHERE factory_id = OLD.factory_id AND product_id = OLD.product_id;
    IF v_at IS NOT NULL AND OLD.created_at <= v_at THEN
      RAISE EXCEPTION 'Batch % was cleared from the production hall on % -- it can no longer be edited or cancelled',
        OLD.production_number, to_char(v_at AT TIME ZONE 'Africa/Lagos', 'DD Mon YYYY');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_production_guard_cleared ON public.production;
CREATE TRIGGER trg_production_guard_cleared BEFORE UPDATE ON public.production
  FOR EACH ROW EXECUTE FUNCTION public._production_guard_cleared();

-- Clear what is in the hall now.
DO $$
DECLARE
  v_factory uuid;
  v_p record;
  v_left numeric;
  v_done jsonb := '[]'::jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  FOR v_p IN SELECT id, name, unit FROM products WHERE factory_id = v_factory ORDER BY name LOOP
    v_left := public._production_hall_available(v_factory, v_p.id);
    IF v_left <= 0 THEN
      IF v_left < 0 THEN
        RAISE NOTICE '%: hall shows % -- below zero, left alone', v_p.name, v_left;
      END IF;
      CONTINUE;
    END IF;
    INSERT INTO production_hall_clearances(factory_id, product_id, quantity, reason, cleared_by)
    VALUES (v_factory, v_p.id, v_left,
            'Production hall cleared to start entering production afresh (2026-10-29)', auth.uid());
    v_done := v_done || jsonb_build_object('product', v_p.name, 'cleared', v_left, 'unit', v_p.unit);
    RAISE NOTICE '%: % % cleared from the hall', v_p.name, v_left, COALESCE(v_p.unit, '');
  END LOOP;

  IF jsonb_array_length(v_done) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'clear_production_hall', 'production_hall_clearances', 'production-hall-2026-10-29',
            jsonb_build_object('products', v_done,
                               'reason', 'Unreleased production cleared from the hall to start afresh; Warehouse stock and releases not changed'));
  ELSE
    RAISE NOTICE 'The production hall is already clear';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
