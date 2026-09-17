-- ============================================================================
-- DAMAGE RECORDS: capture unit cost, so damaged stock's value is tracked
-- separately from good/available stock instead of being lost entirely.
-- ----------------------------------------------------------------------------
-- current_stock was already correctly decremented for every damage path
-- (confirm_production_batch, post_stock_adjustment, inspect_sales_return), so
-- "Inventory Value" / "Total Value" on Raw Materials and Finished Goods never
-- double-counted damaged stock. But damage_records itself had no cost column
-- at all -- the monetary value of damaged goods was never captured anywhere,
-- so it couldn't be shown as its own figure. This adds unit_cost to
-- damage_records and stamps it at the moment each damage row is written
-- (the material's/product's cost AT THAT TIME, same snapshot-in-transaction
-- pattern as raw_material_movements.unit_cost -- see 20260826090000_stock_
-- adjustment_hardening_and_column_lockdown.sql).
-- ============================================================================

ALTER TABLE public.damage_records ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2);

-- ============ confirm_production_batch(): stamp cost_price on damage/reject rows ============
CREATE OR REPLACE FUNCTION public.confirm_production_batch(
  p_id uuid, p_actual_received numeric, p_damaged numeric, p_rejected numeric, p_comment text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_row production%ROWTYPE; v_accepted numeric; v_before numeric; v_cost_price numeric;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production', 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Store confirmation must be done by someone other than who recorded the batch';
  END IF;
  IF p_actual_received IS NULL OR p_actual_received < 0 THEN RAISE EXCEPTION 'Actual quantity received must be >= 0'; END IF;
  IF COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN RAISE EXCEPTION 'Damaged/rejected quantities cannot be negative'; END IF;
  IF COALESCE(p_damaged,0) + COALESCE(p_rejected,0) > p_actual_received THEN
    RAISE EXCEPTION 'Damaged + rejected cannot exceed actual quantity received';
  END IF;
  v_accepted := p_actual_received - COALESCE(p_damaged,0) - COALESCE(p_rejected,0);

  PERFORM public.assert_valid_transition(v_row.status, 'confirmed');
  UPDATE production SET
    actual_quantity_received = p_actual_received, damaged_quantity = COALESCE(p_damaged,0),
    rejected_quantity = COALESCE(p_rejected,0), accepted_quantity = v_accepted,
    confirmed_by = v_uid, confirmed_at = now(), status = 'confirmed'
  WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'confirm', v_row.status, 'confirmed', p_comment);

  PERFORM public.assert_valid_transition('confirmed', 'posted');
  SELECT current_stock, cost_price INTO v_before, v_cost_price FROM products WHERE id = v_row.product_id FOR UPDATE;
  UPDATE products SET current_stock = current_stock + v_accepted, updated_at = now() WHERE id = v_row.product_id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_row.factory_id, v_row.product_id, 'produced', v_accepted, v_row.production_number,
          'Production batch confirmed by Store', v_uid, v_before, v_before + v_accepted);
  UPDATE production SET status = 'posted' WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'post', 'confirmed', 'posted', p_comment);

  IF COALESCE(p_damaged,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_damaged, v_row.unit, v_cost_price, 'Damaged during Store confirmation', v_uid, 'posted');
  END IF;
  IF COALESCE(p_rejected,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_rejected, v_row.unit, v_cost_price, 'Rejected during Store confirmation', v_uid, 'posted');
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_production_batch', 'production', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_accepted, 'accepted_quantity', v_accepted));

  RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_accepted);
END; $$;
GRANT EXECUTE ON FUNCTION public.confirm_production_batch(uuid, numeric, numeric, numeric, text) TO authenticated;

