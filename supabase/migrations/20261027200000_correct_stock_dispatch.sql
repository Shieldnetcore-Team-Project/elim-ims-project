-- ============================================================================
-- Correct a posting to a marketer
-- ----------------------------------------------------------------------------
-- The warehouse manager can fix a posting entered with the wrong figure or
-- product: correct_stock_dispatch(p_id, payload) replaces the posting with
-- the corrected lines in one step --
--   * the old posting is marked 'reversed' (reason "Corrected ..."), its
--     goods back in the Warehouse and off the marketer's stock;
--   * a new posting with the corrected lines (same marketer, same date unless
--     another is given) takes them out again.
-- Only the difference has to be possible: the marketer must still hold
-- whatever the correction takes off them (rep_stock never goes below 0), and
-- the Warehouse must have whatever it adds. A return carried into the old
-- posting stays carried into the new one. Needs the same right as posting
-- (distribution:create), so whoever posts can correct.
-- payload: { items: [{product_id, quantity}], dispatch_date?, notes?, reason? }
-- ============================================================================

CREATE OR REPLACE FUNCTION public.correct_stock_dispatch(p_id uuid, payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row stock_dispatches%ROWTYPE;
  v_item record;
  v_before numeric;
  v_reason text := COALESCE(NULLIF(btrim(payload->>'reason'), ''), 'Corrected');
  v_new jsonb;
  v_new_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_row FROM stock_dispatches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Posting not found'; END IF;
  IF v_row.status <> 'posted' THEN RAISE EXCEPTION 'This posting is already %', v_row.status; END IF;
  IF payload->'items' IS NULL OR jsonb_array_length(payload->'items') = 0 THEN
    RAISE EXCEPTION 'Add at least one product line';
  END IF;

  -- 1. The old posting's goods back into the Warehouse first, so the new
  --    posting can take them out again.
  FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = p_id LOOP
    SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now()
     WHERE id = v_item.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_item.product_id, 'return_from_rep', v_item.quantity, v_row.dispatch_number,
            'Posting corrected: ' || v_reason, v_uid, v_before, v_before + v_item.quantity);
  END LOOP;

  -- 2. The corrected posting (Warehouse out, marketer in).
  v_new := public.create_stock_dispatch(jsonb_build_object(
    'factory_id', v_row.factory_id,
    'sales_rep_id', v_row.sales_rep_id,
    'dispatch_date', COALESCE(NULLIF(payload->>'dispatch_date', ''), v_row.dispatch_date::text),
    'vehicle_id', v_row.vehicle_id, 'driver_id', v_row.driver_id, 'route_id', v_row.route_id,
    'notes', COALESCE(NULLIF(payload->>'notes', ''), v_row.notes),
    'items', payload->'items'));
  v_new_id := (v_new->>'id')::uuid;

  -- 3. The old posting off the marketer. Refused (rep_stock can't go below
  --    0) when the correction takes off more than they still hold.
  FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = p_id LOOP
    SELECT quantity INTO v_before FROM rep_stock
     WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
    IF COALESCE(v_before, 0) < v_item.quantity THEN
      RAISE EXCEPTION 'Cannot correct: the marketer has already sold or returned some of %, so it can''t be reduced that far',
        (SELECT name FROM products WHERE id = v_item.product_id);
    END IF;
    UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
     WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.sales_rep_id, v_item.product_id, 'reversal', -v_item.quantity, v_row.dispatch_number,
            'Posting corrected: ' || v_reason, v_uid, v_before, v_before - v_item.quantity);
  END LOOP;

  UPDATE stock_dispatches
     SET status = 'reversed', reversed_by = v_uid, reversed_at = now(),
         reverse_reason = format('Corrected by %s: %s', v_new->>'dispatch_number', v_reason)
   WHERE id = p_id;
  UPDATE rep_returns SET carried_dispatch_id = v_new_id WHERE carried_dispatch_id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'correct_stock_dispatch', 'stock_dispatch', p_id::text,
          jsonb_build_object('dispatch_number', v_row.dispatch_number, 'total_value', v_row.total_value),
          jsonb_build_object('dispatch_number', v_new->>'dispatch_number', 'total_value', v_new->'total_value',
                             'reason', v_reason));

  RETURN jsonb_build_object('id', v_new_id, 'dispatch_number', v_new->>'dispatch_number',
                            'replaced', v_row.dispatch_number);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_stock_dispatch(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_stock_dispatch(uuid, jsonb) TO authenticated;
