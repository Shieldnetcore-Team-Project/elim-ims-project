-- ============================================================================
-- Edit supply: part of a Dispenser Water line becomes Jug + Water
-- ----------------------------------------------------------------------------
-- User (2026-11-13), H MEDIX got 130 Dispenser Water on 13 Nov and 19 of the
-- customers had no empty jug to swap: "it should indicate that [they] sold
-- 19 Jug + Water". So Edit supply (edit_dispenser_supply, 20261113120000)
-- also moves part of a distributor's Dispenser Water line to Jug + Water:
--   p_lines [{item_id, quantity, to_jug_water}]
--     quantity      the line's new supplied quantity (down only, as before)
--     to_jug_water  how many of those become Jug + Water (the customer keeps
--                   the jug): the line keeps quantity - to_jug_water, and
--                   the invoice's Jug + Water line (or a new one) gets them
--                   at the Jug + Water price (the jug's with-jar price).
-- The supply stays the same; the invoice, its debt and the customer's
-- account go up by the price difference (a DEBIT_ADJUSTMENT, a paid invoice
-- re-opens a debt for it); the jugs are recorded as sold with the water
-- ('jar_sold'), and a return-later line's jugs owed are cleared first.
-- Distributor postings only -- a marketer's Jug + Water is worked out from
-- the jugs not back (rep_dispenser_breakdown), never set on the posting.
-- Everything else as 20261113120000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.edit_dispenser_supply(p_kind text, p_id uuid, p_lines jsonb, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_line jsonb;
  v_new numeric;
  v_d numeric;
  v_price numeric;
  v_value numeric := 0;
  v_count int := 0;
  v_before numeric;
  v_name text;
  v_back numeric;
  v_left numeric;
  v_note text;
  v_old jsonb;
  v_s sales%ROWTYPE;
  v_si sale_items%ROWTYPE;
  v_debt debts%ROWTYPE;
  v_reduce numeric;
  v_credit numeric;
  v_disp stock_dispatches%ROWTYPE;
  v_di stock_dispatch_items%ROWTYPE;
  v_ref text;
  v_factory uuid;
  v_n numeric;            -- of the line, how many become Jug + Water
  v_keep numeric;
  v_up numeric := 0;      -- what the switch to Jug + Water adds
  v_net numeric;
  v_jug record;
  v_jw numeric;
  v_p sale_items%ROWTYPE;
BEGIN
  IF NOT public._is_supply_editor(v_uid) THEN
    RAISE EXCEPTION 'Only a Warehouse Manager (or Admin) can edit a supply';
  END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Give the reason for the change'; END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Nothing to change';
  END IF;
  v_note := 'Supply edited: ' || v_reason;

  IF p_kind = 'sale' THEN
    SELECT * INTO v_s FROM sales WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Posting not found'; END IF;
    IF NOT public._works_in_factory(v_uid, v_s.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    IF v_s.status <> 'posted' OR v_s.sales_rep_id IS NOT NULL THEN
      RAISE EXCEPTION '% isn''t a posted Warehouse posting to a distributor', v_s.invoice_number;
    END IF;
    v_ref := v_s.invoice_number; v_factory := v_s.factory_id;
    v_old := (SELECT jsonb_agg(jsonb_build_object('item_id', id, 'product_id', product_id, 'quantity', quantity,
                                                  'unit_price', unit_price, 'jar_mode', jar_mode, 'line_total', line_total))
                FROM sale_items WHERE sale_id = p_id);
    PERFORM 1 FROM customers WHERE id = v_s.customer_id FOR UPDATE;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      SELECT * INTO v_si FROM sale_items WHERE id = (v_line->>'item_id')::uuid AND sale_id = p_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Line not on %', v_ref; END IF;
      v_new := NULLIF(v_line->>'quantity', '')::numeric;
      v_name := public._sale_line_name((SELECT name FROM products WHERE id = v_si.product_id), v_si.jar_mode);
      IF v_new IS NULL OR v_new < 0 THEN RAISE EXCEPTION 'Enter the new quantity for %', v_name; END IF;
      v_n := COALESCE(NULLIF(v_line->>'to_jug_water', '')::numeric, 0);
      IF v_n < 0 THEN RAISE EXCEPTION 'Jug + Water can''t be negative'; END IF;
      CONTINUE WHEN v_new = v_si.quantity AND v_n = 0;
      IF NOT public._is_supply_dispenser(v_si.product_id) THEN
        RAISE EXCEPTION 'Only dispenser lines can be edited here -- % comes back as a return', v_name;
      END IF;
      IF v_new > v_si.quantity THEN
        RAISE EXCEPTION '% can only go down (supplied %)', v_name, v_si.quantity;
      END IF;
      IF v_n > 0 AND v_si.jar_mode = 'permanent' THEN
        RAISE EXCEPTION '% is already Jug + Water', v_name;
      END IF;
      IF v_n > v_new THEN
        RAISE EXCEPTION 'Only % of % can become Jug + Water', v_new, v_name;
      END IF;
      v_d := v_si.quantity - v_new;
      v_price := v_si.unit_price - COALESCE(v_si.unit_discount, 0) + COALESCE(v_si.unit_surcharge, 0);
      v_count := v_count + 1;

      IF v_d > 0 THEN
        -- Not below what they already returned of this product on this invoice.
        v_back := (SELECT COALESCE(SUM(quantity_returned), 0) FROM sales_returns
                    WHERE sale_id = p_id AND product_id = v_si.product_id AND status <> 'cancelled');
        v_left := (SELECT SUM(quantity) FROM sale_items WHERE sale_id = p_id AND product_id = v_si.product_id) - v_d;
        IF v_left < v_back THEN
          RAISE EXCEPTION '% on % can''t go below % -- % already returned on it', v_name, v_ref, v_back, v_back;
        END IF;
        v_value := v_value + round(v_d * v_price, 2);

        SELECT current_stock INTO v_before FROM products WHERE id = v_si.product_id FOR UPDATE;
        UPDATE products SET current_stock = current_stock + v_d, updated_at = now() WHERE id = v_si.product_id;
        INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                        quantity_before, quantity_after)
        VALUES (v_factory, v_si.product_id, 'returned', v_d, v_ref, v_note, v_uid, v_before, v_before + v_d);

        IF v_si.jar_mode = 'permanent' THEN
          PERFORM public._supply_jugs_back('sale_id', p_id, v_si.product_id, 'jar_sold', 'jar_sold_reversal', v_d, v_note);
        ELSIF v_si.jar_mode IS NULL OR v_si.jar_mode = 'return_later' THEN
          PERFORM public._supply_jugs_back('sale_id', p_id, v_si.product_id, 'sale', 'sale_reversal', v_d, v_note);
        END IF;
      END IF;

      -- Part of the line becomes Jug + Water: the customer keeps the jug.
      IF v_n > 0 THEN
        SELECT * INTO v_jug FROM public._product_jug(v_si.product_id) LIMIT 1;
        IF v_jug.with_jar_price IS NULL THEN
          RAISE EXCEPTION 'Set the Jug + Water price for % first (Settings)', v_name;
        END IF;
        v_jw := v_jug.with_jar_price * v_jug.per_unit;
        SELECT * INTO v_p FROM sale_items
         WHERE sale_id = p_id AND product_id = v_si.product_id AND jar_mode = 'permanent' AND unit_price = v_jw
         ORDER BY id LIMIT 1 FOR UPDATE;
        IF FOUND THEN
          UPDATE sale_items
             SET quantity = quantity + v_n,
                 discount = round((quantity + v_n) * COALESCE(unit_discount, 0), 2),
                 surcharge = round((quantity + v_n) * COALESCE(unit_surcharge, 0), 2),
                 line_total = round((quantity + v_n)
                                    * (unit_price - COALESCE(unit_discount, 0) + COALESCE(unit_surcharge, 0)), 2)
           WHERE id = v_p.id;
          v_up := v_up + round(v_n * (v_p.unit_price - COALESCE(v_p.unit_discount, 0) + COALESCE(v_p.unit_surcharge, 0)), 2)
                       - round(v_n * v_price, 2);
        ELSE
          INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total, jar_mode, jar_unit_price)
          VALUES (p_id, v_si.product_id, v_n, v_jw, round(v_n * v_jw, 2), 'permanent',
                  COALESCE(v_jug.jar_price * v_jug.per_unit, 0));
          v_up := v_up + round(v_n * v_jw, 2) - round(v_n * v_price, 2);
        END IF;
        -- Jugs: a return-later line's jugs owed are cleared, then all are sold.
        IF v_si.jar_mode IS NULL OR v_si.jar_mode = 'return_later' THEN
          PERFORM public._supply_jugs_back('sale_id', p_id, v_si.product_id, 'sale', 'sale_reversal', v_n, v_note);
        END IF;
        INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                        source, reference, sale_id, created_by, product_id, notes)
        VALUES (v_factory, v_jug.container_type_id, 'warehouse', NULL, 'external', NULL, v_n * v_jug.per_unit,
                'jar_sold', v_ref, p_id, v_uid, v_si.product_id, 'Jar sold with the water -- ' || v_note);
      END IF;

      v_keep := v_new - v_n;
      IF v_keep = 0 THEN
        IF (SELECT count(*) FROM sale_items WHERE sale_id = p_id) = 1 THEN
          RAISE EXCEPTION '% would have nothing left -- cancel the posting instead', v_ref;
        END IF;
        DELETE FROM sale_items WHERE id = v_si.id;
      ELSE
        UPDATE sale_items
           SET quantity = v_keep,
               discount = round(v_keep * COALESCE(unit_discount, 0), 2),
               surcharge = round(v_keep * COALESCE(unit_surcharge, 0), 2),
               line_total = round(v_keep * v_price, 2)
         WHERE id = v_si.id;
      END IF;
    END LOOP;
    IF v_count = 0 THEN RAISE EXCEPTION 'Nothing changed'; END IF;

    -- Net: what came back (v_value) less what the Jug + Water switch adds.
    v_net := v_up - v_value;
    IF v_net > 0 THEN
      UPDATE sales
         SET subtotal = subtotal + v_net, grand_total = grand_total + v_net, balance = balance + v_net
       WHERE id = p_id;
      SELECT * INTO v_debt FROM debts WHERE sale_id = p_id
       ORDER BY (status <> 'paid') DESC, created_at DESC, id LIMIT 1 FOR UPDATE;
      IF FOUND THEN
        UPDATE debts
           SET total_amount = total_amount + v_net,
               outstanding = outstanding + v_net,
               status = CASE WHEN amount_paid > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END,
               updated_at = now()
         WHERE id = v_debt.id
         RETURNING * INTO v_debt;
      ELSE
        INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
        VALUES (v_factory, v_s.customer_id, p_id, NULL, v_net, 0, v_net, 'unpaid')
        RETURNING * INTO v_debt;
      END IF;
      IF v_s.customer_id IS NOT NULL THEN
        UPDATE customers
           SET outstanding_balance = outstanding_balance + v_net,
               total_purchases = total_purchases + v_net,
               updated_at = now()
         WHERE id = v_s.customer_id;
        PERFORM public._customer_ledger_post(
          v_factory, v_s.customer_id, 'DEBIT_ADJUSTMENT', 'sale', gen_random_uuid(), p_id, NULL,
          v_debt.id, 0, 0, 0, 0, v_net, NULL,
          'Dispenser supply edited on ' || v_ref || ': Jug + Water', v_reason, NULL, NULL, v_uid);
      END IF;
    END IF;
    -- A net decrease comes off as a return would (nothing when the net is up).
    v_value := GREATEST(-v_net, 0);

    -- The money, as a return: off the invoice's debt first, the rest credit.
    v_reduce := LEAST(v_value, GREATEST(v_s.balance, 0));
    v_credit := v_value - v_reduce;
    UPDATE sales
       SET subtotal = GREATEST(subtotal - v_value, 0),
           grand_total = GREATEST(grand_total - v_value, 0),
           balance = GREATEST(balance - v_reduce, 0),
           amount_paid = GREATEST(amount_paid - v_credit, 0)
     WHERE id = p_id;
    SELECT * INTO v_debt FROM debts WHERE sale_id = p_id
     ORDER BY (status <> 'paid') DESC, created_at DESC, id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE debts
         SET total_amount = GREATEST(total_amount - v_value, 0),
             amount_paid = GREATEST(amount_paid - v_credit, 0),
             outstanding = GREATEST(outstanding - v_reduce, 0),
             status = CASE WHEN GREATEST(outstanding - v_reduce, 0) = 0 THEN 'paid'::debt_status
                           WHEN GREATEST(amount_paid - v_credit, 0) > 0 THEN 'partial'::debt_status
                           ELSE 'unpaid'::debt_status END,
             updated_at = now()
       WHERE id = v_debt.id;
    END IF;
    IF v_s.customer_id IS NOT NULL THEN
      UPDATE customers
         SET outstanding_balance = GREATEST(outstanding_balance - v_reduce, 0),
             total_purchases = GREATEST(total_purchases - v_value, 0),
             credit_balance = credit_balance + v_credit,
             updated_at = now()
       WHERE id = v_s.customer_id;
      IF v_value > 0 THEN
        PERFORM public._customer_ledger_post(
          v_factory, v_s.customer_id, 'CREDIT_ADJUSTMENT', 'sale', gen_random_uuid(), p_id, NULL,
          v_debt.id, 0, 0, 0, v_credit, -v_reduce, NULL,
          'Dispenser supply edited on ' || v_ref, v_reason, NULL, NULL, v_uid);
      END IF;
    END IF;

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_factory, 'edit_dispenser_supply', 'sales', p_id::text,
            jsonb_build_object('invoice_number', v_ref, 'lines', v_old, 'grand_total', v_s.grand_total),
            jsonb_build_object('lines', (SELECT jsonb_agg(jsonb_build_object('item_id', id, 'product_id', product_id,
                                                          'quantity', quantity, 'jar_mode', jar_mode, 'line_total', line_total))
                                           FROM sale_items WHERE sale_id = p_id),
                               'value_off', v_value, 'value_added', GREATEST(v_net, 0), 'debt_reduced', v_reduce, 'credit_added', v_credit,
                               'reason', v_reason));
    RETURN jsonb_build_object('reference', v_ref, 'value_off', v_value, 'value_added', GREATEST(v_net, 0));

  ELSIF p_kind = 'dispatch' THEN
    SELECT * INTO v_disp FROM stock_dispatches WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Posting not found'; END IF;
    IF NOT public._works_in_factory(v_uid, v_disp.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    IF v_disp.status <> 'posted' THEN RAISE EXCEPTION '% is %', v_disp.dispatch_number, v_disp.status; END IF;
    v_ref := v_disp.dispatch_number; v_factory := v_disp.factory_id;
    v_old := (SELECT jsonb_agg(to_jsonb(i)) FROM stock_dispatch_items i WHERE i.dispatch_id = p_id);

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      SELECT * INTO v_di FROM stock_dispatch_items WHERE id = (v_line->>'item_id')::uuid AND dispatch_id = p_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Line not on %', v_ref; END IF;
      v_new := NULLIF(v_line->>'quantity', '')::numeric;
      v_name := (SELECT name FROM products WHERE id = v_di.product_id);
      IF v_new IS NULL OR v_new < 0 THEN RAISE EXCEPTION 'Enter the new quantity for %', v_name; END IF;
      IF COALESCE(NULLIF(v_line->>'to_jug_water', '')::numeric, 0) > 0 THEN
        RAISE EXCEPTION 'A marketer''s Jug + Water is worked out from the jugs not back -- not set on the posting';
      END IF;
      CONTINUE WHEN v_new = v_di.quantity;
      IF NOT public._is_supply_dispenser(v_di.product_id) THEN
        RAISE EXCEPTION 'Only dispenser lines can be edited here -- % comes back as a return', v_name;
      END IF;
      IF v_new > v_di.quantity THEN
        RAISE EXCEPTION '% can only go down (posted %)', v_name, v_di.quantity;
      END IF;
      v_d := v_di.quantity - v_new;

      SELECT quantity INTO v_before FROM rep_stock
       WHERE sales_rep_id = v_disp.sales_rep_id AND product_id = v_di.product_id FOR UPDATE;
      IF COALESCE(v_before, 0) < v_d THEN
        RAISE EXCEPTION 'They hold only % % now (the rest is sold or returned) -- can''t take % off',
          COALESCE(v_before, 0), v_name, v_d;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_d, updated_at = now()
       WHERE sales_rep_id = v_disp.sales_rep_id AND product_id = v_di.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                      user_id, quantity_before, quantity_after)
      VALUES (v_factory, v_disp.sales_rep_id, v_di.product_id, 'reversal', -v_d, v_ref, v_note, v_uid,
              v_before, v_before - v_d);
      SELECT current_stock INTO v_before FROM products WHERE id = v_di.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock + v_d, updated_at = now() WHERE id = v_di.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after)
      VALUES (v_factory, v_di.product_id, 'return_from_rep', v_d, v_ref, v_note, v_uid, v_before, v_before + v_d);

      v_value := v_value + round(v_d * v_di.unit_price, 2);
      v_count := v_count + 1;
      IF v_new = 0 THEN
        IF (SELECT count(*) FROM stock_dispatch_items WHERE dispatch_id = p_id) = 1 THEN
          RAISE EXCEPTION '% would have nothing left -- cancel the posting instead', v_ref;
        END IF;
        DELETE FROM stock_dispatch_items WHERE id = v_di.id;
      ELSE
        UPDATE stock_dispatch_items SET quantity = v_new, line_value = round(v_new * unit_price, 2) WHERE id = v_di.id;
      END IF;
      PERFORM public._supply_jugs_back('dispatch_id', p_id, v_di.product_id, 'dispatch', 'dispatch_reversal', v_d, v_note);
    END LOOP;
    IF v_count = 0 THEN RAISE EXCEPTION 'Nothing changed'; END IF;

    UPDATE stock_dispatches SET total_value = GREATEST(total_value - v_value, 0) WHERE id = p_id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_factory, 'edit_dispenser_supply', 'stock_dispatch', p_id::text,
            jsonb_build_object('dispatch_number', v_ref, 'lines', v_old, 'total_value', v_disp.total_value),
            jsonb_build_object('lines', (SELECT jsonb_agg(to_jsonb(i)) FROM stock_dispatch_items i WHERE i.dispatch_id = p_id),
                               'value_off', v_value, 'reason', v_reason));
    RETURN jsonb_build_object('reference', v_ref, 'value_off', v_value);
  END IF;
  RAISE EXCEPTION 'Unknown posting kind %', p_kind;
END;
$fn$;
REVOKE ALL ON FUNCTION public.edit_dispenser_supply(text, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_dispenser_supply(text, uuid, jsonb, text) TO authenticated;
