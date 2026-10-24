-- ============================================================================
-- Blowing: the bottle type is chosen on each entry
-- ----------------------------------------------------------------------------
-- Factory request (user, 2026-10-23): when QC enters Blown and Damages
-- (Quality Control → Preforms → ✎) she picks the bottle type from a
-- dropdown of all bottle types; the entry shows the expected bottles
-- (blown - damages) and the balance. The good bottles of that entry go into
-- the chosen bottle's stock.
--
-- set_shift_bottle(record, bottle): sets the bottle on a blowing record still
-- in draft (save_preform_shift takes the preform's bottle by default), before
-- it is submitted -- submit stocks the good bottles into the record's bottle.
-- If the preform has no bottle yet, it is remembered as the preform's
-- default. Who: the person whose blowing it is, or a manager; the bottle
-- must be a product of the same factory.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_shift_bottle(p_record uuid, p_product uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r preform_shift_records%ROWTYPE;
  v_p products%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('create') OR public._pf_can('edit')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blowing record not found'; END IF;
  IF v_r.operator_id <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'You can only set the bottle on your own blowing';
  END IF;
  IF v_r.status <> 'draft' THEN RAISE EXCEPTION 'This blowing has already been submitted'; END IF;
  SELECT * INTO v_p FROM products WHERE id = p_product;
  IF NOT FOUND OR v_p.factory_id <> v_r.factory_id THEN RAISE EXCEPTION 'Bottle type not found in this factory'; END IF;

  UPDATE preform_shift_records SET output_product_id = p_product, updated_at = now() WHERE id = p_record;
  -- The preform's default bottle, if it has none yet.
  UPDATE raw_materials SET output_product_id = p_product, updated_at = now()
   WHERE id = v_r.material_id AND output_product_id IS NULL;
  RETURN jsonb_build_object('record_id', p_record, 'output_product_id', p_product, 'bottle', v_p.name);
END;
$$;
REVOKE ALL ON FUNCTION public.set_shift_bottle(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_shift_bottle(uuid, uuid) TO authenticated;
