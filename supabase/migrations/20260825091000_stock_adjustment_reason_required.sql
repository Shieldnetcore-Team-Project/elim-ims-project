-- ============================================================================
-- STOCK ADJUSTMENT — require a meaningful reason (spec: Inventory Stock Adjustment)
-- ----------------------------------------------------------------------------
-- request_stock_adjustment() accepted any reason including null/blank or a
-- bare "Adjustment" — spec explicitly forbids that as the only explanation.
-- The frontend now drives selection from a fixed category list (with "Other"
-- requiring its own description, see src/lib/adjustment-reasons.ts), but the
-- RPC is the actual trust boundary, so it rejects empty/placeholder reasons
-- server-side too rather than relying on client-side validation alone.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.request_stock_adjustment(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_entity_type text := payload->>'entity_type';
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_movement_type text := COALESCE(payload->>'movement_type', 'adjusted');
  v_reason text := btrim(COALESCE(payload->>'reason', ''));
  v_factory uuid; v_id uuid; v_module public.module_key;
BEGIN
  IF v_entity_type NOT IN ('raw_material','finished_good') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'quantity_delta must be non-zero'; END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'A reason is required for a stock adjustment'; END IF;
  IF lower(v_reason) IN ('adjustment','adjust','adjusted','n/a','na','misc','miscellaneous','other','stock adjustment','correction') THEN
    RAISE EXCEPTION 'Reason must be a meaningful explanation, not just "%"', v_reason;
  END IF;
  IF length(v_reason) < 5 THEN RAISE EXCEPTION 'Reason is too short — provide a meaningful explanation'; END IF;
  v_module := CASE v_entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;

  IF v_entity_type = 'raw_material' THEN
    IF NOT public.has_permission(v_uid, 'raw-materials', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id INTO v_factory FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  ELSE
    IF NOT public.has_permission(v_uid, 'finished-goods', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id INTO v_factory FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  END IF;

  INSERT INTO stock_adjustment_requests(factory_id, entity_type, material_id, product_id, quantity_delta, movement_type, reason, submitted_by, status)
  VALUES (v_factory, v_entity_type, v_material_id, v_product_id, v_delta, v_movement_type, v_reason, v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action(v_module, v_id, 'submit', NULL, 'pending_approval', v_reason);
  RETURN jsonb_build_object('id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_stock_adjustment(jsonb) TO authenticated;
