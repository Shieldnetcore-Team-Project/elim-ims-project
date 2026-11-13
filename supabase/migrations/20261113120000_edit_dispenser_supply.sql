-- ============================================================================
-- Warehouse manager edits a dispenser supply in place
-- ----------------------------------------------------------------------------
-- User (2026-11-13): "warehouse manager should be able to edit supply in
-- case where marketer/distributor return product not sold, cases such as
-- customer don't have empty jugs to receive the entire supplied dispenser
-- ... instead of returning the product, he should just edit the supplied"
-- -- "for only dispenser bottle".
--
-- edit_dispenser_supply(p_kind, p_id, p_lines, p_reason)
--   p_kind   'sale'      a Warehouse posting to a distributor / office
--                        delivery customer (sales)
--            'dispatch'  a posting to a marketer / the Retail Shop
--                        (stock_dispatches)
--   p_lines  [{item_id, quantity}] -- the NEW quantity of each line changed
--   p_reason required
-- The SAME posting is changed (same invoice / posting number -- never
-- reversed and reposted, which lost returns already made, H MEDIX 13 Nov):
--   * only dispenser lines (Dispenser Water / Jug + Water -- a product with a
--     jug that isn't the Empty Jug), and only DOWN (what came straight back);
--     a line down to 0 is removed, but a posting keeps at least one line
--     (use Cancel for the whole posting);
--   * the difference goes back into Warehouse stock;
--   * jugs: the line's jug entries go back by the same amount -- Jug + Water
--     ('jar_sold'), return-later / untyped ('sale'), a marketer's posting
--     ('dispatch'); a swap line (Dispenser Water) has none;
--   * sale: never below what the customer already returned on it; the
--     invoice, its debt and the customer's account go down by qty x the
--     line's net price (as a return: off the debt first, the rest credit),
--     one CREDIT_ADJUSTMENT on the account;
--   * dispatch: never more than the marketer / shop still holds; the line's
--     value and the posting total go down (the marketer's account reads the
--     line values).
-- Who: Warehouse Managers (role warehouse_manager), Admin, Chairman -- in the
-- factory. Allowed after Accounts has confirmed or printed (they see the new
-- figures). Audit-logged with old and new lines.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._is_supply_editor(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.has_role(p_user, 'warehouse_manager') OR public.has_role(p_user, 'super_admin')
      OR public.has_role(p_user, 'chairman');
$fn$;
REVOKE ALL ON FUNCTION public._is_supply_editor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_supply_editor(uuid) TO authenticated;

-- The screens ask whether to show "Edit supply".
CREATE OR REPLACE FUNCTION public.can_edit_dispenser_supply()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public._is_supply_editor(auth.uid());
$fn$;
REVOKE ALL ON FUNCTION public.can_edit_dispenser_supply() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_edit_dispenser_supply() TO authenticated;

CREATE OR REPLACE FUNCTION public._is_supply_dispenser(p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public._is_dispenser_product(p_product) AND NOT public._is_empty_jug_product(p_product);
$fn$;
REVOKE ALL ON FUNCTION public._is_supply_dispenser(uuid) FROM PUBLIC, anon, authenticated;

-- Jugs back by p_qty units of p_product for one posting: the opposite of the
-- first jug entry of p_source on it (same jug, parties swapped).
CREATE OR REPLACE FUNCTION public._supply_jugs_back(p_column text, p_id uuid, p_product uuid, p_source text,
                                                   p_new_source text, p_qty numeric, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_m container_movements%ROWTYPE; v_per numeric;
BEGIN
  EXECUTE format('SELECT * FROM container_movements WHERE %I = $1 AND source = $2
                     AND (product_id = $3 OR product_id IS NULL) ORDER BY (product_id = $3) DESC NULLS LAST, created_at
                   LIMIT 1', p_column)
     INTO v_m USING p_id, p_source, p_product;
  IF v_m.id IS NULL THEN RETURN; END IF;           -- no jug entry to take back
  v_per := COALESCE((SELECT j.per_unit FROM public._product_jug(p_product) j
                      WHERE j.container_type_id = v_m.container_type_id LIMIT 1), 1);
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, sale_id, dispatch_id, created_by, product_id, notes)
  VALUES (v_m.factory_id, v_m.container_type_id, v_m.to_type, v_m.to_id, v_m.from_type, v_m.from_id,
          p_qty * v_per, p_new_source, v_m.reference, v_m.sale_id, v_m.dispatch_id, auth.uid(), p_product, p_note);
END;
$fn$;
REVOKE ALL ON FUNCTION public._supply_jugs_back(text, uuid, uuid, text, text, numeric, text) FROM PUBLIC, anon, authenticated;

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
      CONTINUE WHEN v_new = v_si.quantity;
      IF NOT public._is_supply_dispenser(v_si.product_id) THEN
        RAISE EXCEPTION 'Only dispenser lines can be edited here -- % comes back as a return', v_name;
      END IF;
      IF v_new > v_si.quantity THEN
        RAISE EXCEPTION '% can only go down (supplied %)', v_name, v_si.quantity;
      END IF;
      v_d := v_si.quantity - v_new;
      -- Not below what they already returned of this product on this invoice.
      v_back := (SELECT COALESCE(SUM(quantity_returned), 0) FROM sales_returns
                  WHERE sale_id = p_id AND product_id = v_si.product_id AND status <> 'cancelled');
      v_left := (SELECT SUM(quantity) FROM sale_items WHERE sale_id = p_id AND product_id = v_si.product_id) - v_d;
      IF v_left < v_back THEN
        RAISE EXCEPTION '% on % can''t go below % -- % already returned on it', v_name, v_ref, v_back, v_back;
      END IF;
      v_price := v_si.unit_price - COALESCE(v_si.unit_discount, 0) + COALESCE(v_si.unit_surcharge, 0);
      v_value := v_value + round(v_d * v_price, 2);
      v_count := v_count + 1;

      IF v_new = 0 THEN
        IF (SELECT count(*) FROM sale_items WHERE sale_id = p_id) = 1 THEN
          RAISE EXCEPTION '% would have nothing left -- cancel the posting instead', v_ref;
        END IF;
        DELETE FROM sale_items WHERE id = v_si.id;
      ELSE
        UPDATE sale_items
           SET quantity = v_new,
               discount = round(v_new * COALESCE(unit_discount, 0), 2),
               surcharge = round(v_new * COALESCE(unit_surcharge, 0), 2),
               line_total = round(v_new * v_price, 2)
         WHERE id = v_si.id;
      END IF;

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
    END LOOP;
    IF v_count = 0 THEN RAISE EXCEPTION 'Nothing changed'; END IF;

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
                               'value_off', v_value, 'debt_reduced', v_reduce, 'credit_added', v_credit,
                               'reason', v_reason));
    RETURN jsonb_build_object('reference', v_ref, 'value_off', v_value);

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
