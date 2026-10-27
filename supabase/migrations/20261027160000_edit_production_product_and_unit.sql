-- ============================================================================
-- Correct a batch: product and unit too
-- ----------------------------------------------------------------------------
-- The production manager can correct a batch entered by mistake while it is
-- still in the production hall (status 'pending_confirmation'): besides the
-- quantity, date, shift and remarks, update_production now takes
--   * product_id        -- the right product, when the wrong one was picked
--                          (not for a batch made against a production request);
--   * packaging_unit /  -- the unit the quantity was counted in. When the
--     packaging_quantity   product has a packaging conversion for it, the
--                          quantity is converted to the base unit as on
--                          create_production; sent as null, the batch is
--                          counted in its plain unit.
-- Callers that don't send product_id / packaging_unit keep the old behaviour.
-- The released-goods guard (trg_production_guard_released) still refuses a
-- correction that would leave less of a product than was already released;
-- it now checks the new product as well as the old.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_production(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := (payload->>'id')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity_produced','')::numeric;
  v_damaged numeric := COALESCE((payload->>'damaged_quantity')::numeric, 0);
  v_unit text := payload->>'unit';
  v_cost numeric := COALESCE((payload->>'production_cost')::numeric, 0);
  v_supervisor text := payload->>'supervisor';
  v_batch text := payload->>'batch_number';
  v_remarks text := payload->>'remarks';
  v_date date := (payload->>'production_date')::date;
  v_shift text := NULLIF(payload->>'shift','');
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_set_packaging boolean := payload ? 'packaging_unit';
  v_packaging_unit text := NULLIF(payload->>'packaging_unit','');
  v_packaging_qty numeric := NULLIF(payload->>'packaging_quantity','')::numeric;
  v_conversion numeric;
  v_product products%ROWTYPE;
  v_row production%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production record not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key)
     OR NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Insufficient permissions for this factory';
  END IF;
  IF v_row.status <> 'pending_confirmation' THEN RAISE EXCEPTION 'Cannot edit a batch after Store has acted on it'; END IF;

  v_product_id := COALESCE(v_product_id, v_row.product_id);
  IF v_product_id <> v_row.product_id THEN
    IF v_row.production_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'This batch was made against a production request -- its product can''t be changed. Cancel it and record it again.';
    END IF;
    SELECT * INTO v_product FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    IF v_product.factory_id <> v_row.factory_id THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
  END IF;

  IF v_set_packaging AND v_packaging_unit IS NOT NULL THEN
    SELECT conversion_factor INTO v_conversion FROM product_units
    WHERE product_id = v_product_id AND packaging_unit = v_packaging_unit AND active;
    IF v_conversion IS NULL THEN RAISE EXCEPTION 'No active packaging conversion configured for % on this product', v_packaging_unit; END IF;
    IF v_packaging_qty IS NULL OR v_packaging_qty <= 0 THEN RAISE EXCEPTION 'Packaging quantity must be > 0'; END IF;
    v_qty := v_packaging_qty * v_conversion;
  ELSIF v_set_packaging THEN
    v_packaging_qty := NULL;
  END IF;

  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_damaged < 0 THEN RAISE EXCEPTION 'Damaged quantity cannot be negative'; END IF;
  IF v_damaged > v_qty THEN RAISE EXCEPTION 'Damaged quantity cannot exceed quantity produced'; END IF;

  UPDATE production SET
    product_id = v_product_id,
    quantity_produced = v_qty,
    damaged_quantity = v_damaged,
    unit = COALESCE(v_unit, unit),
    packaging_unit = CASE WHEN v_set_packaging THEN v_packaging_unit ELSE packaging_unit END,
    packaging_quantity = CASE WHEN v_set_packaging THEN v_packaging_qty ELSE packaging_quantity END,
    production_cost = v_cost,
    supervisor = v_supervisor,
    batch_number = v_batch,
    remarks = v_remarks,
    production_date = COALESCE(v_date, production_date),
    shift = COALESCE(v_shift, shift)
  WHERE id = v_id;

  IF v_product_id <> v_row.product_id OR v_qty <> v_row.quantity_produced THEN
    INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_row.factory_id, 'correct_production', 'production', v_id::text,
            jsonb_build_object('product_id', v_row.product_id, 'quantity_produced', v_row.quantity_produced,
                               'unit', v_row.unit, 'packaging_unit', v_row.packaging_unit,
                               'packaging_quantity', v_row.packaging_quantity),
            jsonb_build_object('product_id', v_product_id, 'quantity_produced', v_qty,
                               'packaging_unit', v_packaging_unit, 'packaging_quantity', v_packaging_qty));
  END IF;

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.update_production(jsonb) TO authenticated;

-- The released-goods guard checked only the batch's old product; a batch
-- moved to another product is checked on both.
CREATE OR REPLACE FUNCTION public._production_guard_released()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_available numeric;
BEGIN
  IF NEW.quantity_produced IS DISTINCT FROM OLD.quantity_produced
     OR NEW.damaged_quantity IS DISTINCT FROM OLD.damaged_quantity
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    v_available := LEAST(public._production_hall_available(OLD.factory_id, OLD.product_id),
                         public._production_hall_available(NEW.factory_id, NEW.product_id));
    IF v_available < 0 THEN
      RAISE EXCEPTION 'Not possible: % more of this product has already been released to the Warehouse than this change would leave produced',
        -v_available;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
