-- ============================================================================
-- Preform weight in grams
-- ----------------------------------------------------------------------------
-- Each preform specification carries its weight per piece (e.g. 35cl = 12 g,
-- 1.5L = 32 g), set once in the Store's preform setup. Wherever a preform is
-- picked (receipts, counts, issues) the app shows that weight with it and the
-- total weight of the pieces entered. Stock stays in pieces; grams only
-- describe the piece, so setting or changing them moves no quantity or value.
--
-- No weights are backfilled: the factory enters the real figure per preform.
--
-- Same rights as the bag size (set_material_pieces_per_bag): raw-materials
-- edit / write or the preform manager right change it; raw-materials create /
-- submit or goods-receiving submit may set it the first time. A change needs a
-- reason and is audited.
-- ============================================================================

ALTER TABLE public.raw_materials
  ADD COLUMN IF NOT EXISTS grams_per_piece numeric
    CHECK (grams_per_piece IS NULL OR (grams_per_piece > 0 AND grams_per_piece <= 10000));

COMMENT ON COLUMN public.raw_materials.grams_per_piece IS
  'Weight of one piece in grams (preforms). Descriptive only: stock is in pieces.';

CREATE OR REPLACE FUNCTION public.set_material_grams(
  p_material uuid, p_grams numeric, p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m raw_materials%ROWTYPE;
  v_grams numeric := round(p_grams, 2);
  v_can_edit boolean := public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'write'::action_key)
       OR public.has_permission(auth.uid(), 'preform-production'::module_key, 'reverse'::action_key);
  v_can_first boolean := public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'submit'::action_key)
       OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'submit'::action_key);
BEGIN
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT (v_can_edit OR (v_can_first AND v_m.grams_per_piece IS NULL)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_grams IS NOT NULL AND (v_grams <= 0 OR v_grams > 10000) THEN
    RAISE EXCEPTION 'Grams per preform must be above 0 and at most 10,000';
  END IF;
  IF v_m.grams_per_piece IS NOT DISTINCT FROM v_grams THEN
    RETURN jsonb_build_object('material_id', p_material, 'grams_per_piece', v_grams, 'changed', false);
  END IF;
  IF v_m.grams_per_piece IS NOT NULL AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Give a reason for changing the grams per preform';
  END IF;
  UPDATE raw_materials SET grams_per_piece = v_grams, updated_at = now() WHERE id = p_material;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_m.factory_id, 'set_material_grams', 'raw_materials', p_material::text,
          jsonb_build_object('grams_per_piece', v_m.grams_per_piece),
          jsonb_build_object('grams_per_piece', v_grams, 'reason', p_reason));
  RETURN jsonb_build_object('material_id', p_material, 'grams_per_piece', v_grams, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_material_grams(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_material_grams(uuid, numeric, text) TO authenticated;

-- ============ Grams per supplier ============
-- Two suppliers of the same preform may mould it at different weights, so a
-- supplier link can carry its own grams; otherwise the preform's apply. In
-- the Store's receive form the grams come along once the preform and the
-- supplier are picked, and a delivery can be entered by total weight -- the
-- pieces are worked out from these grams (stock still posts in pieces).
ALTER TABLE public.material_suppliers
  ADD COLUMN IF NOT EXISTS grams_per_piece numeric
    CHECK (grams_per_piece IS NULL OR (grams_per_piece > 0 AND grams_per_piece <= 10000));

-- Sets this supplier's grams for the preform, linking the supplier if it is
-- not linked yet. Same rights and reason rule as set_material_grams.
CREATE OR REPLACE FUNCTION public.set_preform_supplier_grams(
  p_material uuid, p_supplier uuid, p_grams numeric, p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m raw_materials%ROWTYPE;
  v_link material_suppliers%ROWTYPE;
  v_grams numeric := round(p_grams, 2);
  v_can_edit boolean := public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'write'::action_key)
       OR public.has_permission(auth.uid(), 'preform-production'::module_key, 'reverse'::action_key);
  v_can_first boolean := public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'submit'::action_key)
       OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'submit'::action_key);
BEGIN
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier AND factory_id = v_m.factory_id) THEN
    RAISE EXCEPTION 'Supplier not found for this factory';
  END IF;
  IF v_grams IS NULL OR v_grams <= 0 OR v_grams > 10000 THEN
    RAISE EXCEPTION 'Grams per preform must be above 0 and at most 10,000';
  END IF;
  SELECT * INTO v_link FROM material_suppliers WHERE material_id = p_material AND supplier_id = p_supplier FOR UPDATE;
  IF NOT (v_can_edit OR (v_can_first AND v_link.grams_per_piece IS NULL)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_link.grams_per_piece IS NOT DISTINCT FROM v_grams THEN
    RETURN jsonb_build_object('material_id', p_material, 'supplier_id', p_supplier, 'grams_per_piece', v_grams, 'changed', false);
  END IF;
  IF v_link.grams_per_piece IS NOT NULL AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Give a reason for changing the grams per preform';
  END IF;
  INSERT INTO material_suppliers (factory_id, material_id, supplier_id, grams_per_piece, created_by)
  VALUES (v_m.factory_id, p_material, p_supplier, v_grams, auth.uid())
  ON CONFLICT (material_id, supplier_id) DO UPDATE SET grams_per_piece = EXCLUDED.grams_per_piece, updated_at = now();
  -- The first weight recorded for a preform also becomes its default.
  IF v_m.grams_per_piece IS NULL THEN
    UPDATE raw_materials SET grams_per_piece = v_grams, updated_at = now() WHERE id = p_material;
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_m.factory_id, 'set_preform_supplier_grams', 'raw_materials', p_material::text,
          jsonb_build_object('supplier_id', p_supplier, 'grams_per_piece', v_link.grams_per_piece),
          jsonb_build_object('supplier_id', p_supplier, 'grams_per_piece', v_grams, 'reason', p_reason));
  RETURN jsonb_build_object('material_id', p_material, 'supplier_id', p_supplier, 'grams_per_piece', v_grams, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_preform_supplier_grams(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_preform_supplier_grams(uuid, uuid, numeric, text) TO authenticated;
