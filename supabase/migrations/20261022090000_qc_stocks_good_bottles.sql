-- ============================================================================
-- QC stocks good bottles in and sends them to production
-- ----------------------------------------------------------------------------
-- The good blown bottles moved to the Quality Control page (Good bottles tab)
-- and QC now runs the whole of it there: inspect the shift's bottles, count
-- and accept the operator's stocking ("stock in"), and dispatch the stocked
-- bottles to production (PM). The Warehouse keeps finished products only.
--
-- Permissions (module 'preform-production'):
--   qc_officer gains confirm (accept a stocking) and export; it already had
--   reject (refuse a stocking). Not cancel: that also withdraws Store issues.
--   Dispatching to production, and cancelling a transfer not yet received,
--   now also accept confirm: whoever may stock bottles in may send them on.
--   QC is NOT given 'post', which would also let it issue preforms out of
--   the Store.
-- Dual control is unchanged: the operator who sent a stocking can't accept
-- it, and the person who dispatches can't be the PM receiver.
-- The Store / Warehouse roles keep every right they had.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT r.slug, 'preform-production'::module_key, g.action::action_key
FROM public.roles r
CROSS JOIN (VALUES ('view'), ('confirm'), ('reject'), ('print'), ('export')) AS g(action)
WHERE r.slug = 'qc_officer'
ON CONFLICT (role, module, action) DO NOTHING;

CREATE OR REPLACE FUNCTION public.dispatch_bottle_transfer(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_product uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_dept text := NULLIF(btrim(COALESCE(payload->>'to_department', '')), '');
  v_p products%ROWTYPE;
  v_ref text;
  v_id uuid;
  v_existing bottle_transfers%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('post') OR public._pf_can('confirm')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM bottle_transfers WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the receiving department'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole quantity above 0'; END IF;
  SELECT * INTO v_p FROM products WHERE id = v_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

  v_ref := public._pf_ref('BTR');
  PERFORM public._pf_product_move(v_product, -v_qty, 'transferred', v_ref, 'Transfer to ' || v_dept);
  INSERT INTO bottle_transfers(factory_id, reference, client_ref, product_id, to_department, quantity_sent, notes, sent_by)
  VALUES (v_p.factory_id, v_ref, v_client, v_product, v_dept, v_qty, NULLIF(btrim(COALESCE(payload->>'notes', '')), ''), auth.uid())
  RETURNING id INTO v_id;
  PERFORM public._pf_audit(v_p.factory_id, 'dispatch_bottle_transfer', 'bottle_transfers', v_id, NULL,
                           jsonb_build_object('reference', v_ref, 'to', v_dept, 'quantity', v_qty));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_bottle_transfer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_bottle_transfer(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_bottle_transfer(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_t bottle_transfers%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('cancel') OR public._pf_can('post') OR public._pf_can('confirm')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_t FROM bottle_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_t.status <> 'dispatched' THEN RAISE EXCEPTION 'Only a transfer not yet received can be cancelled'; END IF;
  PERFORM public._pf_product_move(v_t.product_id, v_t.quantity_sent, 'returned', v_t.reference, 'Transfer cancelled: ' || p_reason);
  UPDATE bottle_transfers SET status = 'cancelled', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._pf_audit(v_t.factory_id, 'cancel_bottle_transfer', 'bottle_transfers', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'cancelled');
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_bottle_transfer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_bottle_transfer(uuid, text) TO authenticated;
