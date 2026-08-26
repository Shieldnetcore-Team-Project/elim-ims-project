-- ============================================================================
-- WATER / NYLON LINE ISOLATION — schema
-- ----------------------------------------------------------------------------
-- Costing must never let a Nylon material/product surface while building a
-- Water costing sheet, or vice versa. Tags every product/material category
-- with the product line it belongs to, self-populated from the owning
-- factory (today exactly 'water' or 'nylon' — see 20260721052758's factories
-- seed) via trigger so existing AND future categories stay correctly tagged
-- without manual upkeep. costing_sheets records which dedicated worksheet
-- flow (Water or Nylon) produced it, so history/editing routes back to the
-- right isolated form. costing_sheet_items gets a `role` tag (e.g. 'preform',
-- 'cap', 'label', 'blend') so a saved sheet's items can be rehydrated back
-- into the correct named field instead of a generic list.
-- ============================================================================

ALTER TABLE public.product_categories ADD COLUMN product_line text CHECK (product_line IN ('water','nylon'));
ALTER TABLE public.material_categories ADD COLUMN product_line text CHECK (product_line IN ('water','nylon'));

UPDATE public.product_categories pc SET product_line = f.code
FROM public.factories f WHERE pc.factory_id = f.id AND f.code IN ('water','nylon') AND pc.product_line IS NULL;
UPDATE public.material_categories mc SET product_line = f.code
FROM public.factories f WHERE mc.factory_id = f.id AND f.code IN ('water','nylon') AND mc.product_line IS NULL;

CREATE OR REPLACE FUNCTION public.set_category_product_line()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_line IS NULL THEN
    SELECT f.code INTO NEW.product_line FROM public.factories f WHERE f.id = NEW.factory_id AND f.code IN ('water','nylon');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_categories_set_line ON public.product_categories;
CREATE TRIGGER product_categories_set_line BEFORE INSERT ON public.product_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_category_product_line();

DROP TRIGGER IF EXISTS material_categories_set_line ON public.material_categories;
CREATE TRIGGER material_categories_set_line BEFORE INSERT ON public.material_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_category_product_line();

-- ============ costing_sheets: which dedicated worksheet flow produced this sheet ============
ALTER TABLE public.costing_sheets ADD COLUMN sheet_type text CHECK (sheet_type IN ('water','nylon'));

UPDATE public.costing_sheets cs SET sheet_type = COALESCE(
  (SELECT pc.product_line FROM public.products p LEFT JOIN public.product_categories pc ON pc.id = p.category_id WHERE p.id = cs.product_id),
  (SELECT f.code FROM public.factories f WHERE f.id = cs.factory_id AND f.code IN ('water','nylon'))
)
WHERE cs.sheet_type IS NULL;

-- ============ costing_sheet_items: role tag for rehydrating named fields on edit ============
ALTER TABLE public.costing_sheet_items ADD COLUMN role text;
