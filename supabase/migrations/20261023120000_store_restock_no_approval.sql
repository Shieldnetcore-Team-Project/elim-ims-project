-- ============================================================================
-- Store restock without approval
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-23): restocking from the Store page never waits
-- for approval. Until now only someone with goods-receiving CONFIRM restocked
-- straight into stock; anyone else's restock was submitted as a goods receipt
-- for a different person to confirm (e.g. the Inventory Officer). Now
-- everyone who keeps stock on the Store page restocks directly:
--   goods-receiving confirm, or raw-materials submit or create.
-- QC (goods-receiving submit, raw-materials view only) is not among them:
-- QC-inspected deliveries (submit_goods_receipt -> confirm) keep their
-- two-person check. Everything else in restock_raw_material is unchanged
-- (20261022110000): the receipt, stock and moving-average value, movement,
-- damage, workflow trail and audit row.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.restock_raw_material(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := NULLIF(payload->>'material_id', '')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_damaged numeric := COALESCE(NULLIF(payload->>'damaged_quantity', '')::numeric, 0);
  v_unit_cost numeric := NULLIF(payload->>'unit_cost', '')::numeric;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id', '')::uuid;
  v_reference text := NULLIF(btrim(COALESCE(payload->>'delivery_reference', '')), '');
  v_remarks text := NULLIF(btrim(COALESCE(payload->>'remarks', '')), '');
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_existing goods_receipts%ROWTYPE;
  v_m raw_materials%ROWTYPE;
  v_number text;
  v_id uuid;
  v_accepted numeric;
  v_cost numeric;
BEGIN
  IF NOT (public.has_permission(v_uid, 'goods-receiving'::module_key, 'confirm'::action_key)
          OR public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key)
          OR public.has_permission(v_uid, 'raw-materials'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM goods_receipts WHERE client_ref = v_client;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_existing.id, 'receipt_number', v_existing.receipt_number, 'duplicate', true);
    END IF;
  END IF;

  SELECT * INTO v_m FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  -- Only someone who works in this factory (or across all factories).
  IF NOT EXISTS (SELECT 1 FROM user_roles ur
                  WHERE ur.user_id = v_uid AND (ur.factory_id IS NULL OR ur.factory_id = v_m.factory_id)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity supplied must be > 0'; END IF;
  IF v_damaged < 0 OR v_damaged > v_qty THEN RAISE EXCEPTION 'Damaged quantity must be between 0 and the quantity supplied'; END IF;
  IF v_unit_cost IS NOT NULL AND v_unit_cost < 0 THEN RAISE EXCEPTION 'Unit cost cannot be negative'; END IF;
  IF v_supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id = v_supplier_id AND factory_id = v_m.factory_id) THEN
    RAISE EXCEPTION 'Supplier not found for this factory';
  END IF;

  v_number := 'GR-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  INSERT INTO goods_receipts(factory_id, receipt_number, material_id, quantity, damaged_quantity, unit, unit_cost,
                             supplier_id, delivery_reference, remarks, submitted_by, client_ref, restocked_directly,
                             storage_location)
  VALUES (v_m.factory_id, v_number, v_material_id, v_qty, v_damaged, v_m.unit, v_unit_cost, v_supplier_id, v_reference,
          COALESCE(v_remarks, 'Restocked by the Store'), v_uid, v_client, true, v_m.storage_location)
  RETURNING id, accepted_quantity INTO v_id, v_accepted;
  PERFORM public.record_workflow_action('goods-receiving', v_id, 'submit', NULL, 'pending_confirmation', 'Store restock');

  UPDATE goods_receipts SET status = 'confirmed', confirmed_by = v_uid, confirmed_at = now() WHERE id = v_id;
  PERFORM public.record_workflow_action('goods-receiving', v_id, 'confirm', 'pending_confirmation', 'confirmed', 'Store restock');

  v_cost := COALESCE(v_unit_cost, v_m.unit_cost);
  UPDATE raw_materials SET
    current_stock = current_stock + v_accepted,
    current_value = current_value + v_accepted * v_cost,
    unit_cost = COALESCE(v_unit_cost, unit_cost),
    supplier_id = COALESCE(v_supplier_id, supplier_id),
    updated_at = now()
  WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                     quantity_before, quantity_after)
  VALUES (v_m.factory_id, v_material_id, 'received', v_accepted, v_cost, v_number,
          COALESCE(v_remarks, 'Restocked by the Store'), v_uid, v_m.current_stock, v_m.current_stock + v_accepted);

  IF v_damaged > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, material_id, quantity, unit,
                               unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_m.factory_id, 'DMG-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0'),
            'INVENTORY', v_number, v_material_id, v_damaged, v_m.unit, v_cost, 'Damaged on supplier delivery (restock)',
            v_uid, v_uid, 'posted');
  END IF;

  UPDATE goods_receipts SET status = 'posted' WHERE id = v_id;
  PERFORM public.record_workflow_action('goods-receiving', v_id, 'post', 'confirmed', 'posted', 'Store restock');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_m.factory_id, 'restock_raw_material', 'goods_receipts', v_id::text,
          jsonb_build_object('current_stock', v_m.current_stock),
          jsonb_build_object('current_stock', v_m.current_stock + v_accepted, 'supplied', v_qty, 'damaged', v_damaged));

  RETURN jsonb_build_object('id', v_id, 'receipt_number', v_number, 'accepted_quantity', v_accepted,
                            'current_stock', v_m.current_stock + v_accepted);
END;
$$;
REVOKE ALL ON FUNCTION public.restock_raw_material(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restock_raw_material(jsonb) TO authenticated;
