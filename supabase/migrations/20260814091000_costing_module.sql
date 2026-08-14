
-- ============================================================
-- Costing module. Confirmed as a core department (Phase 3) and
-- confirmed missing entirely in the Phase 2 audit: products.cost_price
-- was a static, manually-typed number never reconciled against actual
-- raw-material consumption. This closes that gap: a costing sheet rolls
-- up live material cost + labor + overhead into a unit cost, with a
-- history per product, and can write the result back to products.cost_price.
-- ============================================================

CREATE TABLE public.costing_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  sheet_number text NOT NULL,
  yield_quantity numeric(14,3) NOT NULL CHECK (yield_quantity > 0),
  labor_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (labor_cost >= 0),
  overhead_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (overhead_cost >= 0),
  material_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (material_cost >= 0),
  total_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  unit_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  applied_to_product boolean NOT NULL DEFAULT false,
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(factory_id, sheet_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.costing_sheets TO authenticated;
GRANT ALL ON public.costing_sheets TO service_role;
ALTER TABLE public.costing_sheets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "costing sheets read" ON public.costing_sheets FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'costing', 'read'));
CREATE POLICY "costing sheets write" ON public.costing_sheets FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'costing', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'costing', 'write'));

CREATE TABLE public.costing_sheet_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES public.costing_sheets(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.raw_materials(id),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.costing_sheet_items TO authenticated;
GRANT ALL ON public.costing_sheet_items TO service_role;
ALTER TABLE public.costing_sheet_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "costing sheet items read" ON public.costing_sheet_items FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'costing', 'read'));
CREATE POLICY "costing sheet items write" ON public.costing_sheet_items FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'costing', 'write'))
  WITH CHECK (public.has_permission(auth.uid(), 'costing', 'write'));

CREATE OR REPLACE FUNCTION public.create_costing_sheet(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_yield numeric := (payload->>'yield_quantity')::numeric;
  v_labor numeric := COALESCE((payload->>'labor_cost')::numeric, 0);
  v_overhead numeric := COALESCE((payload->>'overhead_cost')::numeric, 0);
  v_apply boolean := COALESCE((payload->>'apply_to_product')::boolean, false);
  v_notes text := payload->>'notes';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_material raw_materials%ROWTYPE;
  v_qty numeric;
  v_line numeric;
  v_material_cost numeric := 0;
  v_total numeric;
  v_unit_cost numeric;
  v_number text;
  v_sheet_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'costing', 'write') THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_yield IS NULL OR v_yield <= 0 THEN RAISE EXCEPTION 'Yield quantity must be > 0'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'At least one material line is required'; END IF;

  PERFORM 1 FROM products WHERE id = v_product_id AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found for this factory'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material % not found', v_item->>'material_id'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Material quantity must be > 0'; END IF;
    v_line := v_qty * v_material.unit_cost;
    v_material_cost := v_material_cost + v_line;
  END LOOP;

  v_total := v_material_cost + v_labor + v_overhead;
  v_unit_cost := v_total / v_yield;

  v_number := 'CST-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO costing_sheets(factory_id, product_id, sheet_number, yield_quantity, labor_cost, overhead_cost,
                              material_cost, total_cost, unit_cost, applied_to_product, notes, created_by)
  VALUES (v_factory, v_product_id, v_number, v_yield, v_labor, v_overhead,
          v_material_cost, v_total, v_unit_cost, v_apply, v_notes, v_uid)
  RETURNING id INTO v_sheet_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = (v_item->>'material_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    INSERT INTO costing_sheet_items(sheet_id, material_id, quantity, unit_cost, line_total)
    VALUES (v_sheet_id, v_material.id, v_qty, v_material.unit_cost, v_qty * v_material.unit_cost);
  END LOOP;

  IF v_apply THEN
    UPDATE products SET cost_price = v_unit_cost, updated_at = now() WHERE id = v_product_id;
  END IF;

  RETURN jsonb_build_object('id', v_sheet_id, 'sheet_number', v_number, 'unit_cost', v_unit_cost, 'total_cost', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_costing_sheet(jsonb) TO authenticated;
