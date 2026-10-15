-- ============================================================================
-- Production shifts: day and night
-- ----------------------------------------------------------------------------
-- Production runs two shifts. The production manager records each morning
-- what the NIGHT shift produced (dated the night it was made -- yesterday),
-- and later the DAY shift's output for today. production.shift records which
-- shift a batch came from, so the Products Report can show each day split
-- into Day and Night over any period (week, month, year, custom).
--
--   shift  'day' | 'night'  (NULL for batches recorded before shifts existed)
--
-- create_production / update_production accept payload.shift; bodies are
-- otherwise identical to 20260923090000. An index on (factory_id,
-- production_date) keeps date-range reports quick as history grows.
-- ============================================================================

ALTER TABLE public.production
  ADD COLUMN IF NOT EXISTS shift text CHECK (shift IN ('day', 'night'));
CREATE INDEX IF NOT EXISTS production_factory_date_idx
  ON public.production (factory_id, production_date);

CREATE OR REPLACE FUNCTION public.create_production(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_production_type_id uuid := NULLIF(payload->>'production_type_id','')::uuid;
  v_packaging_unit text := NULLIF(payload->>'packaging_unit','');
  v_packaging_qty numeric := NULLIF(payload->>'packaging_quantity','')::numeric;
  v_qty numeric := NULLIF(payload->>'quantity_produced','')::numeric;
  v_damaged numeric := COALESCE((payload->>'damaged_quantity')::numeric, 0);
  v_unit text := payload->>'unit';
  v_cost numeric := COALESCE((payload->>'production_cost')::numeric, 0);
  v_supervisor text := payload->>'supervisor';
  v_batch text := payload->>'batch_number';
  v_remarks text := payload->>'remarks';
  v_date date := COALESCE((payload->>'production_date')::date, CURRENT_DATE);
  v_request_id uuid := NULLIF(payload->>'production_request_id','')::uuid;
  v_shift text := NULLIF(payload->>'shift','');
  v_prefix text; v_number text; v_id uuid; v_product products%ROWTYPE;
  v_department text; v_scope text; v_conversion numeric; v_type_scope text;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'create'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT public.has_production_scope_access(v_uid, v_factory) THEN RAISE EXCEPTION 'Your production scope does not cover this factory'; END IF;

  IF v_production_type_id IS NOT NULL THEN
    SELECT production_scope INTO v_type_scope FROM production_types WHERE id = v_production_type_id AND active;
    IF v_type_scope IS NULL THEN RAISE EXCEPTION 'Production type not found or inactive'; END IF;
  END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  SELECT department INTO v_department FROM profiles WHERE id = v_uid;
  SELECT upper(code) INTO v_scope FROM factories WHERE id = v_factory;

  IF v_type_scope IS NOT NULL AND v_type_scope <> 'BOTH' AND v_type_scope <> v_scope THEN
    RAISE EXCEPTION 'This production type is not configured for the % factory', v_scope;
  END IF;

  -- Packaging entry: "500 cartons" instead of a raw base-unit count.
  -- quantity_produced always ends up in the product's base/stocking unit so
  -- Store confirmation and stock posting never have to think about
  -- packaging -- only this record remembers the human-facing "500 cartons".
  IF v_packaging_unit IS NOT NULL THEN
    SELECT conversion_factor INTO v_conversion FROM product_units
    WHERE product_id = v_product_id AND packaging_unit = v_packaging_unit AND active;
    IF v_conversion IS NULL THEN RAISE EXCEPTION 'No active packaging conversion configured for % on this product', v_packaging_unit; END IF;
    IF v_packaging_qty IS NULL OR v_packaging_qty <= 0 THEN RAISE EXCEPTION 'Packaging quantity must be > 0'; END IF;
    v_qty := v_packaging_qty * v_conversion;
  END IF;

  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_damaged < 0 THEN RAISE EXCEPTION 'Damaged quantity cannot be negative'; END IF;
  IF v_damaged > v_qty THEN RAISE EXCEPTION 'Damaged quantity cannot exceed quantity produced'; END IF;

  IF v_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM production_requests WHERE id = v_request_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Production request not found for this factory';
    END IF;
  END IF;

  SELECT COALESCE(production_prefix,'PRD-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'PRD-'; END IF;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO production(factory_id, production_number, production_date, product_id, quantity_produced, unit,
                          production_cost, supervisor, batch_number, remarks, created_by, production_request_id,
                          production_type_id, department, production_scope, packaging_unit, packaging_quantity,
                          damaged_quantity, shift)
  VALUES (v_factory, v_number, v_date, v_product_id, v_qty, COALESCE(v_unit, v_product.unit),
          v_cost, v_supervisor, v_batch, v_remarks, v_uid, v_request_id,
          v_production_type_id, v_department, v_scope, v_packaging_unit, v_packaging_qty,
          v_damaged, v_shift)
  RETURNING id INTO v_id;

  IF v_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed', production_id = v_id WHERE id = v_request_id;
  END IF;

  PERFORM public.record_workflow_action('production', v_id, 'submit', NULL, 'pending_confirmation', v_remarks);
  RETURN jsonb_build_object('id', v_id, 'production_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_production(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_production(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := (payload->>'id')::uuid;
  v_qty numeric := (payload->>'quantity_produced')::numeric;
  v_damaged numeric := COALESCE((payload->>'damaged_quantity')::numeric, 0);
  v_unit text := payload->>'unit';
  v_cost numeric := COALESCE((payload->>'production_cost')::numeric, 0);
  v_supervisor text := payload->>'supervisor';
  v_batch text := payload->>'batch_number';
  v_remarks text := payload->>'remarks';
  v_date date := (payload->>'production_date')::date;
  v_shift text := NULLIF(payload->>'shift','');
  v_row production%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key)
     OR NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Insufficient permissions for this factory';
  END IF;
  IF v_row.status <> 'pending_confirmation' THEN RAISE EXCEPTION 'Cannot edit a batch after Store has acted on it'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_damaged < 0 THEN RAISE EXCEPTION 'Damaged quantity cannot be negative'; END IF;
  IF v_damaged > v_qty THEN RAISE EXCEPTION 'Damaged quantity cannot exceed quantity produced'; END IF;

  UPDATE production SET
    quantity_produced = v_qty,
    damaged_quantity = v_damaged,
    unit = COALESCE(v_unit, unit),
    production_cost = v_cost,
    supervisor = v_supervisor,
    batch_number = v_batch,
    remarks = v_remarks,
    production_date = COALESCE(v_date, production_date),
    shift = COALESCE(v_shift, shift)
  WHERE id = v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_production(jsonb) TO authenticated;
