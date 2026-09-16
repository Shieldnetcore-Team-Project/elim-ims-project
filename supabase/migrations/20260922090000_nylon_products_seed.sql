-- ============================================================================
-- SEED NYLON PRODUCTS — 11 finished products added to the Nylon factory's
-- product catalog. Once inserted these appear automatically everywhere
-- products are already selected from a dropdown (Sales, Sales Returns,
-- Production, etc.) — no UI change needed for that.
--
-- unit_price/cost_price/reorder_level default to 0 (same as a fresh product
-- created through the Finished Goods "Add New Product" form) — set the real
-- selling price via Finished Goods > Edit for each one. Units below are a
-- best guess from the name; adjust via Edit if wrong.
--
-- Guarded with NOT EXISTS on (factory_id, name) so this is safe to re-run
-- without creating duplicates.
-- ============================================================================
DO $$
DECLARE
  v_nylon uuid;
BEGIN
  SELECT id INTO v_nylon FROM public.factories WHERE code = 'nylon';
  IF v_nylon IS NULL THEN RAISE EXCEPTION 'Nylon factory not found'; END IF;

  INSERT INTO public.products (factory_id, name, unit, product_type)
  SELECT v_nylon, v.name, v.unit, 'finished'
  FROM (VALUES
    ('Iceblock Nylon (Bundles)', 'bundles'),
    ('Packing Bags', 'pieces'),
    ('Plain Shopping Bags', 'pieces'),
    ('Branded Shopping Bags', 'pieces'),
    ('Shrink', 'rolls'),
    ('Jumbo Black Shopping', 'pieces'),
    ('SS2 (Count 80)', 'pieces'),
    ('SS2 (Count 100)', 'pieces'),
    ('Bread Nylon', 'pieces'),
    ('Pharmacy Bags', 'pieces'),
    ('Printed Pure Water Rolls', 'rolls')
  ) AS v(name, unit)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.products p WHERE p.factory_id = v_nylon AND p.name = v.name
  );
END $$;
