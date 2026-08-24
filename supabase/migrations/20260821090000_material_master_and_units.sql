-- ============================================================================
-- RAW MATERIAL MASTER + CONFIGURABLE UNITS OF MEASURE
-- ----------------------------------------------------------------------------
-- raw_materials.category was free text with no master table (unlike products,
-- which already has product_categories); units were a hard-coded TS array
-- (src/lib/units.ts) duplicated between raw-materials and finished-goods with
-- a free-text escape hatch. Neither was admin-configurable without a code
-- change. Fixes both, non-destructively: existing free-text categories are
-- backfilled into the new material_categories table rather than discarded,
-- and `unit` stays a plain text column everywhere (not FK'd) so no existing
-- row's unit value can become invalid -- units_of_measure is a UI picklist
-- source, not a constraint.
-- ============================================================================

-- ============ 1. units_of_measure (global, admin-configurable) ============
CREATE TABLE public.units_of_measure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.units_of_measure TO authenticated;
GRANT ALL ON public.units_of_measure TO service_role;
ALTER TABLE public.units_of_measure ENABLE ROW LEVEL SECURITY;
CREATE POLICY "units of measure read" ON public.units_of_measure FOR SELECT TO authenticated USING (true);
CREATE POLICY "units of measure write" ON public.units_of_measure FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'settings'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'settings'::module_key, 'write'::action_key));
CREATE TRIGGER units_of_measure_touch BEFORE UPDATE ON public.units_of_measure FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.units_of_measure (name, code) VALUES
  ('Kilogram', 'KG'), ('Gram', 'G'), ('Litre', 'LITRE'), ('Millilitre', 'ML'),
  ('Piece', 'PIECE'), ('Unit', 'UNIT'), ('Bag', 'BAG'), ('Carton', 'CARTON'),
  ('Pack', 'PACK'), ('Pallet', 'PALLET'), ('Ton', 'TON'), ('Meter', 'METER'),
  ('Roll', 'ROLL'), ('Sack', 'SACK'), ('Drum', 'DRUM'), ('Box', 'BOX')
ON CONFLICT (code) DO NOTHING;

-- ============ 2. material_categories (mirrors product_categories) ============
CREATE TABLE public.material_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_categories TO authenticated;
GRANT ALL ON public.material_categories TO service_role;
ALTER TABLE public.material_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "material categories read" ON public.material_categories FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'read'::action_key));
CREATE POLICY "material categories write" ON public.material_categories FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'write'::action_key));

-- ============ 3. raw_materials: category_id, minimum_stock, active, created_by ============
ALTER TABLE public.raw_materials ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.material_categories(id);
ALTER TABLE public.raw_materials ADD COLUMN IF NOT EXISTS minimum_stock numeric(14,3) DEFAULT 0;
ALTER TABLE public.raw_materials ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE public.raw_materials ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

-- Backfill: turn each distinct existing free-text category into a real
-- material_categories row (per factory), then point category_id at it.
-- Nothing is deleted -- the old `category` text column stays untouched.
INSERT INTO public.material_categories (factory_id, name)
SELECT DISTINCT factory_id, category FROM public.raw_materials
WHERE category IS NOT NULL AND btrim(category) <> ''
ON CONFLICT DO NOTHING;

UPDATE public.raw_materials rm SET category_id = mc.id
FROM public.material_categories mc
WHERE rm.category_id IS NULL AND rm.category IS NOT NULL AND btrim(rm.category) <> ''
  AND mc.factory_id = rm.factory_id AND mc.name = rm.category;

CREATE OR REPLACE FUNCTION public.set_created_by()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.created_by IS NULL THEN NEW.created_by := auth.uid(); END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS raw_materials_set_created_by ON public.raw_materials;
CREATE TRIGGER raw_materials_set_created_by BEFORE INSERT ON public.raw_materials
  FOR EACH ROW EXECUTE FUNCTION public.set_created_by();
