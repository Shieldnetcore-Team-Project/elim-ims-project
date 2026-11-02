-- ============================================================================
-- The Retail Shop returns unsold products to the Warehouse
-- ----------------------------------------------------------------------------
-- User (2026-11-02): at the end of business the shop sends back what it did
-- not sell, and when the Warehouse posts to the shop the next day it sees
-- what came back -- just as for a marketer.
--
-- return_shop_stock_to_warehouse(payload)
--   outlet_id, items [{product_id, quantity}], return_date, notes
-- The same as a marketer's return (create_rep_return), done by the shop's
-- staff (sales create / write) as well as the Warehouse (distribution
-- submit): off the shop's stock ('returned_out', counted under Returned on
-- the day close), straight into Warehouse stock ('return_from_rep'), the
-- return completed with every unit accepted (the jugs move shop ->
-- Warehouse on its status trigger). The shop's day must still be open.
--
-- The Warehouse's posting form now lists the shop's open returns too and
-- adds them to the next posting (create_stock_dispatch.carry_return_ids
-- already takes any holder's own completed return) -- the goods go back on
-- the shop's stock with that posting, so nothing is counted twice.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.return_shop_stock_to_warehouse(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_outlet uuid := NULLIF(payload->>'outlet_id', '')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, CURRENT_DATE);
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_rep sales_reps%ROWTYPE;
  v_item jsonb;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_rep_before numeric;
  v_store_before numeric;
  v_number text;
  v_id uuid;
  v_total numeric := 0;
  v_units numeric := 0;
BEGIN
  IF NOT (public.has_permission(v_uid, 'sales'::module_key, 'create'::action_key)
       OR public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'distribution'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = v_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail outlet not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'A return can''t be dated in the future'; END IF;
  IF EXISTS (SELECT 1 FROM outlet_day_reconciliations
              WHERE sales_rep_id = v_rep.id AND close_date = v_date AND status IN ('submitted', 'confirmed')) THEN
    RAISE EXCEPTION 'The shop''s day % is already closed -- date the return another day, or ask Accounts to query the day back.',
      to_char(v_date, 'DD Mon YYYY');
  END IF;
  IF jsonb_typeof(payload->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Enter what goes back'; END IF;

  -- Check every line first: at most what the shop holds.
  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0);
    CONTINUE WHEN v_qty = 0;
    IF v_qty < 0 THEN RAISE EXCEPTION 'Quantities cannot be negative'; END IF;
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid AND factory_id = v_rep.factory_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_rep.id AND product_id = v_product.id FOR UPDATE;
    IF COALESCE(v_rep_before, 0) < v_qty THEN
      RAISE EXCEPTION 'The shop has only % % of %', COALESCE(v_rep_before, 0), v_product.unit, v_product.name;
    END IF;
    v_units := v_units + v_qty;
  END LOOP;
  IF v_units = 0 THEN RAISE EXCEPTION 'Enter how many of each product goes back'; END IF;

  v_number := 'RRN-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  INSERT INTO rep_returns(factory_id, return_number, sales_rep_id, return_date, received_by, notes)
  VALUES (v_rep.factory_id, v_number, v_rep.id, v_date, v_uid,
          COALESCE(v_notes, 'Unsold at the end of business'))
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0);
    CONTINUE WHEN v_qty = 0;
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_total := v_total + v_qty * v_product.unit_price;
    INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price,
                                 accepted_quantity, damaged_quantity, rejected_quantity, charge_rep)
    VALUES (v_id, v_product.id, v_qty, v_product.unit_price, v_qty, 0, 0, true);

    -- Off the shop's stock...
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_rep.id AND product_id = v_product.id FOR UPDATE;
    UPDATE rep_stock SET quantity = quantity - v_qty, updated_at = now()
     WHERE sales_rep_id = v_rep.id AND product_id = v_product.id;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                    user_id, quantity_before, quantity_after)
    VALUES (v_rep.factory_id, v_rep.id, v_product.id, 'returned_out', -v_qty, v_number, 'Returned to Warehouse',
            v_uid, v_rep_before, v_rep_before - v_qty);

    -- ...and straight back into the Warehouse.
    SELECT current_stock INTO v_store_before FROM products WHERE id = v_product.id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_product.id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                    quantity_before, quantity_after)
    VALUES (v_rep.factory_id, v_product.id, 'return_from_rep', v_qty, v_number,
            'Returned by ' || v_rep.full_name || ' (unsold)', v_uid, v_store_before, v_store_before + v_qty);
  END LOOP;

  UPDATE rep_returns SET status = 'completed', inspected_by = v_uid, inspected_at = now() WHERE id = v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_rep.factory_id, 'return_shop_stock_to_warehouse', 'rep_return', v_id::text,
          jsonb_build_object('return_number', v_number, 'outlet', v_rep.full_name, 'units', v_units,
                             'value', v_total, 'items', payload->'items'));

  RETURN jsonb_build_object('id', v_id, 'return_number', v_number, 'units', v_units, 'value', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.return_shop_stock_to_warehouse(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_shop_stock_to_warehouse(jsonb) TO authenticated;
