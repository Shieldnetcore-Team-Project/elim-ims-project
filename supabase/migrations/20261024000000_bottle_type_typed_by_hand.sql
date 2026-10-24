-- ============================================================================
-- Blowing: the bottle type is typed by hand
-- ----------------------------------------------------------------------------
-- Factory request (user, 2026-10-23): on Quality Control → Preforms → ✎ the
-- Bottle type is a free box, not a fixed list -- QC types it (e.g. "50cl
-- Bottle Water"); existing bottle types are only offered as suggestions.
--
-- set_shift_bottle_by_name(record, name): the good bottles of that entry
-- still have to go into a product's stock, so the typed name is matched to
-- the factory's products ignoring case and spacing; when there is none, a new
-- bottle product of that name is created (semi-finished, counted in pieces,
-- like the bottle products before it) and audited. Then the entry carries it,
-- as set_shift_bottle does. Who: as set_shift_bottle (the person whose
-- blowing it is, or a manager), working in that factory.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_shift_bottle_by_name(p_record uuid, p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text := regexp_replace(btrim(COALESCE(p_name, '')), '\s+', ' ', 'g');
  v_r preform_shift_records%ROWTYPE;
  v_product uuid;
  v_created boolean := false;
BEGIN
  IF NOT (public._pf_can('create') OR public._pf_can('edit')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF length(v_name) < 2 THEN RAISE EXCEPTION 'Type the bottle type'; END IF;
  IF length(v_name) > 80 THEN RAISE EXCEPTION 'The bottle type is too long'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blowing record not found'; END IF;
  IF NOT public._works_in_factory(auth.uid(), v_r.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_r.operator_id <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'You can only set the bottle on your own blowing';
  END IF;
  IF v_r.status <> 'draft' THEN RAISE EXCEPTION 'This blowing has already been submitted'; END IF;

  SELECT id INTO v_product FROM products
   WHERE factory_id = v_r.factory_id
     AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(v_name)
   ORDER BY active DESC, created_at
   LIMIT 1;
  IF v_product IS NULL THEN
    INSERT INTO products(factory_id, name, unit, unit_price, cost_price, current_stock, product_type, active)
    VALUES (v_r.factory_id, v_name, 'Piece', 0, 0, 0, 'semi_finished', true)
    RETURNING id INTO v_product;
    v_created := true;
    PERFORM public._pf_audit(v_r.factory_id, 'create_bottle_type', 'products', v_product, NULL,
      jsonb_build_object('name', v_name, 'from_blowing', v_r.reference));
  END IF;

  UPDATE preform_shift_records SET output_product_id = v_product, updated_at = now() WHERE id = p_record;
  RETURN jsonb_build_object('record_id', p_record, 'output_product_id', v_product, 'bottle', v_name, 'created', v_created);
END;
$$;
REVOKE ALL ON FUNCTION public.set_shift_bottle_by_name(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_shift_bottle_by_name(uuid, text) TO authenticated;
