-- ============================================================================
-- Delete the two cancelled bottle batches
-- ----------------------------------------------------------------------------
-- PRD20261027-57765 (75cl Bottle, 1,683) and PRD20261027-48684 (50cl Bottle,
-- 497) were cancelled by 20261027170000 so the production manager can enter
-- them again. The user asked for them to be taken off the system entirely
-- (2026-10-27), so they no longer show in Production Runs.
--
-- Deleted only while cancelled; their workflow history goes with them and a
-- linked production request loses the link. An audit row keeps a copy of
-- each deleted batch. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_row production%ROWTYPE;
BEGIN
  FOR v_row IN
    SELECT * FROM production
     WHERE production_number IN ('PRD20261027-57765', 'PRD20261027-48684')
     FOR UPDATE
  LOOP
    IF v_row.status <> 'cancelled' THEN
      RAISE NOTICE 'Kept %: it is % -- only a cancelled batch is deleted', v_row.production_number, v_row.status;
      CONTINUE;
    END IF;

    UPDATE production_requests SET production_id = NULL WHERE production_id = v_row.id;
    DELETE FROM workflow_approval_history WHERE module = 'production' AND entity_id = v_row.id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (auth.uid(), v_row.factory_id, 'delete', 'production', v_row.id::text, to_jsonb(v_row),
            jsonb_build_object('reason', 'Cancelled batch entered in pieces; deleted so it is entered again (2026-10-27)'));
    DELETE FROM production WHERE id = v_row.id;
    RAISE NOTICE 'Deleted %', v_row.production_number;
  END LOOP;
END $$;
