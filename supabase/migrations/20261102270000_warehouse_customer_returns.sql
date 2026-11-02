-- ============================================================================
-- Warehouse customer returns under new names (fixes "Dispenser Jug is not a
-- dispenser" for good)
-- ----------------------------------------------------------------------------
-- User (2026-11-02): returning 6 Dispenser Jug (of 17 supplied) for NNOLI
-- SUPERMARKET kept failing with "Dispenser Jug is not a dispenser", and the
-- "Can return" list with "Could not find the function
-- public.customer_returnable_dispensers" -- the live database runs an older,
-- partly applied copy of the return functions (20261102120000 /
-- 20261102240000 / 20261102260000 never fully took).
--
-- So the app now calls functions under NEW names that no older copy can
-- shadow, with everything in this one script:
--   warehouse_customer_returnable(customer, all)  what the customer bought
--       and can still bring back (the "Can return" list)
--   warehouse_receive_customer_return(payload)   the return itself: no
--       "is it a dispenser" test -- anything they bought comes back, never
--       more than they bought; with all_products (Distributor/Office
--       Delivery) also products added by hand (valued at the product price,
--       off their brought-forward debts first, the rest credit). Money,
--       stock, jugs and marketers as 20261102240000.
--   _is_dispenser_product  as 20261102250000 (only the dispensers-only list
--       uses it).
-- The old names are left as they are; nothing calls them any more.
-- The SELECT at the end is read-only and confirms both functions are in.
-- ============================================================================

-- The dispenser test the "can return" list still uses, as 20261102250000
-- (repeated so this one script is enough).
CREATE OR REPLACE FUNCTION public._is_dispenser_product(p_product uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_found boolean;
BEGIN
  IF to_regclass('public.product_containers') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM product_containers pc
                             WHERE pc.product_id = $1 AND pc.jug_role IS DISTINCT FROM ''empty'')'
       INTO v_found USING p_product;
    IF v_found THEN RETURN true; END IF;
  END IF;
  RETURN EXISTS (SELECT 1 FROM products p WHERE p.id = p_product
                    AND p.name ~* '(dispenser|jug)');
END;
$$;
REVOKE ALL ON FUNCTION public._is_dispenser_product(uuid) FROM PUBLIC, anon, authenticated;


-- What a customer can bring back (the "Can return" list), as 20261102120000
-- -- missing on the live database ("Could not find the function
-- public.warehouse_customer_returnable"), so it is created here too.
CREATE OR REPLACE FUNCTION public.warehouse_customer_returnable(p_customer uuid, p_all boolean DEFAULT false)
RETURNS TABLE(product_id uuid, name text, unit text, bought numeric, returned numeric, returnable numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_factory uuid;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales-returns'::module_key, 'submit'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT factory_id INTO v_factory FROM customers WHERE id = p_customer;
  IF v_factory IS NULL OR NOT public._works_in_factory(auth.uid(), v_factory) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  RETURN QUERY
  WITH sold AS (
    SELECT si.product_id, SUM(si.quantity) AS q
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.customer_id = p_customer AND s.status = 'posted' AND s.deleted_at IS NULL
       AND NOT COALESCE(s.is_pr, false) AND (p_all OR public._is_dispenser_product(si.product_id))
     GROUP BY si.product_id
  ), back AS (
    SELECT r.product_id, SUM(r.quantity_returned) AS q
      FROM sales_returns r JOIN sales s ON s.id = r.sale_id
     WHERE s.customer_id = p_customer AND r.status <> 'cancelled'
     GROUP BY r.product_id
  )
  SELECT sold.product_id, p.name::text, p.unit::text, sold.q, COALESCE(back.q, 0),
         GREATEST(sold.q - COALESCE(back.q, 0), 0)
    FROM sold JOIN products p ON p.id = sold.product_id
    LEFT JOIN back ON back.product_id = sold.product_id
   ORDER BY p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_customer_returnable(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_customer_returnable(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.warehouse_receive_customer_return(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_customer_id uuid := NULLIF(payload->>'customer_id', '')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, CURRENT_DATE);
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_cust customers%ROWTYPE;
  v_item jsonb;
  v_product products%ROWTYPE;
  v_want numeric;
  v_left numeric;
  v_sale record;
  v_take numeric;
  v_chunks jsonb := '[]'::jsonb;   -- {sale_id, product_id, unit, qty, value}
  v_sale_id uuid;
  v_s sales%ROWTYPE;
  v_debt debts%ROWTYPE;
  v_value numeric;
  v_reduce numeric;
  v_credit numeric;
  v_total_value numeric := 0;
  v_total_reduce numeric := 0;
  v_total_credit numeric := 0;
  v_number text;
  v_n int := 0;
  v_c jsonb;
  v_before numeric;
  v_holder_items jsonb := '{}'::jsonb;   -- holder id -> [{product_id, quantity_returned}]
  v_holder text;
  v_rep_return jsonb;
  v_rep_returns jsonb := '[]'::jsonb;
  -- all_products: any product (Warehouse → Returns, Distributor/Office
  -- Delivery); otherwise dispensers only (Dispenser & jugs).
  v_all boolean := COALESCE((payload->>'all_products')::boolean, false);
  v_what text;
  v_bf record;
  v_bf_take numeric;
BEGIN
  IF NOT (public.has_permission(v_uid, 'sales-returns'::module_key, 'submit'::action_key)
       OR public.has_permission(v_uid, 'distribution'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'A return can''t be dated in the future'; END IF;
  SELECT * INTO v_cust FROM customers WHERE id = v_customer_id FOR UPDATE;
  IF NOT FOUND OR NOT public._works_in_factory(v_uid, v_cust.factory_id) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  IF jsonb_typeof(payload->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Enter what came back'; END IF;
  v_what := CASE WHEN v_all THEN 'Products' ELSE 'Unsold dispensers' END;

  -- Take each product back from the customer's sales, newest first.
  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    v_want := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0);
    CONTINUE WHEN v_want = 0;
    IF v_want < 0 THEN RAISE EXCEPTION 'Quantities cannot be negative'; END IF;
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid AND factory_id = v_cust.factory_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    -- No "is it a dispenser" test (user, 2026-11-02): anything the customer
    -- bought can come back; the sales matching below caps it at what they
    -- bought (all_products also takes goods not on a sale).
    v_left := v_want;
    FOR v_sale IN
      SELECT s.id, s.invoice_number,
             (SELECT SUM(quantity) FROM sale_items WHERE sale_id = s.id AND product_id = v_product.id) AS sold,
             (SELECT SUM(line_total) FROM sale_items WHERE sale_id = s.id AND product_id = v_product.id) AS sold_value,
             (SELECT COALESCE(SUM(quantity_returned), 0) FROM sales_returns
               WHERE sale_id = s.id AND product_id = v_product.id AND status <> 'cancelled') AS back
        FROM sales s
       WHERE s.customer_id = v_cust.id AND s.status = 'posted' AND s.deleted_at IS NULL
         AND NOT COALESCE(s.is_pr, false)
         AND EXISTS (SELECT 1 FROM sale_items WHERE sale_id = s.id AND product_id = v_product.id)
       ORDER BY s.sale_date DESC, s.created_at DESC
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_left, v_sale.sold - v_sale.back);
      CONTINUE WHEN v_take <= 0;
      v_chunks := v_chunks || jsonb_build_object('sale_id', v_sale.id, 'product_id', v_product.id,
        'unit', v_product.unit, 'name', v_product.name, 'qty', v_take,
        'value', round(v_take * COALESCE(v_sale.sold_value, 0) / NULLIF(v_sale.sold, 0), 2));
      v_left := v_left - v_take;
    END LOOP;
    IF v_left > 0 AND v_all THEN
      -- More than this system sold them (goods from the old system, or a
      -- product typed in by hand): straight back into Warehouse stock,
      -- valued at the product's price, against no sale.
      v_chunks := v_chunks || jsonb_build_object('sale_id', NULL, 'product_id', v_product.id,
        'unit', v_product.unit, 'name', v_product.name, 'qty', v_left,
        'value', round(v_left * COALESCE(v_product.unit_price, 0), 2));
      v_left := 0;
    ELSIF v_left > 0 THEN
      RAISE EXCEPTION '% bought only % % of % that can come back', v_cust.name, v_want - v_left, v_product.unit,
        v_product.name;
    END IF;
  END LOOP;
  IF jsonb_array_length(v_chunks) = 0 THEN RAISE EXCEPTION 'Enter how many dispensers came back'; END IF;

  v_number := 'SR-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');

  -- Per sale: the money, then each product's return row and stock.
  FOR v_sale_id IN SELECT DISTINCT (c->>'sale_id')::uuid FROM jsonb_array_elements(v_chunks) c LOOP
    v_s := NULL;
    v_debt := NULL;
    IF v_sale_id IS NOT NULL THEN
      SELECT * INTO v_s FROM sales WHERE id = v_sale_id FOR UPDATE;
    END IF;
    v_value := (SELECT SUM((c->>'value')::numeric) FROM jsonb_array_elements(v_chunks) c
                 WHERE (c->>'sale_id')::uuid IS NOT DISTINCT FROM v_sale_id);
    IF v_sale_id IS NULL THEN
      -- No sale: the value comes off their sale-less debts (brought forward
      -- from the old system), oldest first; the rest is their credit.
      v_reduce := 0;
      FOR v_bf IN
        SELECT * FROM debts
         WHERE customer_id = v_cust.id AND sale_id IS NULL AND outstanding > 0
         ORDER BY created_at, id FOR UPDATE
      LOOP
        EXIT WHEN v_reduce >= v_value;
        v_bf_take := LEAST(v_bf.outstanding, v_value - v_reduce);
        UPDATE debts
           SET outstanding = outstanding - v_bf_take,
               status = CASE WHEN outstanding - v_bf_take = 0 THEN 'paid'::debt_status
                             ELSE 'partial'::debt_status END,
               updated_at = now()
         WHERE id = v_bf.id;
        v_reduce := v_reduce + v_bf_take;
        v_debt.id := COALESCE(v_debt.id, v_bf.id);
      END LOOP;
    ELSE
      v_reduce := LEAST(v_value, GREATEST(v_s.balance, 0));
    END IF;
    v_credit := v_value - v_reduce;

    IF v_sale_id IS NOT NULL THEN
    UPDATE sales
       SET subtotal = GREATEST(subtotal - v_value, 0),
           grand_total = GREATEST(grand_total - v_value, 0),
           balance = GREATEST(balance - v_reduce, 0),
           amount_paid = GREATEST(amount_paid - v_credit, 0)
     WHERE id = v_sale_id;
    v_debt := NULL;
    SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale_id
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
    END IF;
    UPDATE customers
       SET outstanding_balance = GREATEST(outstanding_balance - v_reduce, 0),
           total_purchases = GREATEST(total_purchases - v_value, 0),
           credit_balance = credit_balance + v_credit,
           updated_at = now()
     WHERE id = v_cust.id;
    IF v_reduce > 0 OR v_credit > 0 THEN
      PERFORM public._customer_ledger_post(
        v_cust.factory_id, v_cust.id, 'CREDIT_ADJUSTMENT', 'sales_return', gen_random_uuid(), v_sale_id, NULL,
        v_debt.id, 0, 0, 0, v_credit, -v_reduce, NULL,
        v_what || ' returned' || COALESCE(' on ' || v_s.invoice_number, ' (not on a sale in this system)'), v_reason, NULL, NULL, v_uid);
    END IF;
    v_total_value := v_total_value + v_value;
    v_total_reduce := v_total_reduce + v_reduce;
    v_total_credit := v_total_credit + v_credit;

    FOR v_c IN SELECT c FROM jsonb_array_elements(v_chunks) c
                 WHERE (c->>'sale_id')::uuid IS NOT DISTINCT FROM v_sale_id LOOP
      v_n := v_n + 1;
      IF v_s.sales_rep_id IS NULL THEN
        -- A Warehouse sale: straight back into Warehouse stock.
        SELECT current_stock INTO v_before FROM products WHERE id = (v_c->>'product_id')::uuid FOR UPDATE;
        UPDATE products SET current_stock = current_stock + (v_c->>'qty')::numeric, updated_at = now()
         WHERE id = (v_c->>'product_id')::uuid;
        INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                        quantity_before, quantity_after)
        VALUES (v_cust.factory_id, (v_c->>'product_id')::uuid, 'returned', (v_c->>'qty')::numeric,
                v_number || '-' || v_n, v_what || ' returned by ' || v_cust.name, v_uid,
                v_before, v_before + (v_c->>'qty')::numeric);
      ELSE
        -- A marketer's / the shop's sale: back onto their stock first.
        SELECT quantity INTO v_before FROM rep_stock
         WHERE sales_rep_id = v_s.sales_rep_id AND product_id = (v_c->>'product_id')::uuid FOR UPDATE;
        IF FOUND THEN
          UPDATE rep_stock SET quantity = quantity + (v_c->>'qty')::numeric, updated_at = now()
           WHERE sales_rep_id = v_s.sales_rep_id AND product_id = (v_c->>'product_id')::uuid;
        ELSE
          v_before := 0;
          INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
          VALUES (v_s.sales_rep_id, (v_c->>'product_id')::uuid, v_cust.factory_id, (v_c->>'qty')::numeric);
        END IF;
        INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                        user_id, quantity_before, quantity_after)
        VALUES (v_cust.factory_id, v_s.sales_rep_id, (v_c->>'product_id')::uuid, 'reversal', (v_c->>'qty')::numeric,
                v_number || '-' || v_n, 'Customer return on ' || v_s.invoice_number, v_uid,
                v_before, v_before + (v_c->>'qty')::numeric);
        v_holder := v_s.sales_rep_id::text;
        v_holder_items := jsonb_set(v_holder_items, ARRAY[v_holder],
          COALESCE(v_holder_items->v_holder, '[]'::jsonb)
            || jsonb_build_object('product_id', v_c->>'product_id', 'quantity_returned', (v_c->>'qty')::numeric));
      END IF;

      INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned, unit,
                                reason, status, accepted_quantity, received_by, inspected_by, inspected_at, return_date,
                                sales_rep_id, value, debt_reduced, credit_added, refund_amount, notes)
      VALUES (v_cust.factory_id, v_number || '-' || v_n, v_sale_id, v_cust.id, (v_c->>'product_id')::uuid,
              (v_c->>'qty')::numeric, v_c->>'unit', v_reason, 'completed', (v_c->>'qty')::numeric,
              v_uid, v_uid, now(), v_date, v_s.sales_rep_id, (v_c->>'value')::numeric,
              round(v_reduce * (v_c->>'value')::numeric / NULLIF(v_value, 0), 2),
              round(v_credit * (v_c->>'value')::numeric / NULLIF(v_value, 0), 2), 0,
              v_what || ' back to the Warehouse');
    END LOOP;
  END LOOP;

  -- Goods on a marketer's / the shop's stock come on into the Warehouse
  -- through their return, which credits their account.
  FOR v_holder IN SELECT jsonb_object_keys(v_holder_items) LOOP
    v_rep_return := public.create_rep_return(jsonb_build_object(
      'factory_id', v_cust.factory_id, 'sales_rep_id', v_holder, 'return_date', v_date,
      'notes', v_what || ' returned by ' || v_cust.name || ' (' || v_number || ')',
      'items', v_holder_items->v_holder));
    v_rep_returns := v_rep_returns || v_rep_return;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_cust.factory_id, 'warehouse_receive_customer_return', 'customers', v_cust.id::text,
          jsonb_build_object('return_number', v_number, 'customer', v_cust.name, 'lines', v_chunks,
                             'value', v_total_value, 'debt_reduced', v_total_reduce, 'credit_added', v_total_credit,
                             'rep_returns', v_rep_returns, 'reason', v_reason));

  RETURN jsonb_build_object('return_number', v_number, 'value', v_total_value, 'debt_reduced', v_total_reduce,
                            'credit_added', v_total_credit, 'rep_returns', v_rep_returns);
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_receive_customer_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_receive_customer_return(jsonb) TO authenticated;


NOTIFY pgrst, 'reload schema';

SELECT p.proname AS function_ready
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('warehouse_customer_returnable', 'warehouse_receive_customer_return')
 ORDER BY 1;
