-- ============================================================================
-- PROCUREMENT: AUTO PURCHASE REQUEST ON LOW STOCK
-- ----------------------------------------------------------------------------
-- Today, restocking a raw material only happens if a person notices its stock
-- is low (the "Request Purchase" dialog on the Inventory page) and manually
-- submits a purchase request. This adds a safety net: whenever a raw
-- material's stock crosses at/below its reorder_level, the system itself
-- drops a purchase request into the queue -- still subject to the normal
-- human approval step (approve_production_request / Issue Purchase Order),
-- it just guarantees nobody has to notice the low stock first.
--
-- auto_generated flags these rows so the UI (merged Procurement page) can
-- badge them distinctly from requests a person typed in.
-- ============================================================================

ALTER TABLE public.production_requests
  ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.auto_create_purchase_request_on_low_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_qty numeric;
  v_number text;
  v_existing uuid;
BEGIN
  -- Only act when stock actually dropped to/below a configured reorder level.
  IF NEW.reorder_level IS NULL OR NEW.reorder_level <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.current_stock > NEW.reorder_level THEN
    RETURN NEW;
  END IF;
  IF OLD.current_stock IS NOT DISTINCT FROM NEW.current_stock THEN
    RETURN NEW;
  END IF;

  -- Don't spam another request while one is already open for this material.
  SELECT id INTO v_existing
  FROM production_requests
  WHERE material_id = NEW.id
    AND request_type = 'purchase'
    AND po_number IS NULL
    AND approval_status IN ('pending', 'approved')
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Same default the manual "Request Purchase" dialog uses: top back up to
  -- twice the reorder level.
  v_qty := GREATEST(NEW.reorder_level * 2 - NEW.current_stock, NEW.reorder_level, 1);
  v_number := 'PR-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');

  INSERT INTO production_requests(
    factory_id, request_number, requested_by_name, requested_by, department,
    request_type, material_id, supplier_id, quantity_requested, unit, remarks, auto_generated
  ) VALUES (
    NEW.factory_id, v_number, 'System (Auto Reorder)', NULL, NULL,
    'purchase', NEW.id, NEW.supplier_id, v_qty, NEW.unit,
    format('Auto-generated: stock (%s %s) at or below reorder level (%s %s).',
           NEW.current_stock, NEW.unit, NEW.reorder_level, NEW.unit),
    true
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_reorder_purchase_request ON public.raw_materials;
CREATE TRIGGER trg_auto_reorder_purchase_request
  AFTER UPDATE ON public.raw_materials
  FOR EACH ROW EXECUTE FUNCTION public.auto_create_purchase_request_on_low_stock();
