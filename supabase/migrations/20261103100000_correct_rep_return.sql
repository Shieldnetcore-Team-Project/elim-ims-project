-- ============================================================================
-- The Warehouse corrects a marketer's / the shop's return
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "warehouse should be able to correct returns". A
-- direct return (create_rep_return / return_shop_stock_to_warehouse) is
-- completed at once, and cancel_rep_return only takes one still waiting for
-- inspection, so a wrong figure or product could not be fixed.
--
-- correct_rep_return(p_id, payload) replaces the return in one step, the way
-- correct_stock_dispatch replaces a posting:
--   * the old return is marked 'cancelled' (with the reason): its goods go
--     back onto the marketer's / shop's stock and out of the Warehouse, and
--     its jugs back to them -- stamped on the old return's own day, so that
--     day nets to what is really there;
--   * a new return with the corrected lines (payload.items, same day unless
--     payload.return_date) goes through create_rep_return as usual.
--   No lines = the return is removed (entered by mistake).
-- Only the net change has to be possible: the Warehouse must still have what
-- the correction takes back, the marketer / shop what it adds. A return
-- already added to a posting is corrected through that posting; a shop day
-- closed with Accounts can't change. Same right as recording a return
-- (distribution:submit); a reason is required; audit-logged.
-- payload: { items: [{product_id, quantity_returned}], return_date?, reason }
-- ============================================================================

