-- ============================================================================
-- Clear the Production Hall, to start entering production afresh
-- ----------------------------------------------------------------------------
-- The user asked (2026-10-29) for production stock to be cleared so the
-- Production Manager starts entering it afresh; they chose "batches in the
-- hall", with Warehouse stock not touched.
--
-- Hall stock per product = good quantity of batches in the hall
-- (production.status 'pending_confirmation') - releases pending or accepted
-- (20261014190000). Deleting the batches alone would leave every product that
-- was ever released below zero, so the hall is cleared whole, for every
-- product, as 20261028190000 did for Bottle Water:
--   * every batch in the hall is deleted (a linked production request loses
--     the link; its approval trail goes with it);
--   * every release record is deleted. Warehouse stock is NOT changed: what
--     the Warehouse accepted stays in its stock and its stock-card lines
--     (reference REL-...) stay. A release still awaiting the Warehouse is
--     withdrawn with it -- it never reached Warehouse stock.
-- Batches the Warehouse accepted whole before releases existed (confirmed /
-- posted) are not hall stock and are left alone. Afterwards every product's
-- hall stock is 0. An audit row keeps a copy of everything deleted. Safe to
-- run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_batches uuid[];
  v_copy jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  SELECT array_agg(id) INTO v_batches FROM production
   WHERE factory_id = v_factory AND status = 'pending_confirmation';
  SELECT jsonb_build_object(
           'releases', (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM production_releases r
                         WHERE r.factory_id = v_factory),
           'batches', (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM production p
                        WHERE p.id = ANY (COALESCE(v_batches, '{}'))))
    INTO v_copy;
  IF jsonb_array_length(v_copy->'releases') = 0 AND jsonb_array_length(v_copy->'batches') = 0 THEN
    RAISE NOTICE 'The production hall is already clear';
    RETURN;
  END IF;

  DELETE FROM production_releases WHERE factory_id = v_factory;
  IF v_batches IS NOT NULL THEN
    UPDATE production_requests SET production_id = NULL WHERE production_id = ANY (v_batches);
    DELETE FROM workflow_approval_history WHERE module = 'production' AND entity_id = ANY (v_batches);
    DELETE FROM production WHERE id = ANY (v_batches);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'delete', 'production', 'production-hall-2026-10-29', v_copy,
          jsonb_build_object('reason', 'Production hall cleared to start entering production afresh (2026-10-29); Warehouse stock not changed'));
  RAISE NOTICE 'Production hall cleared: % batches and % releases deleted; Warehouse stock unchanged',
    jsonb_array_length(v_copy->'batches'), jsonb_array_length(v_copy->'releases');
END $$;
