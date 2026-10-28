-- ============================================================================
-- Clear Malla's stock records, to start afresh
-- ----------------------------------------------------------------------------
-- The user asked (2026-10-28) for Malla's records (marketer Malla, Water
-- Factory) to be cleared off the system. Every posting to Malla and every
-- return from Malla is removed, and whatever Malla still holds goes back into
-- the Warehouse:
--   * Warehouse stock gets back what Malla holds now (rep_stock), so the
--     goods are counted once, in the Warehouse;
--   * Malla's postings (stock_dispatches + items) and returns (rep_returns +
--     items) are deleted, with their stock ledger lines (Warehouse and
--     Malla's), their jug moves, and Malla's stock rows -- so nothing of them
--     is left on Malla's account, the Warehouse stock card or the reports;
--   * the marketer Malla stays (so Malla can be posted to again).
-- Refused, changing nothing, while Malla has van sales, remittances or jug
-- returns on record: those are money / customer records, cleared on purpose
-- by Accounts first. An audit row keeps a copy of everything deleted. Safe
-- to run again.
-- ============================================================================

DO $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_count int;
  v_dispatch_ids uuid[];
  v_return_ids uuid[];
  v_refs text[];
  v_held record;
  v_copy jsonb;
  v_back jsonb := '[]'::jsonb;
BEGIN
  SELECT count(*) INTO v_count FROM sales_reps r JOIN factories f ON f.id = r.factory_id
   WHERE f.code = 'water' AND r.kind = 'rep' AND lower(btrim(r.full_name)) = 'malla';
  IF v_count <> 1 THEN
    RAISE NOTICE 'Malla: % marketers match -- nothing changed', v_count;
    RETURN;
  END IF;
  SELECT r.* INTO v_rep FROM sales_reps r JOIN factories f ON f.id = r.factory_id
   WHERE f.code = 'water' AND r.kind = 'rep' AND lower(btrim(r.full_name)) = 'malla';

  IF EXISTS (SELECT 1 FROM sales WHERE (sales_rep_id = v_rep.id OR account_rep_id = v_rep.id) AND deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM rep_remittances WHERE sales_rep_id = v_rep.id)
     OR EXISTS (SELECT 1 FROM jug_returns WHERE sales_rep_id = v_rep.id) THEN
    RAISE EXCEPTION 'Malla has van sales, remittances or jug returns on record -- nothing changed. Clear those first.';
  END IF;

  SELECT array_agg(id) INTO v_dispatch_ids FROM stock_dispatches WHERE sales_rep_id = v_rep.id;
  SELECT array_agg(id) INTO v_return_ids FROM rep_returns WHERE sales_rep_id = v_rep.id;
  IF v_dispatch_ids IS NULL AND v_return_ids IS NULL
     AND NOT EXISTS (SELECT 1 FROM rep_stock WHERE sales_rep_id = v_rep.id AND quantity <> 0) THEN
    RAISE NOTICE 'Malla has no postings or returns -- nothing to clear';
    RETURN;
  END IF;
  SELECT array_agg(n) INTO v_refs FROM (
    SELECT dispatch_number AS n FROM stock_dispatches WHERE id = ANY (COALESCE(v_dispatch_ids, '{}'))
    UNION ALL SELECT return_number FROM rep_returns WHERE id = ANY (COALESCE(v_return_ids, '{}'))) x;

  SELECT jsonb_build_object(
           'postings', (SELECT COALESCE(jsonb_agg(to_jsonb(d) || jsonb_build_object('items',
                          (SELECT jsonb_agg(to_jsonb(i)) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id))), '[]'::jsonb)
                          FROM stock_dispatches d WHERE d.id = ANY (COALESCE(v_dispatch_ids, '{}'))),
           'returns', (SELECT COALESCE(jsonb_agg(to_jsonb(r) || jsonb_build_object('items',
                         (SELECT jsonb_agg(to_jsonb(i)) FROM rep_return_items i WHERE i.rep_return_id = r.id))), '[]'::jsonb)
                         FROM rep_returns r WHERE r.id = ANY (COALESCE(v_return_ids, '{}'))),
           'held', (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity)), '[]'::jsonb)
                      FROM rep_stock WHERE sales_rep_id = v_rep.id))
    INTO v_copy;

  -- What Malla holds goes back into the Warehouse. The Warehouse ledger lines
  -- of these postings / returns are deleted below; together they took out
  -- exactly what Malla holds, so stock and stock card stay in step.
  FOR v_held IN SELECT rs.product_id, rs.quantity, p.name FROM rep_stock rs JOIN products p ON p.id = rs.product_id
                 WHERE rs.sales_rep_id = v_rep.id AND rs.quantity <> 0 LOOP
    UPDATE products SET current_stock = current_stock + v_held.quantity, updated_at = now() WHERE id = v_held.product_id;
    v_back := v_back || jsonb_build_object('product', v_held.name, 'quantity', v_held.quantity);
  END LOOP;

  DELETE FROM inventory_movements WHERE reference = ANY (COALESCE(v_refs, '{}'));
  DELETE FROM rep_stock_movements WHERE sales_rep_id = v_rep.id;
  DELETE FROM container_movements
   WHERE dispatch_id = ANY (COALESCE(v_dispatch_ids, '{}')) OR rep_return_id = ANY (COALESCE(v_return_ids, '{}'));
  DELETE FROM rep_returns WHERE id = ANY (COALESCE(v_return_ids, '{}'));         -- items go with them
  DELETE FROM stock_dispatches WHERE id = ANY (COALESCE(v_dispatch_ids, '{}'));  -- items go with them
  DELETE FROM rep_stock WHERE sales_rep_id = v_rep.id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_rep.factory_id, 'delete', 'sales_reps', v_rep.id::text, v_copy,
          jsonb_build_object('marketer', v_rep.full_name, 'back_to_warehouse', v_back,
                             'reason', 'Malla''s postings and returns cleared to start afresh (2026-10-28)'));
  RAISE NOTICE 'Malla cleared: % postings, % returns; back to the Warehouse: %',
    COALESCE(array_length(v_dispatch_ids, 1), 0), COALESCE(array_length(v_return_ids, 1), 0), v_back;
END $$;
