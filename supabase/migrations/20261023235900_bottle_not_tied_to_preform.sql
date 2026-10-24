-- ============================================================================
-- A preform is not tied to a bottle
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-23): the same preform can be blown into
-- different bottle types, so the bottle is entered by hand on every blowing
-- entry (Quality Control → Preforms → ✎ → Bottle type) and nothing is
-- remembered on the preform.
--
-- set_shift_bottle: as 20261023235800, but it no longer saves the chosen
-- bottle as the preform's default. The entry's good bottles go into the
-- bottle picked for that entry only.
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
  RETURN jsonb_build_object('record_id', p_record, 'output_product_id', p_product, 'bottle', v_p.name);
END;
$$;
REVOKE ALL ON FUNCTION public.set_shift_bottle(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_shift_bottle(uuid, uuid) TO authenticated;
