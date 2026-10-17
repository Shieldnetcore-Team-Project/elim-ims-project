-- ============================================================================
-- Marketer returns go straight back into the Warehouse
-- ----------------------------------------------------------------------------
-- No supervisor inspection for goods a marketer brings back. When the
-- warehouse manager logs the return (Warehouse → Returns, Marketer box, or
-- Distribution → Returns), in one step:
--   * the goods come off the marketer's stock (rep_stock)
--   * they go back into Warehouse stock (products.current_stock)
--   * the return is completed with every unit accepted, so the marketer's
--     account (rep_account_summary: completed returns × unit price) is
--     credited with the goods returned
-- inspect_rep_return / cancel_rep_return stay for any return still in
-- 'received' from before this change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_rep_return(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_rep uuid := (payload->>'sales_rep_id')::uuid;
  v_date date := COALESCE((payload->>'return_date')::date, CURRENT_DATE);
  v_notes text := payload->>'notes';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_rep_row public.sales_reps%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
  v_number text;
  v_id uuid;
  v_rep_before numeric;
  v_store_before numeric;
  v_total numeric := 0;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'No items to return'; END IF;

  SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_rep;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Marketer does not belong to factory'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity_returned')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity returned must be > 0'; END IF;
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_rep AND product_id = v_product.id FOR UPDATE;
    IF COALESCE(v_rep_before,0) < v_qty THEN
      RAISE EXCEPTION '% cannot return more % than they hold (have %, returning %)',
        v_rep_row.full_name, v_product.name, COALESCE(v_rep_before,0), v_qty;
    END IF;
  END LOOP;

  v_number := 'RRN-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO rep_returns(factory_id, return_number, sales_rep_id, return_date, received_by, notes)
  VALUES (v_factory, v_number, v_rep, v_date, v_uid, v_notes)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity_returned')::numeric;
    v_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, v_product.unit_price);
    v_total := v_total + v_qty * v_price;

    -- Every unit accepted: this is what credits the marketer's account.
    INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price,
                                 accepted_quantity, damaged_quantity, rejected_quantity, charge_rep)
    VALUES (v_id, v_product.id, v_qty, v_price, v_qty, 0, 0, true);

    -- Off the marketer's stock...
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_rep AND product_id = v_product.id FOR UPDATE;
    UPDATE rep_stock SET quantity = quantity - v_qty, updated_at = now()
      WHERE sales_rep_id = v_rep AND product_id = v_product.id;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_rep, v_product.id, 'returned_out', -v_qty, v_number, 'Returned to Warehouse', v_uid, v_rep_before, v_rep_before - v_qty);

    -- ...and straight back into the Warehouse.
    SELECT current_stock INTO v_store_before FROM products WHERE id = v_product.id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_product.id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_product.id, 'return_from_rep', v_qty, v_number,
            'Returned by ' || v_rep_row.full_name, v_uid, v_store_before, v_store_before + v_qty);
  END LOOP;

  UPDATE rep_returns SET status = 'completed', inspected_by = v_uid, inspected_at = now() WHERE id = v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create_rep_return', 'rep_return', v_id::text,
          jsonb_build_object('return_number', v_number, 'sales_rep_id', v_rep, 'value', v_total));

  RETURN jsonb_build_object('id', v_id, 'return_number', v_number, 'value', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_rep_return(jsonb) TO authenticated;
