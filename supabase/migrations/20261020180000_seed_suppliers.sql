-- ============================================================================
-- Suppliers list for the Water Factory
-- ----------------------------------------------------------------------------
-- The factory's current suppliers, so they are in every supplier dropdown
-- (Store → Add Material / goods receipt, QC inspection, purchase orders).
-- "Prima" was listed twice (Prima / PRIMA) and is added once. A supplier
-- already present under the same name (ignoring case and spacing) is left as
-- it is, so this is safe to run again. More suppliers can be added from the
-- dropdowns themselves (quick_add_supplier, 20261020150000) or the Suppliers
-- page.
-- ============================================================================

INSERT INTO public.suppliers (factory_id, name)
SELECT f.id, s.name
  FROM public.factories f
 CROSS JOIN (VALUES
   ('Prima'), ('YUNO MOLD'), ('Sentric'), ('KRS'), ('Packing Nylon'), ('Preform 29mm'),
   ('Preform'), ('Pentagon 29mm'), ('Preform1'), ('Cup Film'), ('Jug Cap')
 ) AS s(name)
 WHERE f.code = 'water'
   AND NOT EXISTS (
     SELECT 1 FROM public.suppliers x
      WHERE x.factory_id = f.id
        AND lower(regexp_replace(btrim(x.name), '\s+', ' ', 'g')) = lower(s.name));
