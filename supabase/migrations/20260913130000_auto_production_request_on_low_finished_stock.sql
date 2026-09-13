-- ============================================================================
-- STORE (FINISHED GOODS): AUTO PRODUCTION REQUEST ON LOW STOCK
-- ----------------------------------------------------------------------------
-- Mirrors 20260913090000's raw-material auto-reorder trigger, but a finished
-- good can't be "purchased" from a supplier -- restocking it means producing
-- more, which needs a raw-material breakdown (a recipe), not just a
-- quantity. This uses the product's costing sheet as that recipe (preferring
-- the one currently applied to the product's cost_price, else the most
-- recent one), scales its material quantities to the shortfall, and drops a
-- request_type='production_material' row -- the same "produce more" request
-- type used everywhere else, landing on the existing Production Requests
-- page (NOT Procurement, which is purchase-from-supplier only).
--
-- If a product has no costing sheet yet, there's no recipe to scale from, so
-- nothing is auto-generated for it -- same as the "no reorder_level set"
-- skip condition below.
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

  -- Don't spam another request while one is already open for this product.
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

  -- Recipe: a posted (approved) costing sheet only -- prefer the one
  -- currently applied to the product's cost, else the most recent posted
  -- one. No posted sheet at all -> nothing reliable to scale from.
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

DROP TRIGGER IF EXISTS trg_auto_reorder_production_request ON public.products;
CREATE TRIGGER trg_auto_reorder_production_request
  AFTER UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.auto_create_production_request_on_low_finished_stock();