-- ============ post_stock_adjustment(): stamp cost on write-off damage rows ============
CREATE OR REPLACE FUNCTION public.post_stock_adjustment(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_unit_cost numeric; v_unit text;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot post a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'posted');

  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, unit_cost, unit INTO v_before, v_unit_cost, v_unit FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    UPDATE raw_materials SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_unit_cost, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  ELSE
    SELECT current_stock, cost_price, unit INTO v_before, v_unit_cost, v_unit FROM products WHERE id = v_req.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, v_req.movement_type::movement_type, v_req.quantity_delta, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  END IF;

  IF v_req.movement_type = 'damaged' THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, material_id, quantity, unit, unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            CASE WHEN v_req.entity_type = 'finished_good' THEN 'STORE' ELSE 'INVENTORY' END,
            p_id::text, v_req.product_id, v_req.material_id, abs(v_req.quantity_delta), v_unit, v_unit_cost,
            v_req.reason, v_req.submitted_by, v_uid, 'posted');
  END IF;

  UPDATE stock_adjustment_requests SET status = 'posted', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action(v_module, p_id, 'post', v_req.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'post_stock_adjustment', v_req.entity_type, COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity_delta));
  RETURN jsonb_build_object('posted', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.post_stock_adjustment(uuid, text) TO authenticated;

-- ============ inspect_sales_return(): stamp cost on damaged-portion rows ============
CREATE OR REPLACE FUNCTION public.inspect_sales_return(p_id uuid, p_accepted numeric, p_damaged numeric, p_rejected numeric, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales_returns%ROWTYPE;
  v_before numeric;
  v_cost_price numeric;
BEGIN
  SELECT * INTO v_row FROM sales_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Inspection must be done by someone other than who logged the return';
  END IF;
  IF v_row.status <> 'received' THEN RAISE EXCEPTION 'This return has already been inspected'; END IF;
  IF COALESCE(p_accepted,0) < 0 OR COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN
    RAISE EXCEPTION 'Quantities cannot be negative';
  END IF;
  IF COALESCE(p_accepted,0) + COALESCE(p_damaged,0) + COALESCE(p_rejected,0) <> v_row.quantity_returned THEN
    RAISE EXCEPTION 'Accepted + damaged + rejected must equal the % returned', v_row.quantity_returned;
  END IF;

  UPDATE sales_returns SET
    accepted_quantity = p_accepted, damaged_quantity = COALESCE(p_damaged,0), rejected_quantity = COALESCE(p_rejected,0),
    inspected_by = v_uid, inspected_at = now(), status = 'completed', notes = p_notes
  WHERE id = p_id;

  IF COALESCE(p_accepted,0) > 0 THEN
    SELECT current_stock INTO v_before FROM products WHERE id = v_row.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + p_accepted, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'returned', p_accepted, v_row.return_number, 'Accepted sales return', v_uid, v_before, v_before + p_accepted);
  END IF;

  IF COALESCE(p_damaged,0) > 0 THEN
    SELECT cost_price INTO v_cost_price FROM products WHERE id = v_row.product_id;
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'SALES_RETURN', v_row.return_number, v_row.product_id, p_damaged, v_row.unit, v_cost_price, 'Damaged on sales return inspection', v_uid, 'posted');
  END IF;

  RETURN jsonb_build_object('completed', true, 'accepted', p_accepted, 'damaged', p_damaged, 'rejected', p_rejected);
END; $$;
GRANT EXECUTE ON FUNCTION public.inspect_sales_return(uuid, numeric, numeric, numeric, text) TO authenticated;

-- ============ Backfill existing rows (best effort) ============
-- Raw materials: raw_material_movements.unit_cost was already captured at the
-- same instant (same transaction => same `now()`), so join on that; fall back
-- to the material's current unit_cost if no exact match is found.
UPDATE public.damage_records dr SET unit_cost = COALESCE(
  (SELECT rmm.unit_cost FROM public.raw_material_movements rmm
   WHERE rmm.material_id = dr.material_id AND rmm.movement_type = 'damaged' AND rmm.created_at = dr.created_at
   LIMIT 1),
  (SELECT rm.unit_cost FROM public.raw_materials rm WHERE rm.id = dr.material_id)
)
WHERE dr.material_id IS NOT NULL AND dr.unit_cost IS NULL;

-- Finished goods: inventory_movements never captured a cost column, so there is
-- no historical figure to recover -- fall back to the product's current cost_price
-- as a best-effort approximation for pre-existing rows only.
UPDATE public.damage_records dr SET unit_cost = (SELECT p.cost_price FROM public.products p WHERE p.id = dr.product_id)
WHERE dr.product_id IS NOT NULL AND dr.unit_cost IS NULL;
