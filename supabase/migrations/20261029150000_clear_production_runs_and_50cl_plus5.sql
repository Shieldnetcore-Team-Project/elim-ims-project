-- ============================================================================
-- Clear the cleared batches off Production Runs; 50cl Warehouse stock 86 -> 91
-- ----------------------------------------------------------------------------
-- 1. The user (2026-10-29): after the hall clear-out (20261029120000) the
--    cleared batches still listed under Production → Production Runs
--    (PRD20261029-73318 75cl 1,487 Pack, PRD20261029-91462 50cl 820 Pack,
--    "In Production Hall") -- clear them too.
--    For each product whose cleared batches never had anything released
--    (its clearances add up to exactly those batches' good quantity), the
--    batches and the clearances are deleted together, so the hall stays 0
--    and the list starts empty. A product that had releases is left alone,
--    with a notice (deleting would put its hall below 0). A linked production
--    request loses the link; the approval trail goes with the batch. An audit
--    row keeps a copy of everything deleted.
--
-- 2. The user: add 5 packs of 50cl Bottle Water to Warehouse stock to make
--    91 (106 at the 28 Oct close, less 20 posted to ONOJA JOHNSON on
--    INV20261029-90005 = 86). Applied only when the stock is exactly 86, as
--    an 'adjusted' ledger line; any other figure changes nothing and says so
--    (run 20261029140000 first so that posting has come out of stock).
--
-- Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_p record;
  v_batches uuid[];
  v_good numeric;
  v_cleared numeric;
  v_copy jsonb := '[]'::jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  FOR v_p IN
    SELECT c.product_id, p.name, SUM(c.quantity) AS cleared, MAX(c.cleared_at) AS last_at
      FROM production_hall_clearances c JOIN products p ON p.id = c.product_id
     WHERE c.factory_id = v_factory
     GROUP BY c.product_id, p.name
  LOOP
    SELECT array_agg(id), COALESCE(SUM(quantity_produced - COALESCE(damaged_quantity, 0)), 0)
      INTO v_batches, v_good
      FROM production
     WHERE factory_id = v_factory AND product_id = v_p.product_id
       AND status = 'pending_confirmation' AND created_at <= v_p.last_at;
    v_cleared := v_p.cleared;
    IF v_batches IS NULL OR v_good <> v_cleared THEN
      RAISE NOTICE '%: cleared batches had releases (or none are left) -- left on the list', v_p.name;
      CONTINUE;
    END IF;

    v_copy := v_copy || jsonb_build_object(
      'product', v_p.name,
      'batches', (SELECT jsonb_agg(to_jsonb(b)) FROM production b WHERE b.id = ANY (v_batches)),
      'clearances', (SELECT jsonb_agg(to_jsonb(c)) FROM production_hall_clearances c
                      WHERE c.factory_id = v_factory AND c.product_id = v_p.product_id));
    UPDATE production_requests SET production_id = NULL WHERE production_id = ANY (v_batches);
    DELETE FROM workflow_approval_history WHERE module = 'production' AND entity_id = ANY (v_batches);
    DELETE FROM production WHERE id = ANY (v_batches);
    DELETE FROM production_hall_clearances WHERE factory_id = v_factory AND product_id = v_p.product_id;
    RAISE NOTICE '%: % cleared batch(es) removed from Production Runs', v_p.name, array_length(v_batches, 1);
  END LOOP;

  IF jsonb_array_length(v_copy) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (auth.uid(), v_factory, 'delete', 'production', 'production-runs-cleared-2026-10-29', v_copy,
            jsonb_build_object('reason', 'Cleared batches removed from Production Runs to start afresh (2026-10-29)'));
  END IF;
END $$;

DO $$
DECLARE
  v_factory uuid;
  v_product products%ROWTYPE;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  SELECT * INTO v_product FROM products
   WHERE factory_id = v_factory AND product_type = 'finished'
     AND lower(btrim(name)) = '50cl bottle water'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE '50cl Bottle Water not found -- not changed';
    RETURN;
  END IF;
  IF v_product.current_stock = 91 THEN
    RAISE NOTICE '50cl Bottle Water is already 91 -- not changed';
    RETURN;
  END IF;
  IF v_product.current_stock <> 86 THEN
    RAISE NOTICE '50cl Bottle Water is % (expected 86 = 106 - 20 posted) -- not changed. Run 20261029140000 first, or say what it should be.',
      v_product.current_stock;
    RETURN;
  END IF;

  UPDATE products SET current_stock = 91, updated_at = now() WHERE id = v_product.id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after)
  VALUES (v_factory, v_product.id, 'adjusted', 5, 'STOCK-ADD-2026-10-29',
          'Warehouse stock correction: 5 packs added to make 91 (user, 29 Oct 2026)', auth.uid(), 86, 91);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'stock_count', 'products', v_product.id::text,
          jsonb_build_object('current_stock', 86), jsonb_build_object('current_stock', 91, 'added', 5));
  RAISE NOTICE '50cl Bottle Water: 86 -> 91';
END $$;

NOTIFY pgrst, 'reload schema';
