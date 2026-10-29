-- ============================================================================
-- 50cl Bottle Water: Warehouse stock set to 91 packs
-- ----------------------------------------------------------------------------
-- The user (2026-10-29): the Warehouse shows 421 Pack of 50cl Bottle Water;
-- it must be 91. (20261029150000 only added 5 when the stock was exactly 86,
-- so it changed nothing at 421.)
--
-- Sets current stock to 91 now, whatever it is, with the difference posted
-- as an 'adjusted' ledger line and an audit row. Refused while a Warehouse
-- posting to a distributor with 50cl is still waiting (pending approval):
-- posting it afterwards would take it below 91 -- run
-- 20261029140000_warehouse_postings_post_at_once.sql first. Safe to run
-- again (already 91: nothing changes).
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_product products%ROWTYPE;
  v_delta numeric;
  v_waiting text;
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

  SELECT string_agg(DISTINCT s.invoice_number, ', ') INTO v_waiting
    FROM sales s JOIN sale_items si ON si.sale_id = s.id
   WHERE si.product_id = v_product.id AND s.status = 'pending_approval'
     AND s.deleted_at IS NULL AND public.is_warehouse_posting(s);
  IF v_waiting IS NOT NULL THEN
    RAISE EXCEPTION 'Not changed: 50cl postings still waiting (%). Run 20261029140000_warehouse_postings_post_at_once.sql first, then this.',
      v_waiting;
  END IF;

  v_delta := 91 - v_product.current_stock;
  IF v_delta = 0 THEN
    RAISE NOTICE '50cl Bottle Water is already 91 -- not changed';
    RETURN;
  END IF;

  UPDATE products SET current_stock = 91, updated_at = now() WHERE id = v_product.id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after)
  VALUES (v_factory, v_product.id, 'adjusted', v_delta, 'STOCK-COUNT-2026-10-29-50CL',
          format('Warehouse stock set to 91 %s (user, 29 Oct 2026)', v_product.unit), auth.uid(),
          v_product.current_stock, 91);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'stock_count', 'products', v_product.id::text,
          jsonb_build_object('current_stock', v_product.current_stock),
          jsonb_build_object('current_stock', 91, 'adjusted_by', v_delta,
                             'reason', 'Warehouse stock of 50cl Bottle Water set to 91 (user, 29 Oct 2026)'));
  RAISE NOTICE '50cl Bottle Water: % -> 91', v_product.current_stock;
END $$;
