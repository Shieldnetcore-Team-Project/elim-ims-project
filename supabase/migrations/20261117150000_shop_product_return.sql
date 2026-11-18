-- ============================================================================
-- Retail Shop: Return Product (customer brings a product back)
-- ----------------------------------------------------------------------------
-- User (2026-11-17): the Retail Outlet's "Return unsold to Warehouse" button
-- becomes "Return Product": a customer who no longer wants what the shop sold
-- them -- or wants another product instead (e.g. 35cl for 50cl) -- hands it
-- back; the shop picks the product from a dropdown of every product, it goes
-- back into the shop's stock, and the shop sells the customer the other
-- product with a normal New outlet sale.
--
-- record_shop_product_return(payload)
--   outlet_id      the Retail Shop (sales_reps.kind = 'outlet')
--   return_date    defaults to today; never in the future, never a closed day
--   refund_method  how the returned product's value went back to the
--                  customer (cash, transfer, pos...) -- default cash
--   reason         optional
--   items          [{product_id, quantity, value?}] -- value defaults to
--                  quantity x the product's selling price
-- Stock: the shop's rep_stock goes up, ledger line 'reversal'
-- ("Customer return ..."), as record_retail_return. Money: one sales_returns
-- row per product (no sale), refund_amount = value, so the shop's cash-up
-- (_outlet_day_figures) takes it off the money expected that day. With the
-- replacement sold at full price, the shop's money balances: the customer
-- pays only the difference.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_shop_product_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, public._lagos_today());
  v_method payment_method := COALESCE(NULLIF(payload->>'refund_method', '')::payment_method, 'cash');
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_rep sales_reps%ROWTYPE;
  v_item jsonb;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_value numeric;
  v_total numeric := 0;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_count int;
  v_n int := 0;
  v_number text;
  v_ref text;
  v_before numeric;
  v_at timestamptz;
BEGIN
  IF NOT (public.has_permission(v_uid, 'sales'::module_key, 'create'::action_key)
       OR public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'sales-returns'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_method = 'credit' THEN RAISE EXCEPTION 'Choose how the money went back: cash, transfer or POS'; END IF;

  SELECT * INTO v_rep FROM sales_reps WHERE id = NULLIF(payload->>'outlet_id', '')::uuid;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Choose the Retail Shop'; END IF;
  IF NOT public._works_in_factory(v_uid, v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  PERFORM public._check_return_day(v_date, v_rep.id);

  IF jsonb_typeof(payload->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Choose the product that came back'; END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0);
    CONTINUE WHEN v_qty = 0;
    IF v_qty < 0 THEN RAISE EXCEPTION 'Quantities cannot be negative'; END IF;
    SELECT * INTO v_product FROM products WHERE id = NULLIF(v_item->>'product_id', '')::uuid;
    IF NOT FOUND OR v_product.factory_id <> v_rep.factory_id THEN RAISE EXCEPTION 'Product not found'; END IF;
    v_value := COALESCE(NULLIF(v_item->>'value', '')::numeric, round(v_qty * COALESCE(v_product.unit_price, 0), 2));
    IF v_value < 0 THEN RAISE EXCEPTION 'The value given back cannot be negative'; END IF;
    v_lines := v_lines || jsonb_build_object('product_id', v_product.id, 'name', v_product.name,
      'unit', v_product.unit, 'quantity', v_qty, 'value', v_value);
    v_total := v_total + v_value;
  END LOOP;
  v_count := jsonb_array_length(v_lines);
  IF v_count = 0 THEN RAISE EXCEPTION 'Enter how many came back'; END IF;

  v_number := 'SR-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  -- A back-dated return sits on its own day (as the shop's other returns).
  v_at := CASE WHEN v_date < public._lagos_today() THEN public._return_at(v_date) ELSE now() END;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_n := v_n + 1;
    v_qty := (v_line->>'quantity')::numeric;
    v_ref := v_number || CASE WHEN v_count > 1 THEN '-' || v_n ELSE '' END;

    SELECT quantity INTO v_before FROM rep_stock
     WHERE sales_rep_id = v_rep.id AND product_id = (v_line->>'product_id')::uuid FOR UPDATE;
    IF FOUND THEN
      UPDATE rep_stock SET quantity = quantity + v_qty, updated_at = now()
       WHERE sales_rep_id = v_rep.id AND product_id = (v_line->>'product_id')::uuid;
    ELSE
      v_before := 0;
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
      VALUES (v_rep.id, (v_line->>'product_id')::uuid, v_rep.factory_id, v_qty);
    END IF;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                    user_id, quantity_before, quantity_after, created_at)
    VALUES (v_rep.factory_id, v_rep.id, (v_line->>'product_id')::uuid, 'reversal', v_qty, v_ref,
            'Customer return' || COALESCE(' -- ' || v_reason, ''), v_uid, v_before, v_before + v_qty, v_at);

    INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned, unit,
                              reason, status, accepted_quantity, received_by, inspected_by, inspected_at, return_date,
                              sales_rep_id, value, debt_reduced, credit_added, refund_amount, refund_method, notes)
    VALUES (v_rep.factory_id, v_ref, NULL, NULL, (v_line->>'product_id')::uuid, v_qty, v_line->>'unit',
            v_reason, 'completed', v_qty, v_uid, v_uid, v_at, v_date, v_rep.id, (v_line->>'value')::numeric,
            0, 0, (v_line->>'value')::numeric,
            CASE WHEN (v_line->>'value')::numeric > 0 THEN v_method END,
            'Back into ' || v_rep.full_name || ' stock');
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_rep.factory_id, 'record_shop_product_return', 'sales_reps', v_rep.id::text, NULL,
          jsonb_build_object('return_number', v_number, 'return_date', v_date, 'items', v_lines,
                             'refund', v_total, 'refund_method', v_method, 'reason', v_reason));

  RETURN jsonb_build_object('return_number', v_number, 'refund', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.record_shop_product_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_shop_product_return(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
