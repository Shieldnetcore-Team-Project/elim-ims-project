-- ============================================================================
-- Rename "Store" to "Warehouse" in display labels
-- ----------------------------------------------------------------------------
-- The finished-goods store is now called the Warehouse across the app. Only
-- human-readable text changes (labels, history notes, messages): the role
-- slug stays 'store_officer' so existing user_roles rows, permissions and RLS
-- checks are untouched.
-- ============================================================================

UPDATE public.roles
SET label = 'Warehouse Officer'
WHERE slug = 'store_officer' AND label = 'Store Officer';

UPDATE public.workflow_configs
SET maker_label = 'Warehouse Officer'
WHERE module = 'finished-goods' AND maker_label = 'Store Officer';

UPDATE public.workflow_configs
SET checker_label = 'Warehouse',
    description = 'Production batch posted by Production, accepted with actual/damaged/rejected counts by the Warehouse before entering sale-able finished-goods stock.'
WHERE module = 'production' AND checker_label = 'Store';

-- The Users page department dropdown now offers "Inventory / Warehouse";
-- move existing profiles over so they still match an option.
UPDATE public.profiles
SET department = 'Inventory / Warehouse'
WHERE department = 'Inventory / Store';

-- ============================================================================
-- confirm_production_batch: same body as 20260923190000_chairman_full_admin_parity,
-- with the stock-history note, damage reasons and error message saying Warehouse.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.confirm_production_batch(p_id uuid, p_actual_received numeric, p_damaged numeric, p_rejected numeric, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_row production%ROWTYPE; v_accepted numeric; v_before numeric; v_cost_price numeric;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production', 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Warehouse acceptance must be done by someone other than who posted the batch';
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
          'Production batch accepted by Warehouse', v_uid, v_before, v_before + v_accepted);
  UPDATE production SET status = 'posted' WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'post', 'confirmed', 'posted', p_comment);

  IF COALESCE(p_damaged,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_damaged, v_row.unit, v_cost_price, 'Damaged during Warehouse acceptance', v_uid, 'posted');
  END IF;
  IF COALESCE(p_rejected,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_rejected, v_row.unit, v_cost_price, 'Rejected during Warehouse acceptance', v_uid, 'posted');
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_production_batch', 'production', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_accepted, 'accepted_quantity', v_accepted));

  RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_accepted);
END; $function$;

-- Bring existing history in line with the new wording.
UPDATE public.inventory_movements
SET reason = 'Production batch accepted by Warehouse'
WHERE reason = 'Production batch confirmed by Store';

UPDATE public.damage_records
SET reason = 'Damaged during Warehouse acceptance'
WHERE reason = 'Damaged during Store confirmation';

UPDATE public.damage_records
SET reason = 'Rejected during Warehouse acceptance'
WHERE reason = 'Rejected during Store confirmation';
