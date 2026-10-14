-- ============================================================================
-- Empty dispenser bottles as standard raw materials
-- ----------------------------------------------------------------------------
-- The Warehouse requests empty dispenser bottles from the Store like any other
-- raw material, and there are two kinds: the old bottle and the new bottle.
-- Both must always be in the raw-material dropdown of the Store request form,
-- including on a freshly reset system.
--
-- seed_standard_raw_materials() creates, in the water factory, a "Dispenser"
-- material category and the two bottles (counted in pieces, zero stock --
-- the Store enters real stock when it arrives). It is idempotent: an existing
-- category or material of the same name (case-insensitive) is left alone, so
-- it is safe to run any number of times. This migration runs it once, and
-- supabase/scripts/go_live_reset.sql runs it again after wiping.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_standard_raw_materials()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_factory uuid;
  v_category uuid;
  v_name text;
  v_added integer := 0;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN RETURN 0; END IF;

  SELECT id INTO v_category FROM material_categories
   WHERE factory_id = v_factory AND lower(btrim(name)) = 'dispenser'
   LIMIT 1;
  IF v_category IS NULL THEN
    INSERT INTO material_categories (factory_id, name, product_line)
    VALUES (v_factory, 'Dispenser', 'water')
    RETURNING id INTO v_category;
  END IF;

  FOREACH v_name IN ARRAY ARRAY['Empty Dispenser Bottle (Old)', 'Empty Dispenser Bottle (New)'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM raw_materials
       WHERE factory_id = v_factory AND lower(btrim(name)) = lower(v_name)
    ) THEN
      INSERT INTO raw_materials (factory_id, name, category_id, unit, opening_stock, current_stock,
                                 unit_cost, current_value, reorder_level, minimum_stock,
                                 approval_status, active)
      VALUES (v_factory, v_name, v_category, 'Piece', 0, 0, 0, 0, 0, 0, 'approved', true);
      v_added := v_added + 1;
    END IF;
  END LOOP;

  RETURN v_added;
END; $$;

REVOKE ALL ON FUNCTION public.seed_standard_raw_materials() FROM PUBLIC, anon, authenticated;

SELECT public.seed_standard_raw_materials();
