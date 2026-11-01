-- ============================================================================
-- The Store receives new jugs and sends jugs to QC
-- ----------------------------------------------------------------------------
-- User request (2026-11-01): the Store -- not only Warehouse → Dispenser &
-- jugs -- receives jugs and sends them to Quality Control (Store → Jugs).
-- The same functions and records as the Warehouse's buttons:
--   receive_new_jugs   new jugs bought in, counted into the factory's jugs
--                      ("Bought in", 20261027130000)
--   send_jugs_to_qc    a consignment of Old / New Jugs to QC, which accepts,
--                      verifies and posts the good ones to the PM
--                      (20261021100000); cancel_jugs_to_qc before QC accepts
-- now also accept the Store's own rights (raw-materials create or submit),
-- and the Store can read the jug records (QC consignments, the jug ledger)
-- with raw-materials view. Bodies otherwise unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._qc_jug_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'view'::action_key);
$$;

CREATE OR REPLACE FUNCTION public._can_view_containers()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'view'::action_key)
$$;

CREATE OR REPLACE FUNCTION public.receive_new_jugs(
  p_factory uuid, p_container_type uuid, p_quantity numeric,
  p_reference text DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ref text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'confirm'::action_key)
          OR public.has_permission(v_uid, 'distribution'::module_key, 'approve'::action_key)
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = p_container_type AND factory_id = p_factory) THEN
    RAISE EXCEPTION 'Jug type not found for this factory';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity <> trunc(p_quantity) THEN
    RAISE EXCEPTION 'Enter a whole number of jugs above 0';
  END IF;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Enter the delivery note or invoice number'; END IF;

  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, notes, created_by)
  VALUES (p_factory, p_container_type, 'external', NULL, 'warehouse', NULL, p_quantity,
          'purchase', v_ref, v_notes, v_uid)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, p_factory, 'receive_new_jugs', 'container_movements', v_id::text,
          jsonb_build_object('container_type_id', p_container_type, 'quantity', p_quantity,
                             'reference', v_ref, 'notes', v_notes));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.receive_new_jugs(uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_new_jugs(uuid, uuid, numeric, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.send_jugs_to_qc(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_kind text := NULLIF(payload->>'jug_kind', '');
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_existing qc_jug_batches%ROWTYPE;
  v_ref text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'finished-goods'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'finished-goods'::module_key, 'submit'::action_key)
          OR public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key)
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM qc_jug_batches WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  IF v_factory IS NULL OR NOT EXISTS (SELECT 1 FROM factories WHERE id = v_factory) THEN
    RAISE EXCEPTION 'factory_id required';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('old', 'new') THEN RAISE EXCEPTION 'Choose Old Jug or New Jug'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN
    RAISE EXCEPTION 'Enter a whole number of jugs above 0';
  END IF;
  v_ref := 'JQC-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-' || lpad((floor(random() * 99999))::int::text, 5, '0');
  INSERT INTO qc_jug_batches (factory_id, reference, client_ref, jug_kind, quantity_sent, send_notes, sent_by)
  VALUES (v_factory, v_ref, v_client, v_kind, v_qty, v_notes, v_uid)
  RETURNING id INTO v_id;
  PERFORM public._qc_jug_audit(v_factory, 'send_jugs_to_qc', v_id, payload);
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.send_jugs_to_qc(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_jugs_to_qc(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_jugs_to_qc(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_b qc_jug_batches%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'create'::action_key)
          OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'submit'::action_key)
          OR public.has_permission(auth.uid(), 'distribution'::module_key, 'create'::action_key)
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason for cancelling'; END IF;
  SELECT * INTO v_b FROM qc_jug_batches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consignment not found'; END IF;
  IF v_b.status <> 'sent' THEN RAISE EXCEPTION 'QC has already accepted % -- it can no longer be cancelled', v_b.reference; END IF;
  UPDATE qc_jug_batches SET status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._qc_jug_audit(v_b.factory_id, 'cancel_jugs_to_qc', p_id, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'reference', v_b.reference);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_jugs_to_qc(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_jugs_to_qc(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
