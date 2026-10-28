-- ============================================================================
-- Empty jugs are Store raw material, not finished products
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-28): empty jugs come in as raw material -- the
-- Store receives new empty jugs and posts them to QC, QC fills them and they
-- are released to the Warehouse as Dispenser/Jug Water, which the Warehouse
-- posts to marketers, distributors and the retail shop (Elim). So "Empty Jug"
-- leaves Warehouse → Finished Products / Available Stock. ("Jug + Water" is
-- the dispenser itself: it stays a finished product, as Dispenser/Jug Water
-- (New Jug), 20261028140000.) In the Water Factory:
--   * the Store's jug raw materials exist (Dispenser category: "Empty
--     Dispenser Bottle (Old)" and "Empty Dispenser Bottle (New)",
--     seed_standard_raw_materials, 20261014160000);
--   * the finished product "Empty Jug" is deactivated, so it leaves every
--     product list (Finished Products, Warehouse, Post,
--     sales). Nothing is deleted: its past sales and postings stay on
--     record. If it still holds stock it is left active, with a notice, so
--     no stock disappears -- move it first.
-- Dispenser/Jug Water (New Jug) / (Old Jug) stay the finished products for
-- filled jugs (20261028140000). An admin can reactivate a product in
-- Settings → Products. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_p record;
  v_done jsonb := '[]'::jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  PERFORM public.seed_standard_raw_materials();

  FOR v_p IN SELECT id, name, current_stock FROM products
              WHERE factory_id = v_factory AND active
                AND lower(btrim(name)) = 'empty jug'
  LOOP
    IF v_p.current_stock <> 0 THEN
      RAISE NOTICE '% still holds % in stock -- left active; move the stock, then run this again', v_p.name, v_p.current_stock;
      CONTINUE;
    END IF;
    UPDATE products SET active = false, updated_at = now() WHERE id = v_p.id;
    v_done := v_done || to_jsonb(v_p.name);
  END LOOP;

  IF jsonb_array_length(v_done) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'deactivate', 'products', 'jugs-to-store',
            jsonb_build_object('deactivated', v_done,
                               'reason', 'Empty jugs are Store raw material (Empty Dispenser Bottle Old / New), not a finished product (2026-10-28)'));
  END IF;
  RAISE NOTICE 'Taken off finished products: %', v_done;
END $$;