CREATE OR REPLACE FUNCTION public.correct_rep_return(p_id uuid, payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_r rep_returns%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_date date;
  v_old_at timestamptz;
  v_items jsonb := COALESCE(payload->'items', '[]'::jsonb);
  v_new jsonb;
  v_line record;
  v_before numeric;
  v_short text;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why the return is being corrected'; END IF;
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'items must be a list'; END IF;
  SELECT * INTO v_r FROM rep_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_r.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_r.status <> 'completed' THEN RAISE EXCEPTION 'Only a completed return can be corrected (this one is %)', v_r.status; END IF;
  IF v_r.carried_dispatch_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM stock_dispatches d WHERE d.id = v_r.carried_dispatch_id AND d.status <> 'reversed') THEN
    RAISE EXCEPTION 'This return was already added to posting % -- correct that posting instead',
      (SELECT dispatch_number FROM stock_dispatches WHERE id = v_r.carried_dispatch_id);
  END IF;
  v_date := COALESCE(NULLIF(payload->>'return_date', '')::date, v_r.return_date);
  PERFORM public._check_return_day(v_r.return_date, v_r.sales_rep_id);
  PERFORM public._check_return_day(v_date, v_r.sales_rep_id);
  v_old_at := public._return_at(v_r.return_date);

  -- The net change per product must be possible before anything moves.
  WITH old AS (
    SELECT product_id, SUM(quantity_returned) AS q FROM rep_return_items WHERE rep_return_id = p_id GROUP BY 1
  ), nw AS (
    SELECT (i->>'product_id')::uuid AS product_id, SUM(COALESCE(NULLIF(i->>'quantity_returned', '')::numeric, 0)) AS q
      FROM jsonb_array_elements(v_items) i GROUP BY 1
  ), d AS (
    SELECT COALESCE(o.product_id, n.product_id) AS product_id, COALESCE(n.q, 0) - COALESCE(o.q, 0) AS delta
      FROM old o FULL JOIN nw n ON n.product_id = o.product_id
  )
  SELECT string_agg(p.name, ', ') INTO v_short
    FROM d JOIN products p ON p.id = d.product_id
    LEFT JOIN rep_stock rs ON rs.sales_rep_id = v_r.sales_rep_id AND rs.product_id = d.product_id
   WHERE (d.delta < 0 AND p.current_stock < -d.delta)          -- Warehouse gives back more than it has
      OR (d.delta > 0 AND COALESCE(rs.quantity, 0) < d.delta); -- they return more than they hold
  IF v_short IS NOT NULL THEN
    RAISE EXCEPTION 'The correction isn''t possible for: % (not enough stock left to move back)', v_short;
  END IF;

  -- 1. Their side back first: the old return's goods onto their stock.
  FOR v_line IN SELECT * FROM rep_return_items WHERE rep_return_id = p_id LOOP
    SELECT quantity INTO v_before FROM rep_stock
     WHERE sales_rep_id = v_r.sales_rep_id AND product_id = v_line.product_id FOR UPDATE;
    IF NOT FOUND THEN
      v_before := 0;
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
      VALUES (v_r.sales_rep_id, v_line.product_id, v_r.factory_id, v_line.quantity_returned);
    ELSE
      UPDATE rep_stock SET quantity = quantity + v_line.quantity_returned, updated_at = now()
       WHERE sales_rep_id = v_r.sales_rep_id AND product_id = v_line.product_id;
    END IF;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                    user_id, quantity_before, quantity_after, created_at)
    VALUES (v_r.factory_id, v_r.sales_rep_id, v_line.product_id, 'adjustment', v_line.quantity_returned,
            v_r.return_number, 'Return corrected: ' || v_reason, v_uid, v_before, v_before + v_line.quantity_returned,
            v_old_at);
  END LOOP;

  -- 2. The corrected return, as any return (checks, stamps, jugs).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) i
              WHERE COALESCE(NULLIF(i->>'quantity_returned', '')::numeric, 0) > 0) THEN
    v_new := public.create_rep_return(jsonb_build_object(
      'factory_id', v_r.factory_id, 'sales_rep_id', v_r.sales_rep_id, 'return_date', v_date,
      'notes', COALESCE(v_r.notes || ' -- ', '') || 'Corrects ' || v_r.return_number || ': ' || v_reason,
      'items', (SELECT jsonb_agg(i) FROM jsonb_array_elements(v_items) i
                 WHERE COALESCE(NULLIF(i->>'quantity_returned', '')::numeric, 0) > 0)));
  END IF;

  -- 3. The old return's goods out of the Warehouse again.
  FOR v_line IN SELECT * FROM rep_return_items WHERE rep_return_id = p_id LOOP
    SELECT current_stock INTO v_before FROM products WHERE id = v_line.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock - v_line.quantity_returned, updated_at = now()
     WHERE id = v_line.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                    quantity_before, quantity_after, created_at)
    VALUES (v_r.factory_id, v_line.product_id, 'correction', -v_line.quantity_returned, v_r.return_number,
            'Return corrected: ' || v_reason, v_uid, v_before, v_before - v_line.quantity_returned, v_old_at);
  END LOOP;

  -- 4. Close the old return; its jugs go back to them (the status trigger),
  --    on its own day.
  UPDATE rep_returns
     SET status = 'cancelled',
         notes = COALESCE(notes || ' -- ', '') || 'Corrected'
                 || COALESCE(' by ' || (v_new->>'return_number'), ' (removed)') || ': ' || v_reason
   WHERE id = p_id;
  PERFORM set_config('elim.redating', 'on', true);
  UPDATE container_movements SET created_at = v_old_at
   WHERE rep_return_id = p_id AND source = 'rep_return_cancelled';
  PERFORM set_config('elim.redating', 'off', true);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_r.factory_id, 'correct_rep_return', 'rep_returns', p_id::text,
          jsonb_build_object('return_number', v_r.return_number, 'return_date', v_r.return_date,
                             'items', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id,
                                               'quantity_returned', quantity_returned))
                                         FROM rep_return_items WHERE rep_return_id = p_id)),
          jsonb_build_object('replaced_by', v_new->>'return_number', 'return_date', v_date,
                             'items', v_items, 'reason', v_reason));
  RETURN jsonb_build_object('cancelled', v_r.return_number, 'return_number', v_new->>'return_number',
                            'id', v_new->>'id', 'return_date', v_date);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_rep_return(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_rep_return(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
