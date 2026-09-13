-- ============================================================================
-- FIX: auto_create_production_request_on_low_finished_stock referenced a
-- column that doesn't exist on the live schema
-- ----------------------------------------------------------------------------
-- 20260913130000 was written against a stale read of costing_sheets --
-- 20260816104000_costing_calculator_dual_control_schema.sql later renamed
-- applied_to_product to apply_to_product and added a generated is_applied
-- column (status = 'posted' AND apply_to_product). The function as first
-- written referenced the old name, which doesn't fail at CREATE FUNCTION
-- time (plpgsql bodies aren't validated until executed) -- it would only
-- have surfaced the first time a finished good's stock crossed its reorder
-- level, and because an unhandled exception in a trigger rolls back the
-- whole transaction, it would have taken the triggering stock update down
-- with it. Caught before any real stock update hit this path.
--
-- Fix: use is_applied/status='posted' instead -- also more correct than the
-- original apply_to_product-only check, since it only trusts an *approved*
-- costing sheet as the recipe, not a pending draft.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.auto_create_production_request_on_low_finished_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet costing_sheets%ROWTYPE;
  v_shortfall numeric;
  v_scale numeric;
  v_number text;
  v_id uuid;
  v_existing uuid;
  v_item costing_sheet_items%ROWTYPE;
BEGIN
  IF NEW.reorder_level IS NULL OR NEW.reorder_level <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.current_stock > NEW.reorder_level THEN
    RETURN NEW;
  END IF;
  IF OLD.current_stock IS NOT DISTINCT FROM NEW.current_stock THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_existing
  FROM production_requests
  WHERE product_id = NEW.id
    AND request_type = 'production_material'
    AND materials_issued = false
    AND approval_status IN ('pending', 'approved')
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_sheet
  FROM costing_sheets
  WHERE product_id = NEW.id AND status = 'posted'
  ORDER BY is_applied DESC, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_shortfall := GREATEST(NEW.reorder_level * 2 - NEW.current_stock, NEW.reorder_level, 1);
  v_scale := v_shortfall / v_sheet.yield_quantity;

  v_number := 'PR-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');

  INSERT INTO production_requests(
    factory_id, request_number, requested_by_name, requested_by, department,
    request_type, product_id, quantity_requested, unit, remarks, auto_generated
  ) VALUES (
    NEW.factory_id, v_number, 'System (Auto Reorder)', NULL, NULL,
    'production_material', NEW.id, v_shortfall, NEW.unit,
    format('Auto-generated: stock (%s %s) at or below reorder level (%s %s). Materials scaled from costing sheet %s.',
           NEW.current_stock, NEW.unit, NEW.reorder_level, NEW.unit, v_sheet.sheet_number),
    true
  ) RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM costing_sheet_items WHERE sheet_id = v_sheet.id LOOP
    INSERT INTO production_request_items(request_id, material_id, quantity_requested, unit)
    SELECT v_id, v_item.material_id, round(v_item.quantity * v_scale, 3), rm.unit
    FROM raw_materials rm WHERE rm.id = v_item.material_id;
  END LOOP;

  RETURN NEW;
END;
$$;
