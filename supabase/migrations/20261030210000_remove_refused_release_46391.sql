-- ============================================================================
-- Remove the refused release REL-20261030-46391 as if it never happened
-- ----------------------------------------------------------------------------
-- User (2026-10-30): the Warehouse refused "50cl Bottle Water × 535"
-- (REL-20261030-46391, 30 Oct 12:41) and the record is to go entirely.
--
-- A refused release moves no stock: the Production hall counts only pending
-- and accepted releases (_production_hall_available) and the Warehouse never
-- took it in, so removing it changes no stock anywhere. What it left is the
-- release row and its audit lines (released, refused); notifications are
-- worked out live from the data, so they go with the row. Those are deleted.
--
-- Only that release, and only while it is still the refused 535 packs of
-- 50cl: anything else and nothing is touched. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_id uuid := (SELECT id FROM production_releases WHERE release_number = 'REL-20261030-46391');
  v_ok boolean;
  v_audit int;
BEGIN
  IF v_id IS NULL THEN
    RAISE NOTICE 'REL-20261030-46391 is not there -- nothing to remove';
    RETURN;
  END IF;
  v_ok := (SELECT r.status = 'rejected' AND r.quantity = 535 AND btrim(p.name) ~* '^50 ?cl bottle'
             FROM production_releases r JOIN products p ON p.id = r.product_id
            WHERE r.id = v_id);
  IF NOT COALESCE(v_ok, false) THEN
    RAISE NOTICE 'REL-20261030-46391 is not the refused 50cl × 535 any more -- NOT removed';
    RETURN;
  END IF;

  DELETE FROM audit_logs WHERE entity = 'production_releases' AND entity_id = v_id::text;
  GET DIAGNOSTICS v_audit = ROW_COUNT;
  DELETE FROM production_releases WHERE id = v_id;
  RAISE NOTICE 'REL-20261030-46391 removed (and % audit line(s))', v_audit;
END $$;
