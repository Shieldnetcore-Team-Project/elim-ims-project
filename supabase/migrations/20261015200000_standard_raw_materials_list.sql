-- ============================================================================
-- Standard raw materials for table water production
-- ----------------------------------------------------------------------------
-- Extends seed_standard_raw_materials() (20261014160000, which only had the
-- two empty dispenser bottles) to the materials a table water plant uses for
-- sachet water, bottled water (preform blowing and caps) and dispenser
-- bottles, plus water treatment, coding, cleaning and fuel. They show in every
-- raw-material dropdown: QC Record Inspection, Store requests, Raw Materials.
--
-- Each is created in the water factory under its category, with zero stock and
-- zero cost -- the Store enters real stock and prices as deliveries arrive.
-- Idempotent: an existing category or material of the same name
-- (case-insensitive) is left alone, so it is safe to run any number of times.
-- go_live_reset.sql already runs it after wiping.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_standard_raw_materials()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_factory uuid;
  v_category uuid;
  v_item record;
  v_added integer := 0;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN RETURN 0; END IF;

  FOR v_item IN
    SELECT * FROM (VALUES
      -- category,              material,                                  unit
      (1,  'Dispenser',              'Empty Dispenser Bottle (Old)',            'Piece'),
      (2,  'Dispenser',              'Empty Dispenser Bottle (New)',            'Piece'),
      (3,  'Dispenser',              'Dispenser Bottle Caps (Non-spill)',       'Piece'),
      (4,  'Dispenser',              'Dispenser Cap Seal / Shrink Sleeve',      'Piece'),
      (5,  'Dispenser',              'Dispenser Bottle Labels',                 'Piece'),
      (6,  'Dispenser',              'Dispenser Bottle Handles',                'Piece'),

      (10, 'Sachet Packaging',       'Sachet Nylon Film (Printed Roll)',        'Roll'),
      (11, 'Sachet Packaging',       'Sachet Packing Bags (Outer Bag)',         'Piece'),

      (20, 'Bottle Packaging',       'PET Preform (35cl)',                      'Piece'),
      (21, 'Bottle Packaging',       'PET Preform (50cl)',                      'Piece'),
      (22, 'Bottle Packaging',       'PET Preform (75cl)',                      'Piece'),
      (23, 'Bottle Packaging',       'PET Preform (1.5L)',                      'Piece'),
      (24, 'Bottle Packaging',       'Bottle Caps',                             'Piece'),
      (25, 'Bottle Packaging',       'Bottle Labels',                           'Roll'),
      (26, 'Bottle Packaging',       'Label Glue (Hot Melt)',                   'Kilogram'),
      (27, 'Bottle Packaging',       'Shrink Wrap Film',                        'Roll'),
      (28, 'Bottle Packaging',       'Stretch Film',                            'Roll'),
      (29, 'Bottle Packaging',       'Cartons',                                 'Piece'),

      (30, 'Cap Production',         'HDPE Granules (Caps)',                    'Kilogram'),
      (31, 'Cap Production',         'PP Granules (Caps)',                      'Kilogram'),
      (32, 'Cap Production',         'Masterbatch (Colourant)',                 'Kilogram'),

      (40, 'Water Treatment',        'Chlorine (Calcium Hypochlorite)',         'Kilogram'),
      (41, 'Water Treatment',        'Alum (Aluminium Sulphate)',               'Kilogram'),
      (42, 'Water Treatment',        'Caustic Soda',                            'Kilogram'),
      (43, 'Water Treatment',        'Soda Ash',                                'Kilogram'),
      (44, 'Water Treatment',        'Antiscalant',                             'Litre'),
      (45, 'Water Treatment',        'Activated Carbon',                        'Kilogram'),
      (46, 'Water Treatment',        'Filter Sand (Quartz)',                    'Bag'),
      (47, 'Water Treatment',        'Softener Resin',                          'Bag'),
      (48, 'Water Treatment',        'Softener Salt',                           'Bag'),
      (49, 'Water Treatment',        'Cartridge Filter (5 Micron)',             'Piece'),
      (50, 'Water Treatment',        'Cartridge Filter (1 Micron)',             'Piece'),
      (51, 'Water Treatment',        'RO Membrane',                             'Piece'),
      (52, 'Water Treatment',        'UV Lamp',                                 'Piece'),
      (53, 'Water Treatment',        'Water Test Reagents',                     'Unit'),

      (60, 'Coding & Printing',      'Coding Ink',                              'Litre'),
      (61, 'Coding & Printing',      'Coding Solvent (Make-up)',                'Litre'),

      (70, 'Cleaning & Sanitation',  'Detergent',                               'Litre'),
      (71, 'Cleaning & Sanitation',  'Sanitiser / Disinfectant',                'Litre'),

      (80, 'Fuel & Utilities',       'Diesel',                                  'Litre')
    ) AS t(ord, category, name, unit)
    ORDER BY ord
  LOOP
    SELECT id INTO v_category FROM material_categories
     WHERE factory_id = v_factory AND lower(btrim(name)) = lower(v_item.category)
     LIMIT 1;
    IF v_category IS NULL THEN
      INSERT INTO material_categories (factory_id, name, product_line)
      VALUES (v_factory, v_item.category, 'water')
      RETURNING id INTO v_category;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM raw_materials
       WHERE factory_id = v_factory AND lower(btrim(name)) = lower(v_item.name)
    ) THEN
      INSERT INTO raw_materials (factory_id, name, category_id, unit, opening_stock, current_stock,
                                 unit_cost, current_value, reorder_level, minimum_stock,
                                 approval_status, active)
      VALUES (v_factory, v_item.name, v_category, v_item.unit, 0, 0, 0, 0, 0, 0, 'approved', true);
      v_added := v_added + 1;
    END IF;
  END LOOP;

  RETURN v_added;
END; $$;

REVOKE ALL ON FUNCTION public.seed_standard_raw_materials() FROM PUBLIC, anon, authenticated;

SELECT public.seed_standard_raw_materials();
