-- ============================================================================
-- Preforms are received in bags
-- ----------------------------------------------------------------------------
-- The Store and QC enter preform deliveries in bags; stock is kept in pieces
-- (bags x pieces per bag) and issued to Production / QC in pieces. A preform
-- with no bag size cannot be received in bags, so the receiving forms ask for
-- it the first time. QC records deliveries too but has no raw-materials edit
-- right, so the FIRST setting of a bag size is also open to whoever can
-- record or inspect a delivery (raw-materials create / submit,
-- goods-receiving submit). Changing an existing bag size still needs
-- raw-materials edit (or the preform manager right) and a reason.
-- Otherwise identical to 20261020140000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_material_pieces_per_bag(
  p_material uuid, p_pieces_per_bag numeric, p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m raw_materials%ROWTYPE;
  v_can_edit boolean := public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'write'::action_key)
       OR public.has_permission(auth.uid(), 'preform-production'::module_key, 'reverse'::action_key);
  v_can_first boolean := public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'submit'::action_key)
       OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'submit'::action_key);
BEGIN
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT (v_can_edit OR (v_can_first AND v_m.pieces_per_bag IS NULL)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_pieces_per_bag IS NOT NULL AND (p_pieces_per_bag <= 0 OR p_pieces_per_bag <> trunc(p_pieces_per_bag)) THEN
    RAISE EXCEPTION 'Pieces per bag must be a whole number above 0';
  END IF;
  IF v_m.pieces_per_bag IS NOT DISTINCT FROM p_pieces_per_bag THEN
    RETURN jsonb_build_object('material_id', p_material, 'pieces_per_bag', p_pieces_per_bag, 'changed', false);
  END IF;
  IF v_m.pieces_per_bag IS NOT NULL AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Give a reason for changing pieces per bag';
  END IF;
  UPDATE raw_materials SET pieces_per_bag = p_pieces_per_bag, updated_at = now() WHERE id = p_material;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_m.factory_id, 'set_material_pieces_per_bag', 'raw_materials', p_material::text,
          jsonb_build_object('pieces_per_bag', v_m.pieces_per_bag),
          jsonb_build_object('pieces_per_bag', p_pieces_per_bag, 'reason', p_reason));
  RETURN jsonb_build_object('material_id', p_material, 'pieces_per_bag', p_pieces_per_bag, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_material_pieces_per_bag(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_material_pieces_per_bag(uuid, numeric, text) TO authenticated;
