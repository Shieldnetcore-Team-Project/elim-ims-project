-- ============================================================================
-- Clear QC's mistaken 21 Nov blowing PSR-20261121-00291 (75cl, 71,180 good)
-- ----------------------------------------------------------------------------
-- QC recorded it by mistake; the user asked for it to be cleared off the
-- system (2026-11-21). It has not gone to PM (no live bottle transfer).
--
-- As 20261027100000 + 20261027110000 for PSR-20261027-00017:
--   1. its stocking leaves the 75cl bottle stock and is reversed;
--   2. the preforms it used go back to the blower's holding;
--   3. its ledger lines (which then net to zero) are deleted and the record
--      and stocking are flagged test_cleared, so Send to production, lists and
--      reports leave it out. Rows stay; an audit row keeps what went.
-- Refused if any of it went to PM or the bottles are no longer all in stock.
-- ============================================================================

DO $$
DECLARE
  v_ref text := 'PSR-20261121-00291';
  v_why text := 'Recorded by mistake -- cleared at the user''s request (2026-11-21)';
  v_r preform_shift_records%ROWTYPE;
  s record;
  v_ids uuid[];
  v_net numeric;
  v_rows jsonb;
BEGIN
  SELECT * INTO v_r FROM preform_shift_records WHERE reference = v_ref FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE '% not found', v_ref;
    RETURN;
  END IF;
  IF v_r.test_cleared THEN
    RAISE NOTICE '% already cleared', v_ref;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM bottle_transfers
              WHERE shift_record_id = v_r.id AND status IN ('dispatched', 'received', 'discrepancy')) THEN
    RAISE EXCEPTION '% has bottles sent to PM -- reverse that transfer first; nothing cleared', v_ref;
  END IF;

  IF v_r.status <> 'reversed' THEN
    FOR s IN SELECT * FROM preform_stockings WHERE shift_record_id = v_r.id AND status IN ('sent', 'accepted') LOOP
      IF s.status = 'accepted' AND COALESCE(s.accepted_qty, 0) > 0 THEN
        IF (SELECT current_stock FROM products WHERE id = s.product_id) < s.accepted_qty THEN
          RAISE EXCEPTION 'Only part of % (%) is still in bottle stock; nothing cleared', s.reference, s.accepted_qty;
        END IF;
        PERFORM public._pf_product_move(s.product_id, -s.accepted_qty, 'correction', s.reference, v_why);
      END IF;
      UPDATE preform_stockings
         SET status = CASE WHEN s.status = 'sent' THEN 'cancelled' ELSE 'reversed' END,
             reversed_at = now(), reversal_reason = v_why
       WHERE id = s.id;
      UPDATE preform_exceptions SET status = 'voided', resolved_at = now(), resolution_note = v_why
       WHERE stocking_id = s.id AND status <> 'voided';
      PERFORM public._pf_audit(s.factory_id, 'reverse_preform_stocking', 'preform_stockings', s.id, NULL,
                               jsonb_build_object('reason', v_why));
    END LOOP;

    PERFORM public._pf_undo_usage(v_r.id, v_why);
    UPDATE preform_exceptions SET status = 'voided', resolved_at = now(), resolution_note = v_why
     WHERE shift_record_id = v_r.id AND status <> 'voided';
    UPDATE preform_shift_records SET status = 'reversed', reversed_at = now(), reversal_reason = v_why, updated_at = now()
     WHERE id = v_r.id;
    PERFORM public._pf_audit(v_r.factory_id, 'reverse_preform_shift', 'preform_shift_records', v_r.id, NULL,
                             jsonb_build_object('reason', v_why));
  END IF;

  SELECT array_agg(id), COALESCE(SUM(quantity), 0),
         jsonb_agg(jsonb_build_object('type', movement_type, 'quantity', quantity) ORDER BY created_at)
    INTO v_ids, v_net, v_rows
    FROM preform_movements WHERE shift_record_id = v_r.id;
  IF v_ids IS NOT NULL THEN
    IF v_net <> 0 THEN
      RAISE EXCEPTION '% ledger lines do not net to zero (%), nothing cleared', v_ref, v_net;
    END IF;
    DELETE FROM preform_movements WHERE id = ANY (v_ids);
  END IF;

  UPDATE preform_shift_records SET test_cleared = true, updated_at = now() WHERE id = v_r.id;
  UPDATE preform_stockings SET test_cleared = true WHERE shift_record_id = v_r.id AND status IN ('reversed', 'cancelled');
  PERFORM public._pf_audit(v_r.factory_id, 'clear_reversed_blowing', 'preform_shift_records', v_r.id,
    jsonb_build_object('reference', v_r.reference, 'good', v_r.good_bottles, 'damaged', v_r.damaged_bottles,
                       'ledger_lines', v_rows),
    jsonb_build_object('reason', v_why));
  RAISE NOTICE '% cleared', v_ref;
END $$;
