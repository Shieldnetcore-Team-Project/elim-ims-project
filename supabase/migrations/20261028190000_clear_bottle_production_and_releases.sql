-- ============================================================================
-- Clear the Bottle Water production batches and releases, to start afresh
-- ----------------------------------------------------------------------------
-- The user asked (2026-10-28) for the Production Hall and "Releases to the
-- Warehouse" records of 35cl, 50cl and 75cl Bottle Water to be cleared, so the
-- Production Manager enters the latest production again and releases it:
--   REL-20261027-05613  35cl   798   accepted 27 Oct (before the closing count)
--   REL-20261027-36644  50cl   851   accepted 27 Oct (before the closing count)
--   REL-20261027-71385  75cl 3,302   accepted 27 Oct (before the closing count)
--   REL-20261028-72307  50cl 1,499   accepted 28 Oct (after the closing count)
--   REL-20261028-48853  75cl 2,790   accepted 28 Oct (after the closing count)
--
-- Warehouse stock rules:
--   * releases accepted before the 27 Oct closing count (27 Oct 23:59 Lagos,
--     20261028090000): the count already set the stock, so stock is left as
--     it is;
--   * releases accepted after it: their quantity comes back out of Warehouse
--     stock (a 'correction' ledger line under the release number), so when
--     the batch is entered and released again it is counted once, not twice.
--     Refused, changing nothing, if the Warehouse no longer holds that much
--     (it was posted out since).
-- Then every release and every production batch of those three products is
-- deleted (a linked production request loses the link; their approval trail
-- goes with them). Ledger lines already in the Warehouse stock card stay.
-- An audit row keeps a copy of everything deleted. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_close constant timestamptz := '2026-10-27 23:59:59+01';
  v_products uuid[];
  v_r record;
  v_moved numeric;
  v_before numeric;
  v_copy jsonb;
  v_taken jsonb := '[]'::jsonb;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;
  SELECT array_agg(id) INTO v_products FROM products
   WHERE factory_id = v_factory AND product_type = 'finished'
     AND lower(btrim(name)) IN ('35cl bottle water', '50cl bottle water', '75cl bottle water');
  IF v_products IS NULL THEN
    RAISE NOTICE 'Bottle Water products not found -- nothing changed';
    RETURN;
  END IF;

  -- 1. Releases accepted after the closing count: back out of Warehouse stock.
  FOR v_r IN
    SELECT r.id, r.release_number, r.product_id, p.name
      FROM production_releases r JOIN products p ON p.id = r.product_id
     WHERE r.product_id = ANY (v_products) AND r.status = 'accepted' AND r.accepted_at > v_close
  LOOP
    SELECT COALESCE(SUM(quantity_after - quantity_before), 0) INTO v_moved
      FROM inventory_movements
     WHERE product_id = v_r.product_id AND reference = v_r.release_number;
    IF v_moved = 0 THEN CONTINUE; END IF;  -- already taken back
    SELECT current_stock INTO v_before FROM products WHERE id = v_r.product_id FOR UPDATE;
    IF v_before < v_moved THEN
      RAISE EXCEPTION '% (%): the Warehouse holds only % of the % it received -- some was posted out since. Nothing changed.',
        v_r.release_number, v_r.name, v_before, v_moved;
    END IF;
    UPDATE products SET current_stock = current_stock - v_moved, updated_at = now() WHERE id = v_r.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_r.product_id, 'correction', -v_moved, v_r.release_number,
            'Release cleared to be entered and released again', auth.uid(), v_before, v_before - v_moved);
    v_taken := v_taken || jsonb_build_object('release', v_r.release_number, 'product', v_r.name, 'quantity', v_moved);
  END LOOP;

  -- 2. Copy, then delete every release and batch of these products.
  SELECT jsonb_build_object(
           'releases', (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM production_releases r
                         WHERE r.product_id = ANY (v_products)),
           'batches', (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM production p
                        WHERE p.product_id = ANY (v_products)))
    INTO v_copy;
  IF jsonb_array_length(v_copy->'releases') = 0 AND jsonb_array_length(v_copy->'batches') = 0 THEN
    RAISE NOTICE 'Bottle Water production and releases already cleared';
    RETURN;
  END IF;

  DELETE FROM production_releases WHERE product_id = ANY (v_products);
  UPDATE production_requests SET production_id = NULL
   WHERE production_id IN (SELECT id FROM production WHERE product_id = ANY (v_products));
  DELETE FROM workflow_approval_history
   WHERE module = 'production' AND entity_id IN (SELECT id FROM production WHERE product_id = ANY (v_products));
  DELETE FROM production WHERE product_id = ANY (v_products);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'delete', 'production', 'bottle-water-hall-2026-10-28', v_copy,
          jsonb_build_object('taken_back_from_warehouse', v_taken,
                             'reason', 'Bottle Water production and releases cleared to start afresh (2026-10-28)'));
  RAISE NOTICE 'Cleared % releases and % batches; taken back from the Warehouse: %',
    jsonb_array_length(v_copy->'releases'), jsonb_array_length(v_copy->'batches'), v_taken;
END $$;
