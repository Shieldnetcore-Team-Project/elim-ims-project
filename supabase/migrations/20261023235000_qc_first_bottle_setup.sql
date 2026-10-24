-- ============================================================================
-- QC sets a preform's bottle the first time
-- ----------------------------------------------------------------------------
-- Saving blowing on Quality Control → Preforms failed with "This preform has
-- no bottle product set up (Preform Production → Setup)": the good bottles
-- must go into a bottle product's stock, many preforms (e.g. the ones from the
-- old system) have none yet, and only a manager (preform-production reverse)
-- or settings could set it.
--
-- set_preform_bottle_product: whoever records blowing (preform-production
-- create) may set it once, while a preform has none -- like the first bag
-- size (set_material_pieces_per_bag). Changing it afterwards stays with a
-- manager (Preform Production → Setup). The bottle must be a product of the
-- preform's factory, and the person must work in that factory.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_preform_bottle_product(p_material uuid, p_product uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m raw_materials%ROWTYPE;
  v_p products%ROWTYPE;
  v_manager boolean := public._pf_can('reverse')
                       OR public.has_permission(auth.uid(), 'settings'::module_key, 'edit'::action_key);
BEGIN
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preform material not found'; END IF;
  IF NOT public._works_in_factory(auth.uid(), v_m.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT (v_manager OR (public._pf_can('create') AND v_m.output_product_id IS NULL)) THEN
    RAISE EXCEPTION 'This preform already makes a bottle -- a manager changes it in Preform Production → Setup';
  END IF;
  SELECT * INTO v_p FROM products WHERE id = p_product;
  IF NOT FOUND OR v_p.factory_id <> v_m.factory_id THEN RAISE EXCEPTION 'Bottle product not found in this factory'; END IF;
  IF v_m.output_product_id IS NOT DISTINCT FROM p_product THEN
    RETURN jsonb_build_object('material_id', p_material, 'output_product_id', p_product, 'changed', false);
  END IF;

  UPDATE raw_materials SET output_product_id = p_product, updated_at = now() WHERE id = p_material;
  PERFORM public._pf_audit(v_m.factory_id, 'set_preform_bottle_product', 'raw_materials', p_material,
    jsonb_build_object('output_product_id', v_m.output_product_id),
    jsonb_build_object('output_product_id', p_product, 'product', v_p.name));
  RETURN jsonb_build_object('material_id', p_material, 'output_product_id', p_product, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_preform_bottle_product(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_preform_bottle_product(uuid, uuid) TO authenticated;
