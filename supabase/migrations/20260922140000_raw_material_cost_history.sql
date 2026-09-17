-- ============================================================================
-- RAW MATERIALS: unit_cost change history
-- ----------------------------------------------------------------------------
-- Mirrors product_price_history / log_product_price_change() from
-- 20260826091000_accountant_po_grant_and_price_history.sql, but for
-- raw_materials.unit_cost -- unlike products.cost_price (locked down to the
-- Costing sheet RPC only), unit_cost is directly editable from the Add/Edit
-- Material form's plain client-side .update() call, so a trigger is the only
-- place that can reliably catch every change regardless of which code path
-- wrote it.
-- ============================================================================

CREATE TABLE public.raw_material_cost_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,
  cost numeric(14,2) NOT NULL,
  previous_cost numeric(14,2),
  effective_date timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.raw_material_cost_history TO authenticated;
GRANT ALL ON public.raw_material_cost_history TO service_role;
ALTER TABLE public.raw_material_cost_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "material cost history read" ON public.raw_material_cost_history FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'view'::action_key));
-- No write policy for authenticated: only the trigger below (SECURITY
-- DEFINER, runs as its owner) inserts rows -- a direct client insert can't
-- forge history.

CREATE OR REPLACE FUNCTION public.log_raw_material_cost_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
    INSERT INTO raw_material_cost_history(material_id, cost, previous_cost, created_by)
    VALUES (NEW.id, NEW.unit_cost, OLD.unit_cost, auth.uid());
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER raw_materials_cost_history AFTER UPDATE ON public.raw_materials
FOR EACH ROW EXECUTE FUNCTION public.log_raw_material_cost_change();

-- One-time backfill: seed a single history row for every material that
-- already has a non-zero cost, so the dialog isn't empty for existing stock
-- (same approach as the products backfill in 20260826091000_...sql:61-65).
INSERT INTO public.raw_material_cost_history (material_id, cost, previous_cost, effective_date)
SELECT id, unit_cost, NULL, created_at FROM public.raw_materials WHERE unit_cost > 0;

ALTER PUBLICATION supabase_realtime ADD TABLE public.raw_material_cost_history;
