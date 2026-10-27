-- ============================================================================
-- Clear the 50cl / 75cl Bottle batches entered in pieces
-- ----------------------------------------------------------------------------
-- The production manager recorded 50cl Bottle (497) and 75cl Bottle (1,683)
-- in Piece; they sit in the production hall, nothing released yet. The user
-- asked for them to be cleared so she enters them again in packs
-- (2026-10-27).
--
-- Every batch of those two products still in the hall (pending_confirmation)
-- is cancelled, as cancel_production does: the hall drops to 0 for them and a
-- linked production request becomes available again. Rows stay (status
-- cancelled); an audit row lists what was cleared. A product with any release
-- to the Warehouse (pending or accepted) is left alone and a notice says so.
-- Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_product record;
  v_rows jsonb;
  v_total numeric;
BEGIN
  FOR v_product IN
    SELECT pr.id, pr.name, pr.factory_id FROM products pr
     WHERE pr.name IN ('50cl Bottle', '75cl Bottle')
  LOOP
    IF EXISTS (SELECT 1 FROM production_releases r
                WHERE r.product_id = v_product.id AND r.status IN ('pending','accepted')) THEN
      RAISE NOTICE 'Skipped %: some of it was already released to the Warehouse -- cancel its batches on the Production page', v_product.name;
      CONTINUE;
    END IF;

    SELECT jsonb_agg(jsonb_build_object('production_number', p.production_number, 'date', p.production_date,
                                        'quantity', p.quantity_produced, 'unit', p.unit)),
           COALESCE(SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0)), 0)
      INTO v_rows, v_total
      FROM production p
     WHERE p.product_id = v_product.id AND p.status = 'pending_confirmation';
    IF v_rows IS NULL THEN
      RAISE NOTICE '%: nothing in the hall', v_product.name;
      CONTINUE;
    END IF;

    UPDATE production_requests rq SET production_status = 'materials_issued'
      FROM production p
     WHERE p.product_id = v_product.id AND p.status = 'pending_confirmation'
       AND rq.id = p.production_request_id AND rq.production_status = 'completed';
    UPDATE production SET status = 'cancelled'
     WHERE product_id = v_product.id AND status = 'pending_confirmation';

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_product.factory_id, 'cancel', 'production', v_product.id::text,
            jsonb_build_object('product', v_product.name, 'cleared_from_hall', v_total, 'batches', v_rows,
                               'reason', 'Entered in pieces; cleared to be entered again in packs (2026-10-27)'));
    RAISE NOTICE '%: % cleared from the hall', v_product.name, v_total;
  END LOOP;
END $$;
