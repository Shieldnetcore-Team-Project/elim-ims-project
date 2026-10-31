-- ============================================================================
-- Posting to a marketer carries all of their open returns at once
-- ----------------------------------------------------------------------------
-- User request (2026-10-31): on Warehouse → Post to Marketer, as soon as a
-- marketer is picked, any return of theirs not yet carried over shows, and
-- its products are added to the posting automatically -- they are still on
-- the van (20261017130000), so they go back on the marketer's supplies.
--
-- create_stock_dispatch now also takes payload.carry_return_ids (a list):
-- every one is checked like carry_return_id (the marketer's own, completed,
-- not already on a live dispatch) and linked to the new dispatch, so none is
-- carried twice. carry_return_id still works (Returns → Add products).
-- Body otherwise identical to 20261017130000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_stock_dispatch(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_rep uuid := (payload->>'sales_rep_id')::uuid;
  v_date date := COALESCE((payload->>'dispatch_date')::date, CURRENT_DATE);
  v_vehicle uuid := NULLIF(payload->>'vehicle_id','')::uuid;
  v_driver uuid := NULLIF(payload->>'driver_id','')::uuid;
  v_route uuid := NULLIF(payload->>'route_id','')::uuid;
  v_notes text := payload->>'notes';
  v_carry uuid := NULLIF(payload->>'carry_return_id','')::uuid;
  -- Every return carried: carry_return_id and/or carry_return_ids.
  v_carries uuid[] := ARRAY(
    SELECT DISTINCT x::uuid FROM (
      SELECT NULLIF(payload->>'carry_return_id','') AS x
      UNION ALL
      SELECT NULLIF(e, '') FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(payload->'carry_return_ids') = 'array' THEN payload->'carry_return_ids' ELSE '[]'::jsonb END) e
    ) s WHERE x IS NOT NULL);
  v_carry_id uuid;
  v_carry_row public.rep_returns%ROWTYPE;
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_rep_row public.sales_reps%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
  v_line numeric;
  v_total numeric := 0;
  v_number text;
  v_id uuid;
  v_rep_before numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'No items to dispatch'; END IF;

  SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_rep;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
  IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;
  IF v_rep_row.status <> 'active' THEN RAISE EXCEPTION 'Sales rep is not active'; END IF;

  FOREACH v_carry_id IN ARRAY v_carries LOOP
    SELECT * INTO v_carry_row FROM rep_returns WHERE id = v_carry_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
    IF v_carry_row.sales_rep_id <> v_rep THEN RAISE EXCEPTION 'That return belongs to another marketer'; END IF;
    IF v_carry_row.status <> 'completed' THEN RAISE EXCEPTION 'Only a completed return can be carried over'; END IF;
    -- A reversed carry-over dispatch frees the return to be carried again.
    IF EXISTS (SELECT 1 FROM stock_dispatches
                WHERE id = v_carry_row.carried_dispatch_id AND status <> 'reversed') THEN
      RAISE EXCEPTION 'Return % has already been added to a dispatch', v_carry_row.return_number;
    END IF;
  END LOOP;

  -- validate every line first (all-or-nothing)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_product.current_stock < v_qty THEN
      RAISE EXCEPTION 'Insufficient store stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
    END IF;
    v_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, v_product.unit_price);
    v_total := v_total + (v_qty * v_price);
  END LOOP;

  v_number := 'DSP-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO stock_dispatches(factory_id, dispatch_number, dispatch_date, sales_rep_id, vehicle_id, driver_id, route_id, total_value, notes, created_by)
  VALUES (v_factory, v_number, v_date, v_rep, v_vehicle, v_driver, v_route, v_total, v_notes, v_uid)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, v_product.unit_price);
    v_line := v_qty * v_price;

    INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value)
    VALUES (v_id, v_product.id, v_qty, v_price, v_line);

    -- store side
    UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product.id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_product.id, 'dispatched_to_rep', v_qty, v_number,
            'Dispatched to ' || v_rep_row.full_name, v_uid, v_product.current_stock, v_product.current_stock - v_qty);

    -- rep side
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_rep AND product_id = v_product.id FOR UPDATE;
    IF NOT FOUND THEN
      v_rep_before := 0;
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity) VALUES (v_rep, v_product.id, v_factory, v_qty);
    ELSE
      UPDATE rep_stock SET quantity = quantity + v_qty, updated_at = now()
       WHERE sales_rep_id = v_rep AND product_id = v_product.id;
    END IF;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_rep, v_product.id, 'dispatch_in', v_qty, v_number, 'Stock dispatch', v_uid, v_rep_before, v_rep_before + v_qty);
  END LOOP;

  IF cardinality(v_carries) > 0 THEN
    UPDATE rep_returns SET carried_dispatch_id = v_id WHERE id = ANY (v_carries);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create_stock_dispatch', 'stock_dispatch', v_id::text,
          jsonb_build_object('dispatch_number', v_number, 'sales_rep_id', v_rep, 'total_value', v_total,
                             'carry_return_id', v_carry, 'carry_return_ids', to_jsonb(v_carries)));

  RETURN jsonb_build_object('id', v_id, 'dispatch_number', v_number, 'total_value', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_stock_dispatch(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
