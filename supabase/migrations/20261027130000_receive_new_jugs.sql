-- ============================================================================
-- Receive new jugs into the Warehouse
-- ----------------------------------------------------------------------------
-- Factory request (user, 2026-10-27): a button on Warehouse → Dispenser &
-- jugs where new jugs bought in are received / stocked into the Warehouse.
--
-- The container ledger already has the move (record_container_movement kind
-- 'purchase': outside -> warehouse, shown as "Bought in"), but it needs
-- distribution approve, which only managers hold -- the Warehouse
-- (store_officer, store_warehouse) could not stock new jugs. The Warehouse
-- already counts jugs in (verify_jug_return, distribution confirm), so the
-- same right receives new ones.
--
-- receive_new_jugs: whole number of jugs above 0, of a jug type of the
-- factory, with the delivery reference (delivery note / invoice) and an
-- optional note (supplier, condition). Writes one 'purchase' ledger row and
-- an audit entry; nothing is edited afterwards -- a wrong receipt is
-- corrected with a write-off (Damaged / Lost) by a manager.
-- ============================================================================

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
          OR public.has_permission(v_uid, 'distribution'::module_key, 'approve'::action_key)) THEN
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
