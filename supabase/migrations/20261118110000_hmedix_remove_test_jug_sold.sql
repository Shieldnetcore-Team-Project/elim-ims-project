-- ============================================================================
-- H MEDIX: remove the test "Record sold Jug + Water" of 1 (18 Nov)
-- ----------------------------------------------------------------------------
-- User (2026-11-18): "clear the last jug + water i did to H Medix for 1
-- bottle, it was just a test, clear it from the system".
--
-- record_sold_dispenser_jugs made, for 1 jug:
--   * Empty Jug stock +1 ('adjusted', JUG-SOLD), then the invoice took it -1
--   * a posted invoice (Empty Jug x 1 @ Empty Jug price) with its debt and
--     customer-account SALE entry
--   * jug ledger: Warehouse -> H MEDIX ('sale'), H MEDIX -> outside
--     ('jar_sold'), and possibly H MEDIX -> Warehouse ('count')
-- This script undoes all of it:
--   1. reverses the invoice the way a cancelled posting is (stock back, debt
--      removed, REVERSAL on the account, invoice deleted -- the sale trigger
--      undoes the 'sale' and 'jar_sold' jug entries);
--   2. takes back the Empty Jug booked in (stock -1);
--   3. undoes any 'count' jug entry with a correcting one.
-- Only H MEDIX's latest live "Record sold" of exactly 1, made on 18 Nov.
-- Safe to run again (the second run finds nothing to remove).
-- Paste into the Supabase SQL Editor.
-- ============================================================================

DO $$
DECLARE
  v_uid uuid := auth.uid();
  v_cust customers%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_prod uuid;
  v_qty numeric;
  v_before numeric;
  v_count numeric;
BEGIN
  SELECT s.* INTO v_sale
    FROM audit_logs a
    JOIN sales s ON s.id::text = a.entity_id
    JOIN customers c ON c.id = s.customer_id
   WHERE a.action = 'record_sold_dispenser_jugs'
     AND regexp_replace(lower(c.name), '[^a-z]', '', 'g') = 'hmedix'
     AND s.deleted_at IS NULL AND s.status = 'posted'
   ORDER BY a.created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE NOTICE 'No live "Record sold Jug + Water" for H MEDIX -- nothing to remove';
    RETURN;
  END IF;
  SELECT * INTO v_cust FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
  IF (SELECT count(*) FROM sale_items WHERE sale_id = v_sale.id) <> 1 THEN
    RAISE EXCEPTION '% has more than one line -- nothing changed', v_sale.invoice_number;
  END IF;
  SELECT product_id, quantity INTO v_prod, v_qty FROM sale_items WHERE sale_id = v_sale.id;
  IF v_qty <> 1 THEN
    RAISE EXCEPTION 'H MEDIX''s latest Record sold (%) is % jugs, not 1 -- nothing changed', v_sale.invoice_number, v_qty;
  END IF;
  IF (v_sale.created_at AT TIME ZONE 'Africa/Lagos')::date <> '2026-11-18' THEN
    RAISE EXCEPTION 'H MEDIX''s latest Record sold (%) was not made on 18 Nov -- nothing changed', v_sale.invoice_number;
  END IF;
  IF EXISTS (SELECT 1 FROM payments_received WHERE sale_id = v_sale.id) THEN
    RAISE EXCEPTION '% already has a payment on it -- nothing changed', v_sale.invoice_number;
  END IF;

  IF v_uid IS NULL THEN
    v_uid := (SELECT ur.user_id FROM user_roles ur WHERE ur.role = 'super_admin'
               AND public._works_in_factory(ur.user_id, v_cust.factory_id) ORDER BY ur.user_id LIMIT 1);
    -- Lets auth.uid() inside the reversal name the same admin.
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_uid)::text, true);
  END IF;

  -- 1. Reverse the invoice (stock +1, debt gone, REVERSAL, deleted).
  PERFORM public._reverse_posted_sale(v_sale.id, 'Test entry removed (Record sold Jug + Water, 18 Nov)');

  -- 2. Take back the Empty Jug that was booked in.
  SELECT current_stock INTO v_before FROM products WHERE id = v_prod FOR UPDATE;
  UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_prod;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after)
  VALUES (v_cust.factory_id, v_prod, 'adjusted', -v_qty, 'JUG-SOLD',
          format('Test entry %s removed -- jug booked in taken back', v_sale.invoice_number), v_uid,
          v_before, v_before - v_qty);

  -- 3. Undo any 'count' jug entry (H MEDIX -> Warehouse) the test wrote.
  INSERT INTO container_movements(factory_id, container_type_id, from_type, to_type, to_id, quantity, source,
                                  reference, sale_id, notes, created_by)
  SELECT m.factory_id, m.container_type_id, 'warehouse', 'customer', v_cust.id, m.quantity, 'count',
         m.reference, m.sale_id, 'Test entry removed', v_uid
    FROM container_movements m
   WHERE m.sale_id = v_sale.id AND m.source = 'count' AND m.from_type = 'customer' AND m.from_id = v_cust.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_cust.factory_id, 'remove_test_jug_sold', 'sales', v_sale.id::text,
          jsonb_build_object('invoice_number', v_sale.invoice_number, 'customer', v_cust.name,
                             'quantity', v_qty, 'grand_total', v_sale.grand_total),
          jsonb_build_object('reason', 'test entry', 'count_entries_undone', v_count));
  RAISE NOTICE 'Removed % (H MEDIX, % Jug + Water, N%)', v_sale.invoice_number, v_qty, v_sale.grand_total;
END $$;

NOTIFY pgrst, 'reload schema';
