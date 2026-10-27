-- ============================================================================
-- Delete Prima 14g's 23 Oct test lines from the preform ledger
-- ----------------------------------------------------------------------------
-- The 23 Oct test blowing (PSR-20261023-00004: 33,264 good, 72 damaged
-- bottles) was undone on 26 Oct by a 'usage_reversed' line
-- (20261026110000_clear_test_preform_activity.sql), but its 'damaged_bottles'
-- line stayed in preform_movements, so the Store's usage-by-type reports still
-- showed 72 damaged bottles for Prima 14g before any real blowing. The user
-- asked for them to be deleted (2026-10-27).
--
-- Deletes every ledger line of the cleared test issue and blowing for Prima
-- 14g (issue in, good, damaged, usage reversed, issue reversed). They net to
-- zero, so no holding changes; refused if they do not. The blowing record and
-- issue stay as test_cleared (already hidden); an audit row keeps what went.
--
-- Then, at the user's request, reverses QC's 27 Oct Prima 14g blowing
-- (PSR-20261027-00017: 28,494 good, 66 damaged) so she can record it again
-- with the right figures: its stocking leaves the bottle stock and the
-- 28,560 preforms go back to her holding. Refused if any of it has moved on
-- (bottles short in stock, or a later blowing of hers on Prima 14g).
-- ============================================================================

DO $$
DECLARE
  v_ids uuid[];
  v_net numeric;
  v_factory uuid;
  v_rows jsonb;
BEGIN
  SELECT array_agg(pm.id), COALESCE(SUM(pm.quantity), 0), min(pm.factory_id::text)::uuid,
         jsonb_agg(jsonb_build_object('reference', pm.reference, 'type', pm.movement_type, 'quantity', pm.quantity)
                   ORDER BY pm.created_at)
    INTO v_ids, v_net, v_factory, v_rows
    FROM preform_movements pm
    JOIN raw_materials m ON m.id = pm.material_id
   WHERE lower(btrim(m.name)) = 'prima' AND m.grams_per_piece = 14
     AND (EXISTS (SELECT 1 FROM preform_shift_records r WHERE r.id = pm.shift_record_id AND r.test_cleared)
          OR EXISTS (SELECT 1 FROM preform_issues i WHERE i.id = pm.issue_id AND i.test_cleared));

  IF v_ids IS NULL THEN
    RAISE NOTICE 'No Prima 14g test ledger lines to delete';
    RETURN;
  END IF;
  IF v_net <> 0 THEN
    RAISE EXCEPTION 'Prima 14g test ledger lines do not net to zero (%), nothing deleted', v_net;
  END IF;

  DELETE FROM preform_movements WHERE id = ANY (v_ids);
  PERFORM public._pf_audit(v_factory, 'delete_test_ledger_lines', 'preform_movements', NULL,
    jsonb_build_object('material', 'Prima 14g', 'lines', v_rows),
    jsonb_build_object('reason', 'Test data: 72 damaged bottles showed in Prima 14g records (user, 2026-10-27)'));
END $$;

DO $$
DECLARE
  v_why text := 'Reversed to re-record with the right figures after clearing the 72 test damaged bottles (user, 2026-10-27)';
  v_r preform_shift_records%ROWTYPE;
  s record;
BEGIN
  SELECT * INTO v_r FROM preform_shift_records WHERE reference = 'PSR-20261027-00017' FOR UPDATE;
  IF NOT FOUND OR v_r.status = 'reversed' THEN
    RAISE NOTICE 'PSR-20261027-00017 not found or already reversed';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM preform_shift_records l
              WHERE l.operator_id = v_r.operator_id AND l.material_id = v_r.material_id AND l.id <> v_r.id
                AND l.status IN ('awaiting_inspection', 'awaiting_stocking', 'completed')
                AND l.submitted_at > v_r.submitted_at) THEN
    RAISE EXCEPTION 'A later Prima 14g blowing was submitted after PSR-20261027-00017; reverse it from the app instead';
  END IF;

  FOR s IN SELECT * FROM preform_stockings WHERE shift_record_id = v_r.id AND status IN ('sent', 'accepted') LOOP
    IF s.status = 'accepted' AND COALESCE(s.accepted_qty, 0) > 0 THEN
      IF (SELECT current_stock FROM products WHERE id = s.product_id) < s.accepted_qty THEN
        RAISE EXCEPTION 'Only part of % is still in bottle stock (some went to PM); nothing reversed', s.reference;
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
END $$;
