-- ============================================================================
-- STOCK ADJUSTMENT DUAL CONTROL — close the positive-delta bypass (spec 18)
-- ----------------------------------------------------------------------------
-- adjust_raw_material()/adjust_finished_stock() already forced NEGATIVE
-- deltas through request_stock_adjustment(), but still applied POSITIVE
-- deltas instantly with zero approval -- exactly the "500 -> 700" scenario
-- spec 18 explicitly forbids. Fix: stock_adjustment_requests now accepts
-- either sign, request_stock_adjustment()'s guard is loosened to "non-zero"
-- instead of "negative", and the two instant-apply functions are revoked
-- from authenticated (kept for service_role/seed scripts). Nothing else
-- calls either function internally (post_stock_adjustment does its own
-- direct UPDATE), so this is a safe revoke, not a behavior change to any
-- other flow.
-- ============================================================================

-- ============ 1. quantity_delta: allow either sign ============
-- Found dynamically rather than by a guessed constraint name -- today's
-- earlier migration debugging showed guessed names are a real risk.
DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname FROM pg_constraint
    WHERE conrelid = 'public.stock_adjustment_requests'::regclass
      AND pg_get_constraintdef(oid) ILIKE '%quantity_delta%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stock_adjustment_requests DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
ALTER TABLE public.stock_adjustment_requests ADD CONSTRAINT stock_adjustment_requests_quantity_delta_check CHECK (quantity_delta <> 0);

-- ============ 2. request_stock_adjustment(): non-zero, not negative-only ============
-- Same signature as the live definition (20260816091000_workflow_engine_retrofit.sql:560-592)
-- -- plain CREATE OR REPLACE, only the guard message/condition changes.
CREATE OR REPLACE FUNCTION public.request_stock_adjustment(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_entity_type text := payload->>'entity_type';
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_movement_type text := COALESCE(payload->>'movement_type', 'adjusted');
  v_reason text := payload->>'reason';
  v_factory uuid; v_id uuid; v_module public.module_key;
BEGIN
  IF v_entity_type NOT IN ('raw_material','finished_good') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'quantity_delta must be non-zero'; END IF;
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

-- ============ 3. Retire the unapproved instant-apply paths ============
REVOKE EXECUTE ON FUNCTION public.adjust_raw_material(jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.adjust_finished_stock(jsonb) FROM authenticated;

-- ============ 4. Harden raw_material_movements.movement_type to the
-- raw-material-relevant subset of the enum (spec 17's type list) ============
ALTER TABLE public.raw_material_movements DROP CONSTRAINT IF EXISTS raw_material_movements_movement_type_check;
ALTER TABLE public.raw_material_movements ADD CONSTRAINT raw_material_movements_movement_type_check
  CHECK (movement_type IN ('received','issued','adjusted','transferred','damaged','used_for_production',
                            'opening_balance','return_from_production','expiry','correction'));
