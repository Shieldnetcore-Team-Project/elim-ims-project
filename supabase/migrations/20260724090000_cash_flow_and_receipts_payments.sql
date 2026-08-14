
-- Cash Flow / Receipts & Payments spec needs four "other" cash-movement categories that
-- nothing in the schema currently represents (Other Income, Donations/Endowments, Other
-- Cash Inflows, Other Cash Outflows). Sales income, inventory purchases, production costs,
-- and operating/office expenses are already derivable from sales/payments_received,
-- raw_material_movements, production, and expenses respectively -- cash_transactions only
-- covers the leftover categories so Cash Flow never double-books a transaction that already
-- has a home in one of those tables.

CREATE TABLE public.cash_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  transaction_number text UNIQUE NOT NULL,
  transaction_date date NOT NULL DEFAULT current_date,
  transaction_type text NOT NULL CHECK (transaction_type IN ('receipt', 'payment')),
  category text NOT NULL CHECK (category IN ('other_income', 'donation_endowment', 'other_inflow', 'other_outflow')),
  description text,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_method payment_method NOT NULL DEFAULT 'cash',
  payer_payee text,
  related_reference text,
  recorded_by_name text NOT NULL,
  recorded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cash_transactions TO anon, authenticated;
GRANT ALL ON public.cash_transactions TO service_role;
ALTER TABLE public.cash_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manage cash transactions" ON public.cash_transactions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.create_cash_transaction(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_type text := payload->>'transaction_type';
  v_category text := payload->>'category';
  v_amount numeric := (payload->>'amount')::numeric;
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_date date := COALESCE((payload->>'transaction_date')::date, CURRENT_DATE);
  v_description text := payload->>'description';
  v_payer_payee text := payload->>'payer_payee';
  v_reference text := payload->>'related_reference';
  v_recorded_by text := payload->>'recorded_by_name';
  v_prefix text;
  v_number text;
  v_id uuid;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_type NOT IN ('receipt','payment') THEN RAISE EXCEPTION 'transaction_type must be receipt or payment'; END IF;
  IF v_category NOT IN ('other_income','donation_endowment','other_inflow','other_outflow') THEN
    RAISE EXCEPTION 'Invalid category';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;
  IF v_recorded_by IS NULL OR btrim(v_recorded_by) = '' THEN RAISE EXCEPTION 'Recorded by name is required'; END IF;

  v_prefix := CASE WHEN v_type = 'receipt' THEN 'RCT-' ELSE 'PMT-' END;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO cash_transactions(factory_id, transaction_number, transaction_date, transaction_type, category,
                                 description, amount, payment_method, payer_payee, related_reference,
                                 recorded_by_name, recorded_by)
  VALUES (v_factory, v_number, v_date, v_type, v_category, v_description, v_amount, v_method,
          v_payer_payee, v_reference, v_recorded_by, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'transaction_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_cash_transaction(jsonb) TO anon, authenticated;

-- create_sale previously only updated sales.amount_paid for the payment taken at the point of
-- sale -- it never landed in payments_received, so that page (and Cash Flow's "Sales income"
-- category) silently missed every up-front cash sale and only ever saw later debt top-ups
-- made through record_payment. Insert a matching receipt so payments_received becomes the
-- complete, correctly-dated record of cash actually collected from customers.
CREATE OR REPLACE FUNCTION public.create_sale(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_sale_date date := COALESCE((payload->>'sale_date')::date, CURRENT_DATE);
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_customer_name text := payload->>'customer_name';
  v_customer_phone text := payload->>'customer_phone';
  v_customer_address text := payload->>'customer_address';
  v_discount numeric := COALESCE((payload->>'discount')::numeric, 0);
  v_vat numeric := COALESCE((payload->>'vat')::numeric, 0);
  v_amount_paid numeric := COALESCE((payload->>'amount_paid')::numeric, 0);
  v_payment_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_sales_person text := payload->>'sales_person';
  v_remarks text := payload->>'remarks';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_prefix text;
  v_invoice text;
  v_receipt_prefix text;
  v_receipt text;
  v_subtotal numeric := 0;
  v_grand numeric := 0;
  v_balance numeric := 0;
  v_sale_id uuid;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'no items'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_product.current_stock < v_qty THEN
      RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
  END LOOP;

  v_grand := GREATEST(v_subtotal - v_discount + v_vat, 0);
  v_balance := GREATEST(v_grand - v_amount_paid, 0);

  SELECT COALESCE(invoice_prefix,'INV-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'INV-'; END IF;
  v_invoice := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, remarks, created_by)
  VALUES (v_factory, v_invoice, v_sale_date, v_customer, v_customer_name, v_customer_phone, v_customer_address,
          v_subtotal, v_discount, v_vat, v_grand, v_amount_paid, v_balance, v_payment_method, v_sales_person, v_remarks, v_uid)
  RETURNING id INTO v_sale_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);

    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_qty * v_price);

    UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product.id;

    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_product.id, 'sold', v_qty, v_invoice, 'Sale', v_uid, v_product.current_stock, v_product.current_stock - v_qty);
  END LOOP;

  IF v_amount_paid > 0 THEN
    SELECT COALESCE(receipt_prefix,'RCP-') INTO v_receipt_prefix FROM settings WHERE factory_id = v_factory;
    IF v_receipt_prefix IS NULL THEN v_receipt_prefix := 'RCP-'; END IF;
    v_receipt := v_receipt_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount_paid, v_payment_method, v_sale_date, v_uid, 'Payment at point of sale');
  END IF;

  IF v_balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_factory, v_customer, v_sale_id, v_grand, v_amount_paid, v_balance,
            CASE WHEN v_amount_paid > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END);
  END IF;

  IF v_customer IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_grand,
           outstanding_balance = outstanding_balance + v_balance,
           updated_at = now()
     WHERE id = v_customer;
  END IF;

  RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                            'subtotal', v_subtotal, 'grand_total', v_grand, 'balance', v_balance);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO anon, authenticated;
