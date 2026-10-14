-- ============================================================================
-- Production hall stock and releases to the Warehouse
-- ----------------------------------------------------------------------------
-- How the factory actually works: Production records what it produces, and
-- that stock sits in the PRODUCTION HALL. Through the day Production RELEASES
-- quantities to the Warehouse in parts (often against what the Warehouse has
-- requested); the Warehouse accepts each release into finished-goods stock.
-- Production runs past the Warehouse's 6 p.m. close, so the night's output
-- stays in the hall overnight -- the day's closing balance, and the next
-- day's opening balance -- and is released the next morning.
--
-- Before this, a batch went to the Warehouse whole, in one acceptance. Now:
--
--   production (batch)       recorded by Production; status stays
--                            'pending_confirmation', which now means "recorded,
--                            in the production hall". Its good quantity
--                            (produced - damaged at production) is hall stock.
--   production_releases      Production releases N units of a product from the
--                            hall (never more than is there). Status:
--                              pending   released, awaiting the Warehouse
--                              accepted  Warehouse took it into stock
--                              rejected  Warehouse refused it -> back in the hall
--                              cancelled Production withdrew it -> back in the hall
--
--   hall balance(product) = good quantity of live batches
--                           - quantity of pending/accepted releases
--
-- Batches the Warehouse already accepted the old way (status confirmed/posted)
-- went straight to stock, so they count on neither side.
--
-- Permissions reuse the production module: Production releases with
-- production:create and withdraws with production:cancel; the Warehouse
-- accepts with production:confirm and refuses with production:reject (the
-- grants store_officer already has for accepting batches).
-- ============================================================================

-- ============ 1. production_releases ============
CREATE TABLE IF NOT EXISTS public.production_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  release_number text NOT NULL UNIQUE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit text,
  production_request_id uuid REFERENCES public.production_requests(id),
  notes text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','cancelled')),
  released_by uuid REFERENCES auth.users(id),
  released_by_name text,
  released_at timestamptz NOT NULL DEFAULT now(),
  received_quantity numeric(14,3),
  accepted_quantity numeric(14,3),
  damaged_quantity numeric(14,3),
  rejected_quantity numeric(14,3),
  accepted_by uuid REFERENCES auth.users(id),
  accepted_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_releases_factory_product_idx
  ON public.production_releases (factory_id, product_id, status);
GRANT SELECT ON public.production_releases TO authenticated;
GRANT ALL ON public.production_releases TO service_role;
ALTER TABLE public.production_releases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "production releases read" ON public.production_releases;
CREATE POLICY "production releases read" ON public.production_releases FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key));
-- No INSERT/UPDATE/DELETE policy: releases only move through the RPCs below.

-- ============ 2. Hall balance ============
-- Internal: units of a product in the hall right now.
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
                 AND r.status IN ('pending','accepted')), 0);
$$;
REVOKE ALL ON FUNCTION public._production_hall_available(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Per product, for the Production page: produced into the hall, released out,
-- still in the hall.
CREATE OR REPLACE FUNCTION public.production_hall_stock(p_factory uuid)
RETURNS TABLE(product_id uuid, product_name text, unit text,
              produced numeric, released numeric, awaiting_warehouse numeric, in_hall numeric)
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
  )
  SELECT pr.id, pr.name, pr.unit,
         COALESCE(m.qty, 0), COALESCE(o.released, 0), COALESCE(o.pending, 0),
         COALESCE(m.qty, 0) - COALESCE(o.released, 0)
    FROM products pr
    LEFT JOIN made m ON m.product_id = pr.id
    LEFT JOIN out o ON o.product_id = pr.id
   WHERE pr.factory_id = p_factory
     AND (m.qty IS NOT NULL OR o.released IS NOT NULL OR pr.active)
   ORDER BY pr.name;
END;
$$;
REVOKE ALL ON FUNCTION public.production_hall_stock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_hall_stock(uuid) TO authenticated;

