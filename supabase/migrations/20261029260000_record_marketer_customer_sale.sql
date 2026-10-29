-- ============================================================================
-- record_marketer_customer_sale: Accounts records what a marketer's customer
-- bought, straight from the marketer's account
-- ----------------------------------------------------------------------------
-- User request (2026-10-29): on the Accountant's Marketer & retail accounts →
-- Customers of <marketer>, the accountant adds the products each customer got
-- from the marketer -- what they bought, the price, a discount -- and records
-- their payments, as many times as needed until the account is settled, with
-- every transaction kept under the marketer.
--
-- One call = one invoice for that customer on the marketer's account:
--   items    [{product_id, quantity, unit_price?, discount?}] -- unit_price
--            defaults to the product's price; discount is per pack (as
--            adjust_sale_lines): the line is quantity x (price - discount)
--   payment  optional {amount, method} paid there and then
-- The sale is posted at once, no approval (user: "no body is confirming
-- anything"): the goods leave the marketer's van stock, the money paid is
-- receipted, the rest is the customer's debt on the marketer's account, and
-- the customer's ledger is written -- all by _post_sale, as for any sale.
-- Later payments go through record_payment (Record payment on the
-- customer's row), which clears the oldest invoices first.
-- Same people who record payments (payments / debts write) or post to
-- marketers. The customer's credit limit applies as for any sale.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_marketer_customer_sale(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep_id uuid := NULLIF(payload->>'sales_rep_id', '')::uuid;
  v_customer_id uuid := NULLIF(payload->>'customer_id', '')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'sale_date', '')::date, CURRENT_DATE);
  v_paid numeric := round(COALESCE((payload->'payment'->>'amount')::numeric, 0), 2);
  v_method payment_method := COALESCE(NULLIF(payload->'payment'->>'method', '')::payment_method, 'cash');
  v_remarks text := NULLIF(btrim(COALESCE(payload->>'remarks', '')), '');
  v_rep sales_reps%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_item jsonb;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
  v_disc numeric;
  v_stock numeric;
  v_subtotal numeric := 0;
  v_credit numeric;
  v_prefix text;
  v_invoice text;
  v_sale_id uuid;
  v_post jsonb;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'distribution'::module_key, 'post'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = v_rep_id;
  IF NOT FOUND OR v_rep.kind <> 'rep' THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_cust FROM customers WHERE id = v_customer_id AND factory_id = v_rep.factory_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF v_cust.removed_at IS NOT NULL THEN
    RAISE EXCEPTION '% was removed from the customer list. Restore them on the Customers page first.', v_cust.name;
  END IF;
  IF jsonb_typeof(payload->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'items') = 0 THEN
    RAISE EXCEPTION 'Add at least one product';
  END IF;
  IF v_paid < 0 THEN RAISE EXCEPTION 'The payment cannot be negative'; END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'The sale date cannot be in the future'; END IF;

  -- Check every line first: the product, the price, the discount and that
  -- the marketer has the packs (_post_sale takes them off the van).
  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid AND factory_id = v_rep.factory_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    v_price := round(COALESCE(NULLIF(v_item->>'unit_price', '')::numeric, v_product.unit_price), 2);
    v_disc := round(COALESCE(NULLIF(v_item->>'discount', '')::numeric, 0), 2);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Enter how many % the customer took', v_product.name; END IF;
    IF v_price < 0 OR v_disc < 0 THEN RAISE EXCEPTION 'Prices and discounts cannot be negative'; END IF;
    IF v_disc > v_price THEN RAISE EXCEPTION 'The discount on % is more than its price per pack', v_product.name; END IF;
    SELECT quantity INTO v_stock FROM rep_stock WHERE sales_rep_id = v_rep.id AND product_id = v_product.id;
    IF COALESCE(v_stock, 0) < v_qty THEN
      RAISE EXCEPTION '% has only % of % on hand', v_rep.full_name, COALESCE(v_stock, 0), v_product.name;
    END IF;
    v_subtotal := v_subtotal + round(v_qty * (v_price - v_disc), 2);
  END LOOP;

  -- The customer's advance covers what the payment doesn't, as for any sale.
  v_credit := LEAST(GREATEST(v_subtotal - v_paid, 0), COALESCE(v_cust.credit_balance, 0));

  SELECT COALESCE(invoice_prefix, 'INV-') INTO v_prefix FROM settings WHERE factory_id = v_rep.factory_id;
  v_invoice := COALESCE(v_prefix, 'INV-') || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, sales_rep_id,
                    remarks, created_by, is_pr, status, pending_payments, credit_applied)
  VALUES (v_rep.factory_id, v_invoice, v_date, v_cust.id, v_cust.name, v_cust.phone, v_cust.address,
          v_subtotal, 0, 0, v_subtotal, v_paid, GREATEST(v_subtotal - v_paid - v_credit, 0), v_method, v_rep.full_name,
          v_rep.id, COALESCE(v_remarks, 'Recorded by Accounts from ' || v_rep.full_name || '''s account'), v_uid, false,
          'pending_approval',
          CASE WHEN v_paid > 0 THEN jsonb_build_array(jsonb_build_object('amount', v_paid, 'method', v_method)) END,
          v_credit)
  RETURNING id INTO v_sale_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := round(COALESCE(NULLIF(v_item->>'unit_price', '')::numeric, v_product.unit_price), 2);
    v_disc := round(COALESCE(NULLIF(v_item->>'discount', '')::numeric, 0), 2);
    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, unit_discount, discount, line_total)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_disc, round(v_qty * v_disc, 2), round(v_qty * (v_price - v_disc), 2));
  END LOOP;

  PERFORM public.record_workflow_action('sales', v_sale_id, 'submit', NULL, 'pending_approval', v_remarks);
  v_post := public._post_sale(v_sale_id, 'Recorded by Accounts from the marketer''s account - posted at once');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_rep.factory_id, 'record_marketer_customer_sale', 'sales', v_sale_id::text,
          jsonb_build_object('invoice_number', v_invoice, 'marketer', v_rep.full_name, 'customer', v_cust.name,
                             'total', v_subtotal, 'paid', v_paid, 'items', payload->'items'));

  RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice, 'grand_total', v_subtotal,
                            'paid', v_paid, 'balance', v_post->'balance');
END;
$$;
REVOKE ALL ON FUNCTION public.record_marketer_customer_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_marketer_customer_sale(jsonb) TO authenticated;
