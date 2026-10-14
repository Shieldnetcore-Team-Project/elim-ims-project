-- ============================================================================
-- Undo production releases, so a released batch can still be cancelled
-- ----------------------------------------------------------------------------
-- 20261014190000 guards batches: a batch can't be cancelled or edited down
-- once its goods have been released to the Warehouse ("Not possible: N more
-- of this product has already been released ..."). That guard is right, but
-- left no way out when a batch was recorded by mistake.
--
--   reverse_production_release(id, reason)
--     pending   -> cancelled (as if Production had withdrawn it)
--     accepted  -> reversed: the accepted quantity leaves finished-goods stock
--                  (refused if the Warehouse no longer holds it, e.g. sold),
--                  the damage records written at acceptance are voided, and
--                  the released quantity goes back into the production hall.
--
--   cancel_production_with_releases(batch id, reason)
--     Undoes just enough of the product's releases -- newest first, pending
--     ones before accepted ones -- to cover the batch, then cancels it.
--
-- Both take stock back out of the Warehouse, so they need the Warehouse's
-- acceptance right (production:confirm) or super_admin/chairman; cancelling a
-- batch also needs production:cancel.
-- ============================================================================

ALTER TABLE public.production_releases DROP CONSTRAINT IF EXISTS production_releases_status_check;
ALTER TABLE public.production_releases ADD CONSTRAINT production_releases_status_check
  CHECK (status IN ('pending','accepted','rejected','cancelled','reversed'));

CREATE OR REPLACE FUNCTION public.reverse_production_release(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row production_releases%ROWTYPE;
  v_before numeric;
  v_qty numeric;
BEGIN
  SELECT * INTO v_row FROM production_releases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release not found'; END IF;
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')
          OR public.has_permission(v_uid, 'production'::module_key, 'confirm'::action_key)) THEN
    RAISE EXCEPTION 'Only the Warehouse or an admin can reverse a release';
  END IF;

  IF v_row.status = 'pending' THEN
    UPDATE production_releases SET status = 'cancelled', reject_reason = p_reason WHERE id = p_id;
  ELSIF v_row.status = 'accepted' THEN
    v_qty := COALESCE(v_row.accepted_quantity, 0);
    SELECT current_stock INTO v_before FROM products WHERE id = v_row.product_id FOR UPDATE;
    IF v_qty > 0 THEN
      IF v_before < v_qty THEN
        RAISE EXCEPTION 'Cannot reverse %: the Warehouse holds only % of the % it accepted (the rest has gone out)',
          v_row.release_number, v_before, v_qty;
      END IF;
      UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_row.product_id;
      INSERT INTO inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_row.product_id, 'adjusted', v_qty, v_row.release_number,
              'Production release reversed' || COALESCE(': ' || NULLIF(btrim(p_reason), ''), ''),
              v_uid, v_before, v_before - v_qty);
    END IF;
    -- The damage/shortfall lines written when it was accepted no longer stand.
    UPDATE damage_records SET status = 'rejected'
     WHERE source_type = 'PRODUCTION' AND source_reference = v_row.release_number AND status = 'posted';
    UPDATE production_releases SET status = 'reversed', reject_reason = p_reason WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'This release is already %', v_row.status;
  END IF;

  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_production_release', 'production_releases', p_id::text,
          jsonb_build_object('status', v_row.status),
          jsonb_build_object('reason', p_reason, 'stock_removed', COALESCE(v_qty, 0)));
  RETURN jsonb_build_object('release_number', v_row.release_number, 'was', v_row.status);
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_production_release(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_production_release(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_production_with_releases(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_batch production%ROWTYPE;
  v_short numeric;
  v_rel record;
  v_undone text[] := '{}';
BEGIN
  SELECT * INTO v_batch FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'cancel'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  IF v_batch.status = 'pending_confirmation' THEN
    PERFORM pg_advisory_xact_lock(hashtext('production_hall:' || v_batch.factory_id::text || ':' || v_batch.product_id::text));
    -- How much of this batch has already left the hall.
    v_short := (v_batch.quantity_produced - COALESCE(v_batch.damaged_quantity, 0))
               - public._production_hall_available(v_batch.factory_id, v_batch.product_id);
    FOR v_rel IN
      SELECT id, release_number, quantity FROM production_releases
       WHERE factory_id = v_batch.factory_id AND product_id = v_batch.product_id
         AND status IN ('pending','accepted')
       ORDER BY (status = 'pending') DESC, released_at DESC
    LOOP
      EXIT WHEN v_short <= 0;
      PERFORM public.reverse_production_release(v_rel.id,
        COALESCE(NULLIF(btrim(p_reason), ''), 'Batch ' || v_batch.production_number || ' cancelled'));
      v_undone := v_undone || v_rel.release_number;
      v_short := v_short - v_rel.quantity;
    END LOOP;
  END IF;

  PERFORM public.cancel_production(p_id, p_reason);
  RETURN jsonb_build_object('cancelled', true, 'releases_undone', to_jsonb(v_undone));
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_production_with_releases(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_production_with_releases(uuid, text) TO authenticated;
