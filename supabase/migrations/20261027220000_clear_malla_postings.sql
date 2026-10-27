-- ============================================================================
-- Clear Malla's 27 Oct postings so they are entered afresh
-- ----------------------------------------------------------------------------
-- Malla (SR-04) was posted 75cl Bottle in pieces, then corrected twice; the
-- user asked for all four records to be cleared so the warehouse manager
-- posts again from scratch (2026-10-27):
--   DSP-20261027-69482  75cl Bottle x 180 (reversed: posted in pieces)
--   DSP-20261027-02989  75cl Bottle Water x 180 (reversed: corrected)
--   DSP-20261027-10641  50cl Bottle Water x 180 (reversed: corrected)
--   DSP-20261027-46647  75cl Bottle Water x 180 (posted)
--
-- The live one is reversed first (off Malla, back into the Warehouse), as
-- reverse_stock_dispatch does; refused, changing nothing, if Malla has
-- already sold or returned some of it. Then, with every one reversed, their
-- stock ledger lines (which net to zero) and the postings themselves are
-- deleted, so nothing of them is left on Malla's account or the Warehouse
-- stock card. An audit row keeps a copy of each. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_numbers constant text[] := ARRAY['DSP-20261027-69482', 'DSP-20261027-02989',
                                     'DSP-20261027-10641', 'DSP-20261027-46647'];
  v_d stock_dispatches%ROWTYPE;
  v_item record;
  v_before numeric;
  v_ids uuid[];
  v_copy jsonb;
BEGIN
  -- 1. Reverse what is still posted.
  FOR v_d IN SELECT * FROM stock_dispatches WHERE dispatch_number = ANY (v_numbers) AND status = 'posted' FOR UPDATE LOOP
    FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = v_d.id LOOP
      SELECT quantity INTO v_before FROM rep_stock
       WHERE sales_rep_id = v_d.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      IF COALESCE(v_before, 0) < v_item.quantity THEN
        RAISE EXCEPTION '% not cleared: Malla has already sold or returned some of it -- nothing changed', v_d.dispatch_number;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
       WHERE sales_rep_id = v_d.sales_rep_id AND product_id = v_item.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_d.factory_id, v_d.sales_rep_id, v_item.product_id, 'reversal', -v_item.quantity, v_d.dispatch_number,
              'Cleared to be posted afresh', auth.uid(), v_before, v_before - v_item.quantity);
      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_d.factory_id, v_item.product_id, 'return_from_rep', v_item.quantity, v_d.dispatch_number,
              'Posting cleared to be posted afresh', auth.uid(), v_before, v_before + v_item.quantity);
    END LOOP;
    UPDATE stock_dispatches SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(),
           reverse_reason = 'Cleared to be posted afresh'
     WHERE id = v_d.id;
  END LOOP;

  SELECT array_agg(id) INTO v_ids FROM stock_dispatches WHERE dispatch_number = ANY (v_numbers);
  IF v_ids IS NULL THEN
    RAISE NOTICE 'Malla postings already cleared';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM stock_dispatches WHERE id = ANY (v_ids) AND status <> 'reversed') THEN
    RAISE EXCEPTION 'Not every Malla posting is reversed -- nothing cleared';
  END IF;

  -- 2. Their ledger lines net to zero per product; refuse otherwise.
  IF EXISTS (SELECT 1 FROM inventory_movements WHERE reference = ANY (v_numbers)
              GROUP BY product_id HAVING SUM(quantity_after - quantity_before) <> 0)
     OR EXISTS (SELECT 1 FROM rep_stock_movements WHERE reference = ANY (v_numbers)
                 GROUP BY sales_rep_id, product_id HAVING SUM(quantity_after - quantity_before) <> 0) THEN
    RAISE EXCEPTION 'Malla posting ledger lines do not net to zero -- nothing cleared';
  END IF;

  SELECT jsonb_agg(to_jsonb(d) || jsonb_build_object('items',
           (SELECT jsonb_agg(to_jsonb(i)) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id)))
    INTO v_copy FROM stock_dispatches d WHERE d.id = ANY (v_ids);

  DELETE FROM inventory_movements WHERE reference = ANY (v_numbers);
  DELETE FROM rep_stock_movements WHERE reference = ANY (v_numbers);
  DELETE FROM container_movements WHERE dispatch_id = ANY (v_ids);
  UPDATE rep_returns SET carried_dispatch_id = NULL WHERE carried_dispatch_id = ANY (v_ids);
  DELETE FROM stock_dispatches WHERE id = ANY (v_ids);  -- items go with them

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), (v_copy->0->>'factory_id')::uuid, 'delete', 'stock_dispatch', 'malla-2026-10-27', v_copy,
          jsonb_build_object('reason', 'Malla 27 Oct postings cleared to be posted afresh (2026-10-27)'));
  RAISE NOTICE 'Cleared % Malla postings', array_length(v_ids, 1);
END $$;
