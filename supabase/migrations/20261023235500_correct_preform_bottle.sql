-- ============================================================================
-- Correct which bottle a preform makes -- and move the bottles already stocked
-- ----------------------------------------------------------------------------
-- Factory request (user, 2026-10-23): a preform was set to the wrong bottle
-- (its good bottles went into "75cl bottles"); correct it from the blowing
-- entry (Quality Control → Preforms → ✎) and balance the output.
--
-- correct_preform_bottle(material, bottle, reason):
--   * the good bottles this preform already stocked under the old bottle
--     move to the right one: out of the old bottle's stock, into the new
--     one's, each as an 'adjusted' line on the finished-goods ledger with the
--     reason;
--   * its stockings and blowing records are re-pointed to the right bottle,
--     so the QC Bottles report and history show it correctly;
--   * the preform makes the right bottle from now on.
-- Refused, naming the shortfall, if some of those bottles have already left
-- the old bottle's stock (e.g. sent to production) -- reverse that first.
-- Who: whoever records blowing (QC) or a manager, in the preform's factory;
-- a reason is required and everything is audited.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.correct_preform_bottle(p_material uuid, p_product uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_m raw_materials%ROWTYPE;
  v_new products%ROWTYPE;
  v_old products%ROWTYPE;
  v_qty numeric;
  v_ref text;
BEGIN
  IF NOT (public._pf_can('create') OR public._pf_can('reverse')
          OR public.has_permission(auth.uid(), 'settings'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the bottle is being corrected'; END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preform material not found'; END IF;
  IF NOT public._works_in_factory(auth.uid(), v_m.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_new FROM products WHERE id = p_product;
  IF NOT FOUND OR v_new.factory_id <> v_m.factory_id THEN RAISE EXCEPTION 'Bottle product not found in this factory'; END IF;
  IF v_m.output_product_id IS NOT DISTINCT FROM p_product THEN
    RETURN jsonb_build_object('material_id', p_material, 'changed', false, 'moved', 0);
  END IF;

  -- Good bottles this preform stocked under the old bottle.
  v_qty := 0;
  IF v_m.output_product_id IS NOT NULL THEN
    SELECT * INTO v_old FROM products WHERE id = v_m.output_product_id FOR UPDATE;
    SELECT COALESCE(SUM(s.accepted_qty), 0) INTO v_qty
      FROM preform_stockings s JOIN preform_shift_records r ON r.id = s.shift_record_id
     WHERE r.material_id = p_material AND s.product_id = v_m.output_product_id AND s.status = 'accepted';
    IF v_qty > v_old.current_stock THEN
      RAISE EXCEPTION '% of these bottles were stocked as %, but only % are still in its stock (the rest have left, e.g. sent to production). Reverse those first, then correct the bottle.',
        trim_scale(v_qty), v_old.name, trim_scale(v_old.current_stock);
    END IF;
  END IF;

  v_ref := public._pf_ref('PBC');
  IF v_qty > 0 THEN
    PERFORM public._pf_product_move(v_old.id, -v_qty, 'adjusted', v_ref,
      format('Bottle corrected: %s blows %s, not %s -- %s', v_m.name, v_new.name, v_old.name, v_reason));
    PERFORM public._pf_product_move(v_new.id, v_qty, 'adjusted', v_ref,
      format('Bottle corrected: %s blows %s, not %s -- %s', v_m.name, v_new.name, v_old.name, v_reason));
    UPDATE preform_stockings s SET product_id = p_product
      FROM preform_shift_records r
     WHERE r.id = s.shift_record_id AND r.material_id = p_material AND s.product_id = v_old.id;
  END IF;
  UPDATE preform_shift_records SET output_product_id = p_product, updated_at = now()
   WHERE material_id = p_material AND output_product_id IS NOT DISTINCT FROM v_m.output_product_id;
  UPDATE raw_materials SET output_product_id = p_product, updated_at = now() WHERE id = p_material;

  PERFORM public._pf_audit(v_m.factory_id, 'correct_preform_bottle', 'raw_materials', p_material,
    jsonb_build_object('output_product_id', v_m.output_product_id, 'product', v_old.name),
    jsonb_build_object('output_product_id', p_product, 'product', v_new.name, 'bottles_moved', v_qty,
                       'reference', v_ref, 'reason', v_reason));
  RETURN jsonb_build_object('material_id', p_material, 'changed', true, 'moved', v_qty,
                            'from', v_old.name, 'to', v_new.name, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_preform_bottle(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_preform_bottle(uuid, uuid, text) TO authenticated;
