-- ============================================================================
-- REMOVE NYLON DEMO SET-UP ITEMS — permanently deletes the demo lists that
-- 20260814100000_seed_demo_data.sql put into the NYLON factory only.
-- ----------------------------------------------------------------------------
-- THIS CANNOT BE UNDONE. Run go_live_reset.sql FIRST (it clears the sales,
-- production and stock records that point at these items). This script refuses
-- to run while any of those records still exist, and changes nothing if so.
--
-- Deletes, in the Nylon factory only (matched by the exact demo codes/names):
--   * products             NYL-BAGSM, NYL-BAGLG, NYL-ROLL, NYL-PELLET
--                          (Nylon Shopping Bag - Small / Large, Packaging Roll -
--                           500m, Recycled Nylon Pellet)
--   * product categories   Shopping Bags, Packaging Rolls
--   * raw materials        LDPE Resin, HDPE Resin, Colour Masterbatch, Low Recycle Material
--   * suppliers            Polymer Traders Ltd, NylonPack Materials
--   * employees            DEMO-EMP-N001 .. N003 (Emeka Obi, Fatima Bello, Chidi Okafor)
--   * vehicle / driver / route   XYZ-456-KJ, LIC-N-001, Lagos Island / Apapa Route
--
-- Keeps everything else, including the 11 real Nylon products added by
-- 20260922090000_nylon_products_seed.sql, and everything in the Water factory.
--
-- Run the whole file in the Supabase SQL Editor. The result at the bottom
-- should say NYLON DEMO SET-UP REMOVED.
-- ============================================================================

BEGIN;

-- 0. Refuse to run before the go-live reset.
DO $$
DECLARE busy text;
BEGIN
  SELECT string_agg(t, ', ') INTO busy FROM unnest(ARRAY[
    'sales','sale_items','production','production_requests','production_request_items','purchase_orders',
    'inventory_movements','raw_material_movements','goods_receipts','payroll','staff_loans','deliveries',
    'damage_records','sales_returns','expenses','costing_sheets','stock_dispatches','rep_stock'
  ]) t
  WHERE (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::int > 0;
  IF busy IS NOT NULL THEN
    RAISE EXCEPTION 'Run go_live_reset.sql first — these tables still hold records: %. Nothing was changed.', busy;
  END IF;
END $$;

-- 1. Delete the demo items (Nylon factory only). Plain DELETEs with no CASCADE:
--    if anything still points at an item, PostgreSQL refuses and everything rolls back.
DO $$
DECLARE v_nylon uuid;
BEGIN
  SELECT id INTO v_nylon FROM public.factories WHERE code = 'nylon';
  IF v_nylon IS NULL THEN RAISE EXCEPTION 'Nylon factory not found. Nothing was changed.'; END IF;

  DELETE FROM public.products
   WHERE factory_id = v_nylon AND sku IN ('NYL-BAGSM','NYL-BAGLG','NYL-ROLL','NYL-PELLET');
  DELETE FROM public.product_categories
   WHERE factory_id = v_nylon AND name IN ('Shopping Bags','Packaging Rolls');
  DELETE FROM public.raw_materials
   WHERE factory_id = v_nylon AND name IN ('LDPE Resin','HDPE Resin','Colour Masterbatch','Low Recycle Material');
  DELETE FROM public.suppliers
   WHERE factory_id = v_nylon AND name IN ('Polymer Traders Ltd','NylonPack Materials');
  DELETE FROM public.employees
   WHERE factory_id = v_nylon AND employee_code IN ('DEMO-EMP-N001','DEMO-EMP-N002','DEMO-EMP-N003');
  DELETE FROM public.vehicles
   WHERE factory_id = v_nylon AND plate_number = 'XYZ-456-KJ';
  DELETE FROM public.drivers
   WHERE factory_id = v_nylon AND license_number = 'LIC-N-001';
  DELETE FROM public.delivery_routes
   WHERE factory_id = v_nylon AND name = 'Lagos Island / Apapa Route';
END $$;

COMMIT;

-- What Nylon still has (should be only the items you added yourself).
SELECT 'NYLON DEMO SET-UP REMOVED' AS result,
       (SELECT COUNT(*) FROM public.products      p JOIN public.factories f ON f.id = p.factory_id WHERE f.code = 'nylon') AS nylon_products_left,
       (SELECT COUNT(*) FROM public.raw_materials r JOIN public.factories f ON f.id = r.factory_id WHERE f.code = 'nylon') AS nylon_raw_materials_left,
       (SELECT COUNT(*) FROM public.suppliers     s JOIN public.factories f ON f.id = s.factory_id WHERE f.code = 'nylon') AS nylon_suppliers_left,
       (SELECT COUNT(*) FROM public.employees     e JOIN public.factories f ON f.id = e.factory_id WHERE f.code = 'nylon') AS nylon_employees_left;
