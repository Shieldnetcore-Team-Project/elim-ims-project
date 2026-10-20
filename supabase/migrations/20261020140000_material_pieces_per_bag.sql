-- ============================================================================
-- Pieces per bag from the Store page
-- ----------------------------------------------------------------------------
-- PET preforms (every size) are counted in pieces and delivered in bags.
-- raw_materials.pieces_per_bag (20261020130000) lets the Store page show
-- stock as pieces and bags and take receipts / issues in bags + loose pieces.
-- Until now only Preform Production → Setup (a production manager) could set
-- it, and authenticated users have no UPDATE on that column. This lets the
-- Store set it from the material form: raw-materials edit (or the preform
-- manager right), a reason when an existing figure changes, audited. Stock is
-- always stored in pieces, so changing the figure never changes a quantity.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_material_pieces_per_bag(
  p_material uuid, p_pieces_per_bag numeric, p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m raw_materials%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'write'::action_key)
       OR public.has_permission(auth.uid(), 'preform-production'::module_key, 'reverse'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
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