-- ============ 3. Production releases to the Warehouse ============
CREATE OR REPLACE FUNCTION public.release_to_warehouse(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_request uuid := NULLIF(payload->>'production_request_id', '')::uuid;
  v_notes text := NULLIF(btrim(payload->>'notes'), '');
  v_name text := NULLIF(btrim(payload->>'released_by_name'), '');
  v_unit text;
  v_available numeric;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL OR v_product IS NULL THEN RAISE EXCEPTION 'factory_id and product_id are required'; END IF;
  IF NOT public.has_production_scope_access(v_uid, v_factory) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity to release must be > 0'; END IF;

  SELECT unit INTO v_unit FROM products WHERE id = v_product AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found in this factory'; END IF;
  IF v_request IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM production_requests WHERE id = v_request AND factory_id = v_factory
  ) THEN
    RAISE EXCEPTION 'Request not found in this factory';
  END IF;

  -- One release per product at a time, so two people can't both release the
  -- same hall stock.
  PERFORM pg_advisory_xact_lock(hashtext('production_hall:' || v_factory::text || ':' || v_product::text));
  v_available := public._production_hall_available(v_factory, v_product);
  IF v_qty > v_available THEN
    RAISE EXCEPTION 'Only % % of this product is in the production hall', v_available, COALESCE(v_unit, '');
  END IF;

  v_number := 'REL-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  INSERT INTO production_releases (factory_id, release_number, product_id, quantity, unit,
                                   production_request_id, notes, released_by, released_by_name)
  VALUES (v_factory, v_number, v_product, v_qty, v_unit, v_request, v_notes, v_uid,
          COALESCE(v_name, (SELECT full_name FROM profiles WHERE id = v_uid)))
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'release_to_warehouse', 'production_releases', v_id::text,
          jsonb_build_object('release_number', v_number, 'product_id', v_product, 'quantity', v_qty));

  RETURN jsonb_build_object('id', v_id, 'release_number', v_number, 'in_hall_after', v_available - v_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.release_to_warehouse(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_to_warehouse(jsonb) TO authenticated;

-- Production withdraws a release the Warehouse hasn't acted on yet.
CREATE OR REPLACE FUNCTION public.cancel_production_release(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row production_releases%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM production_releases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'cancel'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Only a release still awaiting the Warehouse can be withdrawn'; END IF;
  UPDATE production_releases SET status = 'cancelled', reject_reason = p_reason WHERE id = p_id;
  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'cancel_production_release', 'production_releases', p_id::text,
          jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('cancelled', true);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_production_release(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_production_release(uuid, text) TO authenticated;

-- ============ 4. Warehouse accepts / rejects a release ============
-- p_received: what the Warehouse actually counted; damaged and rejected come
-- out of that; the rest enters finished-goods stock. Anything released but not
-- received is a shortfall, written to the damage ledger so it's accounted for.
CREATE OR REPLACE FUNCTION public.accept_production_release(
  p_id uuid, p_received numeric, p_damaged numeric DEFAULT 0, p_rejected numeric DEFAULT 0,
  p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row production_releases%ROWTYPE;
  v_damaged numeric := COALESCE(p_damaged, 0);
  v_rejected numeric := COALESCE(p_rejected, 0);
  v_accepted numeric;
  v_short numeric;
  v_before numeric;
  v_cost numeric;
BEGIN
  SELECT * INTO v_row FROM production_releases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'confirm'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.released_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Warehouse acceptance must be done by someone other than who released the goods';
  END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This release is already %', v_row.status; END IF;
  IF p_received IS NULL OR p_received < 0 THEN RAISE EXCEPTION 'Quantity received must be >= 0'; END IF;
  IF p_received > v_row.quantity THEN
    RAISE EXCEPTION 'Received (%) cannot be more than was released (%)', p_received, v_row.quantity;
  END IF;
  IF v_damaged < 0 OR v_rejected < 0 THEN RAISE EXCEPTION 'Damaged/rejected quantities cannot be negative'; END IF;
  IF v_damaged + v_rejected > p_received THEN RAISE EXCEPTION 'Damaged + rejected cannot exceed quantity received'; END IF;

  v_accepted := p_received - v_damaged - v_rejected;
  v_short := v_row.quantity - p_received;

  UPDATE production_releases SET
    status = 'accepted', received_quantity = p_received, accepted_quantity = v_accepted,
    damaged_quantity = v_damaged, rejected_quantity = v_rejected,
    accepted_by = v_uid, accepted_at = now(), reject_reason = p_comment
  WHERE id = p_id;

  SELECT current_stock, cost_price INTO v_before, v_cost FROM products WHERE id = v_row.product_id FOR UPDATE;
  IF v_accepted > 0 THEN
    UPDATE products SET current_stock = current_stock + v_accepted, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'produced', v_accepted, v_row.release_number,
            'Production release accepted by Warehouse', v_uid, v_before, v_before + v_accepted);
  END IF;

  IF v_damaged > 0 THEN
    INSERT INTO damage_records (factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.release_number, v_row.product_id, v_damaged, v_row.unit, v_cost,
            'Damaged on Warehouse acceptance', v_uid, 'posted');
  END IF;
  IF v_rejected > 0 THEN
    INSERT INTO damage_records (factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.release_number, v_row.product_id, v_rejected, v_row.unit, v_cost,
            'Rejected on Warehouse acceptance', v_uid, 'posted');
  END IF;
  IF v_short > 0 THEN
    INSERT INTO damage_records (factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.release_number, v_row.product_id, v_short, v_row.unit, v_cost,
            'Short on release: released but not received by Warehouse', v_uid, 'posted');
  END IF;

  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'accept_production_release', 'production_releases', p_id::text,
          jsonb_build_object('current_stock', v_before),
          jsonb_build_object('current_stock', v_before + v_accepted, 'accepted_quantity', v_accepted,
                             'damaged', v_damaged, 'rejected', v_rejected, 'short', v_short));

  RETURN jsonb_build_object('accepted_quantity', v_accepted, 'short', v_short);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_production_release(uuid, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_production_release(uuid, numeric, numeric, numeric, text) TO authenticated;

-- Warehouse refuses the whole release: the goods go back into the hall.
CREATE OR REPLACE FUNCTION public.reject_production_release(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row production_releases%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM production_releases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'reject'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This release is already %', v_row.status; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  UPDATE production_releases
     SET status = 'rejected', reject_reason = p_reason, accepted_by = v_uid, accepted_at = now()
   WHERE id = p_id;
  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_production_release', 'production_releases', p_id::text,
          jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('rejected', true);
END;
$$;
REVOKE ALL ON FUNCTION public.reject_production_release(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_production_release(uuid, text) TO authenticated;

-- ============ 5. Guard: a batch can't shrink below what was released ============
-- Editing a batch down, cancelling it, or the Warehouse rejecting it the old
-- way would leave more released than produced. Checked after the change, per
-- product, against everything released so far.
CREATE OR REPLACE FUNCTION public._production_guard_released()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_available numeric;
BEGIN
  IF NEW.quantity_produced IS DISTINCT FROM OLD.quantity_produced
     OR NEW.damaged_quantity IS DISTINCT FROM OLD.damaged_quantity
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    v_available := public._production_hall_available(OLD.factory_id, OLD.product_id);
    IF v_available < 0 THEN
      RAISE EXCEPTION 'Not possible: % more of this product has already been released to the Warehouse than this change would leave produced',
        -v_available;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_production_guard_released ON public.production;
CREATE TRIGGER trg_production_guard_released
  AFTER UPDATE ON public.production
  FOR EACH ROW EXECUTE FUNCTION public._production_guard_released();

-- ============ 6. Go-live reset knows the new table ============
-- (supabase/scripts/go_live_reset.sql lists production_releases as cleared.)
