-- ============================================================================
-- Remove the refused releases REL-20261031-55440 and REL-20261031-42649
-- ----------------------------------------------------------------------------
-- User (2026-10-31): clear the two "Refused to Production" records from the
-- Warehouse's Recent activity -- 50cl Bottle Water × 556 (REL-20261031-55440)
-- and 75cl Bottle Water × 795 (REL-20261031-42649), this morning's batches
-- that were removed (20261031090000).
--
-- A refused release moves no stock: the Production hall counts only pending
-- and accepted releases and the Warehouse never took it in, so removing it
-- changes no stock anywhere. The release row and its audit lines go, as for
-- REL-20261030-46391 (20261030210000); a copy goes to the audit log.
--
-- Only each release while it is still that refused product and quantity;
-- anything else is left alone with a notice. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_t record;
  v_id uuid;
  v_ok boolean;
  v_audit int;
BEGIN
  FOR v_t IN
    SELECT * FROM (VALUES ('REL-20261031-55440', '^50 ?cl bottle', 556::numeric),
                          ('REL-20261031-42649', '^75 ?cl bottle', 795::numeric))
           AS t(release_number, pattern, qty)
  LOOP
    v_id := (SELECT id FROM production_releases WHERE release_number = v_t.release_number);
    IF v_id IS NULL THEN
      RAISE NOTICE '% is not there -- nothing to remove', v_t.release_number;
      CONTINUE;
    END IF;
    v_ok := (SELECT r.status = 'rejected' AND r.quantity = v_t.qty AND btrim(p.name) ~* v_t.pattern
               FROM production_releases r JOIN products p ON p.id = r.product_id
              WHERE r.id = v_id);
    IF NOT COALESCE(v_ok, false) THEN
      RAISE NOTICE '% is not the refused % × % any more -- NOT removed',
        v_t.release_number, v_t.pattern, v_t.qty;
      CONTINUE;
    END IF;

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    SELECT auth.uid(), r.factory_id, 'delete', 'production_releases', v_t.release_number, to_jsonb(r),
           jsonb_build_object('reason', 'Refused release cleared from the system (user, 31 Oct 2026)')
      FROM production_releases r WHERE r.id = v_id;
    DELETE FROM audit_logs WHERE entity = 'production_releases' AND entity_id = v_id::text;
    GET DIAGNOSTICS v_audit = ROW_COUNT;
    DELETE FROM production_releases WHERE id = v_id;
    RAISE NOTICE '% removed (and % audit line(s))', v_t.release_number, v_audit;
  END LOOP;
END $$;
