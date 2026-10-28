-- ============================================================================
-- Clear the Bottle Water batches still in the Production Hall (again)
-- ----------------------------------------------------------------------------
-- After 20261028190000 the batches were entered again -- 50cl 1,499 and 75cl
-- 2,790, in the hall, nothing released -- and the user asked for them to be
-- cleared too so posting starts afresh (2026-10-28).
--
-- Every Bottle Water batch still in the hall (pending_confirmation) is
-- deleted -- a linked production request loses the link, the approval trail
-- goes with it. Nothing reached the Warehouse, so Warehouse stock is not
-- touched. A product with a release still awaiting the Warehouse or accepted
-- is left alone, with a notice (reverse or clear the release first). An
-- audit row keeps a copy of every deleted batch. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_p record;
  v_ids uuid[];
  v_copy jsonb := '[]'::jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  FOR v_p IN SELECT id, name FROM products
              WHERE factory_id = v_factory AND product_type = 'finished' AND name ILIKE '%bottle water'
  LOOP
    SELECT array_agg(id) INTO v_ids FROM production
     WHERE product_id = v_p.id AND status = 'pending_confirmation';
    IF v_ids IS NULL THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM production_releases
                WHERE product_id = v_p.id AND status IN ('pending', 'accepted')) THEN
      RAISE NOTICE '% has releases on record -- left alone; reverse or clear them first', v_p.name;
      CONTINUE;
    END IF;

    v_copy := v_copy || (SELECT jsonb_agg(to_jsonb(pr)) FROM production pr WHERE pr.id = ANY (v_ids));
    UPDATE production_requests SET production_id = NULL WHERE production_id = ANY (v_ids);
    DELETE FROM workflow_approval_history WHERE module = 'production' AND entity_id = ANY (v_ids);
    DELETE FROM production WHERE id = ANY (v_ids);
    RAISE NOTICE '%: % batch(es) cleared from the hall', v_p.name, array_length(v_ids, 1);
  END LOOP;

  IF jsonb_array_length(v_copy) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (auth.uid(), v_factory, 'delete', 'production', 'bottle-water-hall-2026-10-28b', v_copy,
            jsonb_build_object('reason', 'Bottle Water batches in the hall cleared to start posting afresh (2026-10-28)'));
  END IF;
END $$;
