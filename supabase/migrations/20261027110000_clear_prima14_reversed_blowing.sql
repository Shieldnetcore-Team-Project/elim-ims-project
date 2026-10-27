-- ============================================================================
-- Clear Prima 14g's reversed 27 Oct blowing so QC records it afresh
-- ----------------------------------------------------------------------------
-- 20261027100000_delete_prima14_test_damage.sql reversed PSR-20261027-00017
-- (28,494 good, 66 damaged) with a 'usage_reversed' line, but its
-- 'damaged_bottles' line stayed in preform_movements, so the Store's usage
-- report still showed 66 damaged (-66) for Prima 14g. The user asked for the
-- 66 to be cancelled and the processing undone so QC starts again (2026-10-27).
--
-- Deletes the record's ledger lines (good, damaged, usage reversed: they net
-- to zero, so QC still holds all 74,256 pieces; refused if they do not) and
-- flags the record and its stocking test_cleared so screens leave them out,
-- as for the cleared test data (20261026120000). Rows stay; an audit row
-- keeps what went.
-- ============================================================================

DO $$
DECLARE
  v_r preform_shift_records%ROWTYPE;
  v_ids uuid[];
  v_net numeric;
  v_rows jsonb;
BEGIN
  SELECT * INTO v_r FROM preform_shift_records WHERE reference = 'PSR-20261027-00017' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'PSR-20261027-00017 not found';
    RETURN;
  END IF;
  IF v_r.status <> 'reversed' THEN
    RAISE EXCEPTION 'PSR-20261027-00017 is % -- only a reversed blowing is cleared', v_r.status;
  END IF;

  SELECT array_agg(id), COALESCE(SUM(quantity), 0),
         jsonb_agg(jsonb_build_object('type', movement_type, 'quantity', quantity) ORDER BY created_at)
    INTO v_ids, v_net, v_rows
    FROM preform_movements WHERE shift_record_id = v_r.id;
  IF v_ids IS NOT NULL THEN
    IF v_net <> 0 THEN
      RAISE EXCEPTION 'PSR-20261027-00017 ledger lines do not net to zero (%), nothing cleared', v_net;
    END IF;
    DELETE FROM preform_movements WHERE id = ANY (v_ids);
  END IF;

  UPDATE preform_shift_records SET test_cleared = true, updated_at = now() WHERE id = v_r.id;
  UPDATE preform_stockings SET test_cleared = true WHERE shift_record_id = v_r.id AND status IN ('reversed', 'cancelled');
  PERFORM public._pf_audit(v_r.factory_id, 'clear_reversed_blowing', 'preform_shift_records', v_r.id,
    jsonb_build_object('reference', v_r.reference, 'good', v_r.good_bottles, 'damaged', v_r.damaged_bottles,
                       'ledger_lines', v_rows),
    jsonb_build_object('reason', 'Cancel the 66 damaged and re-record Prima 14g afresh (user, 2026-10-27)'));
END $$;
