-- ============================================================================
-- Retail shop dispenser jars: Swap / Return later / Permanent jar sale
-- ----------------------------------------------------------------------------
-- User decisions (2026-10-31), on the "dispenser jar accountability" brief:
--   * On the shop's POS every dispenser line says what happens to the jar:
--       swap          the customer hands an empty in now -- nothing is owed
--                     (the existing "refill = swap" rule)
--       return_later  the customer takes the jar and owes the empty; it is
--                     tracked against the sale (and customer) until returned
--       permanent     the customer buys the jar: N4,200 a dispenser, of which
--                     N3,000 is the jar (user's figures, editable by an
--                     admin per jug type); no empty is expected
--   * Empties go Shop -> Warehouse (the existing two-step jug return: the
--     shop records what it sends, the Warehouse confirms what arrived; a
--     shortfall stays on the shop) -> QC -> PM (existing). No deposit.
--
-- Built on the container ledger (container_movements; a holder's balance is
-- what came in minus what went out), not a second jar inventory:
--   return_later  shop -> customer / walk-in, source 'sale' (the obligation;
--                 the sale_id links it)
--   permanent     shop -> external, source 'jar_sold' (leaves the company's
--                 jars; reversed by 'jar_sold_reversal')
--   swap          no move
--   customer brings empties back  customer / walk-in -> shop, source
--                 'customer_return', linked to the sale
-- Lines without a jar mode (marketers' sales, older sales) keep the old
-- behaviour (the product's jug role).
--
--   container_types.jar_price / with_jar_price   the jar alone / jar + water,
--                 per jug type; set_jar_prices (admins)
--   sale_items.jar_mode / jar_unit_price          per line; the jar part of a
--                 permanent line's price (water = unit_price - jar_unit_price)
--   create_sale   a shop sale's jug lines must carry a jar mode; a permanent
--                 line is priced from the jug type, not the screen
--   jar_customer_returns   empties customers bring to the shop: good /
--                 damaged; more than they owe waits for approval
--   shop_jar_obligations, shop_jar_summary        what the shop's screens show
--   jug_accountability_report / jug_overview      count the new sources
-- ============================================================================

-- ============ 1. Prices, line modes, new ledger sources ============
ALTER TABLE public.container_types
  ADD COLUMN IF NOT EXISTS jar_price numeric(14,2) CHECK (jar_price IS NULL OR jar_price >= 0),
  ADD COLUMN IF NOT EXISTS with_jar_price numeric(14,2) CHECK (with_jar_price IS NULL OR with_jar_price >= 0);

-- The user's figures (2026-10-31) for the jug types, where not set yet.
UPDATE public.container_types SET jar_price = 3000 WHERE jar_price IS NULL AND name IN ('Old Jug', 'New Jug');
UPDATE public.container_types SET with_jar_price = 4200 WHERE with_jar_price IS NULL AND name IN ('Old Jug', 'New Jug');

ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS jar_mode text CHECK (jar_mode IS NULL OR jar_mode IN ('swap', 'return_later', 'permanent')),
  ADD COLUMN IF NOT EXISTS jar_unit_price numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE public.container_movements DROP CONSTRAINT IF EXISTS container_movements_source_check;
ALTER TABLE public.container_movements ADD CONSTRAINT container_movements_source_check CHECK (source IN (
  'dispatch','dispatch_reversal','sale','sale_reversal','rep_return','rep_return_cancelled',
  'sales_return','sales_return_cancelled','return','issue','lost','purchase','damaged','merge',
  'jar_sold','jar_sold_reversal','customer_return'));

CREATE OR REPLACE FUNCTION public.set_jar_prices(p_container_type uuid, p_jar_price numeric, p_with_jar_price numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row container_types%ROWTYPE;
BEGIN
  IF NOT (public.is_admin(auth.uid())
          OR public.has_permission(auth.uid(), 'settings'::module_key, 'edit'::action_key)
          OR public.has_permission(auth.uid(), 'settings'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Only an administrator can change jar prices';
  END IF;
  SELECT * INTO v_row FROM container_types WHERE id = p_container_type FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Jug type not found'; END IF;
  IF p_jar_price IS NULL OR p_jar_price < 0 OR p_with_jar_price IS NULL OR p_with_jar_price < p_jar_price THEN
    RAISE EXCEPTION 'Enter the jar price and the jar + water price (not below the jar price)';
  END IF;
  UPDATE container_types SET jar_price = p_jar_price, with_jar_price = p_with_jar_price WHERE id = p_container_type;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_row.factory_id, 'set_jar_prices', 'container_types', v_row.id::text,
          jsonb_build_object('jar_price', v_row.jar_price, 'with_jar_price', v_row.with_jar_price),
          jsonb_build_object('jar_price', p_jar_price, 'with_jar_price', p_with_jar_price));
END;
$$;
REVOKE ALL ON FUNCTION public.set_jar_prices(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_jar_prices(uuid, numeric, numeric) TO authenticated;

-- The jug type a product carries (one jug per unit), with its prices.
CREATE OR REPLACE FUNCTION public._product_jug(p_product uuid)
RETURNS TABLE(container_type_id uuid, name text, per_unit numeric, jar_price numeric, with_jar_price numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ct.id, ct.name, pc.quantity_per_unit, ct.jar_price, ct.with_jar_price
    FROM product_containers pc
    JOIN container_types ct ON ct.id = pc.container_type_id AND ct.active
   WHERE pc.product_id = p_product AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
     AND ct.name ~* 'jug'
   ORDER BY ct.name LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._product_jug(uuid) FROM PUBLIC, anon, authenticated;

-- Products that carry a jug, with prices -- for the POS.
CREATE OR REPLACE FUNCTION public.jug_products(p_factory uuid)
RETURNS TABLE(product_id uuid, container_type_id uuid, container_name text, per_unit numeric,
              jar_price numeric, with_jar_price numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, j.container_type_id, j.name, j.per_unit, j.jar_price, j.with_jar_price
    FROM products p, LATERAL public._product_jug(p.id) j
   WHERE p.factory_id = p_factory AND p.active;
$$;
REVOKE ALL ON FUNCTION public.jug_products(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_products(uuid) TO authenticated;

-- ============ 2. create_sale: jar mode per line ============
-- As 20261029140000, plus: a jug line's jar mode (required on a retail shop's
-- sale), and a permanent line priced from its jug type (jar + water), with
-- the jar part kept on the line.
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
  v_payments jsonb := payload->'payments';
  v_apply_credit numeric := 0;
  v_customer_credit numeric;
  v_sales_person text := payload->>'sales_person';
  v_remarks text := payload->>'remarks';
  v_sales_rep uuid := NULLIF(payload->>'sales_rep_id','')::uuid;
  v_is_pr boolean := COALESCE((payload->>'is_pr')::boolean, false);
  v_rep_row public.sales_reps%ROWTYPE;
  v_rep_stock numeric;
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_prefix text;
  v_invoice text;
  v_subtotal numeric := 0;
  v_grand numeric := 0;
  v_balance numeric := 0;
  v_sale_id uuid;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
  v_post jsonb;
  v_mode text;
  v_jug record;
  v_jar numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'no items'; END IF;

  IF v_is_pr THEN
    -- PR is complimentary -- never mix a real split payment or credit draw
    -- into a "no charge" sale.
    v_payments := NULL;
  END IF;

  IF v_payments IS NOT NULL AND jsonb_array_length(v_payments) > 0 THEN
    SELECT COALESCE(SUM((p->>'amount')::numeric), 0) INTO v_amount_paid
      FROM jsonb_array_elements(v_payments) AS p
      WHERE (p->>'amount')::numeric > 0;
    SELECT (p->>'method')::payment_method INTO v_payment_method
      FROM jsonb_array_elements(v_payments) AS p
      WHERE (p->>'amount')::numeric > 0
      ORDER BY (p->>'amount')::numeric DESC
      LIMIT 1;
    v_payment_method := COALESCE(v_payment_method, 'cash');
  END IF;

  IF v_sales_rep IS NOT NULL THEN
    SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_sales_rep;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
    IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;
    IF v_rep_row.status <> 'active' THEN RAISE EXCEPTION 'Sales rep is not active'; END IF;
  END IF;

  -- Resolve a real customer record for a named walk-in (customer_id not
  -- picked from the dropdown) instead of leaving the sale unlinked.
  IF v_customer IS NULL AND v_customer_name IS NOT NULL AND btrim(v_customer_name) <> '' THEN
    IF v_customer_phone IS NOT NULL AND btrim(v_customer_phone) <> '' THEN
      SELECT id INTO v_customer FROM customers
      WHERE factory_id = v_factory AND phone = v_customer_phone
      LIMIT 1;
    END IF;
    IF v_customer IS NULL THEN
      SELECT id INTO v_customer FROM customers
      WHERE factory_id = v_factory AND lower(name) = lower(btrim(v_customer_name))
      LIMIT 1;
    END IF;
    IF v_customer IS NULL THEN
      INSERT INTO customers(factory_id, name, phone, address, registered)
      VALUES (v_factory, btrim(v_customer_name), v_customer_phone, v_customer_address, false)
      RETURNING id INTO v_customer;
    END IF;
  END IF;

  -- Validate only -- nothing here mutates stock. The actual decrement
  -- happens in approve_sale(), once a manager has reviewed the sale, so
  -- availability is re-checked (and row-locked) again at that point too.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    -- The jar on a jug line (user, 2026-10-31).
    v_mode := NULLIF(v_item->>'jar_mode', '');
    SELECT * INTO v_jug FROM public._product_jug(v_product.id);
    IF v_mode IS NOT NULL AND v_mode NOT IN ('swap', 'return_later', 'permanent') THEN
      RAISE EXCEPTION 'Unknown jar choice %', v_mode;
    END IF;
    IF v_mode IS NOT NULL AND v_jug.container_type_id IS NULL THEN
      RAISE EXCEPTION '% does not come in a jug', v_product.name;
    END IF;
    IF v_mode IS NULL AND v_jug.container_type_id IS NOT NULL AND v_sales_rep IS NOT NULL AND v_rep_row.kind = 'outlet' THEN
      RAISE EXCEPTION 'Choose Swap, Return later or Permanent jar sale for %', v_product.name;
    END IF;
    IF v_mode = 'permanent' THEN
      IF v_jug.jar_price IS NULL OR v_jug.with_jar_price IS NULL THEN
        RAISE EXCEPTION 'The jar price for % is not set -- an administrator sets it under Retail -> Jars', v_jug.name;
      END IF;
      v_price := v_jug.with_jar_price * v_jug.per_unit;
    END IF;
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_sales_rep IS NOT NULL THEN
      SELECT quantity INTO v_rep_stock FROM rep_stock WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id;
      IF COALESCE(v_rep_stock, 0) < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %: rep has %, need %', v_product.name, COALESCE(v_rep_stock,0), v_qty;
      END IF;
    ELSE
      IF v_product.current_stock < v_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
      END IF;
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
  END LOOP;

  -- PR: nothing is billed, paid, or owed -- the free-giveaway stock effect
  -- itself still waits for approve_sale() like any other line item.
  IF v_is_pr THEN
    v_discount := 0; v_vat := 0; v_amount_paid := 0;
    v_grand := 0; v_balance := 0;
  ELSE
    v_grand := GREATEST(v_subtotal - v_discount + v_vat, 0);
    -- Auto-preview how much of the customer's own advance/credit would
    -- cover the rest, same formula approve_sale() finalizes with -- so the
    -- balance shown here (and on the printed invoice) is already accurate,
    -- not something that changes surprisingly once a manager approves it.
    IF v_customer IS NOT NULL THEN
      SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_customer;
      v_apply_credit := LEAST(GREATEST(v_grand - v_amount_paid, 0), COALESCE(v_customer_credit, 0));
    END IF;
    v_balance := GREATEST(v_grand - v_amount_paid - v_apply_credit, 0);
  END IF;

  SELECT COALESCE(invoice_prefix,'INV-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'INV-'; END IF;
  v_invoice := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, sales_rep_id,
                    remarks, created_by, is_pr, status, pending_payments, credit_applied)
  VALUES (v_factory, v_invoice, v_sale_date, v_customer, v_customer_name, v_customer_phone, v_customer_address,
          v_subtotal, v_discount, v_vat, v_grand, v_amount_paid, v_balance, v_payment_method, v_sales_person, v_sales_rep,
          v_remarks, v_uid, v_is_pr, 'pending_approval', v_payments, v_apply_credit)
  RETURNING id INTO v_sale_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);

    v_mode := NULLIF(v_item->>'jar_mode', '');
    SELECT * INTO v_jug FROM public._product_jug(v_product.id);
    v_jar := 0;
    IF v_mode = 'permanent' THEN
      v_price := v_jug.with_jar_price * v_jug.per_unit;
      v_jar := v_jug.jar_price * v_jug.per_unit;
    END IF;

    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total, jar_mode, jar_unit_price)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_qty * v_price, v_mode, v_jar);
  END LOOP;

  PERFORM public.record_workflow_action('sales', v_sale_id, 'submit', NULL, 'pending_approval', v_remarks);

  -- The retail outlet's sales need no approval: post now (stock out of the
  -- outlet, receipts, debt, ledger), in this same transaction.
  IF v_sales_rep IS NOT NULL AND v_rep_row.kind = 'outlet' THEN
    v_post := public._post_sale(v_sale_id, 'Retail outlet sale - posted automatically');
    RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                              'subtotal', v_subtotal, 'grand_total', v_grand,
                              'balance', v_post->'balance', 'status', 'posted');
  END IF;

  -- A Warehouse posting to a distributor (20261029140000) doesn't wait on
  -- Accounts either: posted now, so the goods leave Warehouse stock at once.
  -- Accounts confirms it and the payment later (assess_posting).
  IF public.is_warehouse_posting((SELECT s FROM sales s WHERE s.id = v_sale_id)) THEN
    v_post := public._post_sale(v_sale_id, 'Warehouse posting - stock out at once; Accounts confirms payment');
    RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                              'subtotal', v_subtotal, 'grand_total', v_grand,
                              'balance', v_post->'balance', 'status', 'posted');
  END IF;

  RETURN jsonb_build_object('sale_id', v_sale_id, 'invoice_number', v_invoice,
                            'subtotal', v_subtotal, 'grand_total', v_grand, 'balance', v_balance,
                            'status', 'pending_approval');
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;

-- ============ 3. Jugs moved by the line's jar mode ============
-- As 20260928140000 for lines without a jar mode. With one:
--   swap          no move (an empty came in for the full one)
--   return_later  seller -> customer / walk-in ('sale'): the empty is owed
--   permanent     seller -> external ('jar_sold'): sold, out of the company
-- A posted sale deleted undoes both kinds of move.
CREATE OR REPLACE FUNCTION public._containers_on_sale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item RECORD;
  v_from text;
  v_to text;
BEGIN
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' AND NEW.deleted_at IS NULL THEN
    v_from := CASE WHEN NEW.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'warehouse' END;
    v_to := CASE WHEN NEW.customer_id IS NOT NULL THEN 'customer' ELSE 'walk_in' END;
    FOR v_item IN SELECT product_id, quantity, jar_mode FROM sale_items WHERE sale_id = NEW.id LOOP
      IF v_item.jar_mode IS NULL THEN
        PERFORM public._container_move_for_product(NEW.factory_id, v_item.product_id, v_item.quantity,
          v_from, NEW.sales_rep_id, v_to, NEW.customer_id,
          'sale', NEW.invoice_number, NEW.id, NULL, NULL, NULL);
      ELSIF v_item.jar_mode IN ('return_later', 'permanent') THEN
        INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                        source, reference, sale_id, created_by, product_id, notes)
        SELECT NEW.factory_id, j.container_type_id, v_from, NEW.sales_rep_id,
               CASE WHEN v_item.jar_mode = 'permanent' THEN 'external' ELSE v_to END,
               CASE WHEN v_item.jar_mode = 'permanent' THEN NULL ELSE NEW.customer_id END,
               v_item.quantity * j.per_unit,
               CASE WHEN v_item.jar_mode = 'permanent' THEN 'jar_sold' ELSE 'sale' END,
               NEW.invoice_number, NEW.id, auth.uid(), v_item.product_id,
               CASE WHEN v_item.jar_mode = 'permanent' THEN 'Jar sold with the water' ELSE 'Empty to be returned' END
          FROM public._product_jug(v_item.product_id) j;
      END IF;
    END LOOP;
  ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.status = 'posted' THEN
    PERFORM public._container_undo('sale_id', NEW.id, 'sale', 'sale_reversal');
    PERFORM public._container_undo('sale_id', NEW.id, 'jar_sold', 'jar_sold_reversal');
  END IF;
  RETURN NEW;
END;
$$;

-- ============ 4. What customers owe the shop ============
-- Per return-later sale and jug type: jugs that left with the customer, how
-- many came back, and what is still owed.
CREATE OR REPLACE FUNCTION public._jar_obligations(p_factory uuid)
RETURNS TABLE(outlet_id uuid, sale_id uuid, container_type_id uuid, quantity_out numeric, quantity_returned numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.sales_rep_id, s.id, m.container_type_id,
         SUM(CASE WHEN m.source = 'sale' THEN m.quantity WHEN m.source = 'sale_reversal' THEN -m.quantity ELSE 0 END),
         SUM(CASE WHEN m.source = 'customer_return' THEN m.quantity ELSE 0 END)
    FROM container_movements m
    JOIN sales s ON s.id = m.sale_id
   WHERE m.factory_id = p_factory
     AND m.source IN ('sale', 'sale_reversal', 'customer_return')
     AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.jar_mode = 'return_later')
     AND (m.source = 'customer_return'
          OR EXISTS (SELECT 1 FROM sale_items si
                      WHERE si.sale_id = s.id AND si.product_id = m.product_id AND si.jar_mode = 'return_later'))
   GROUP BY 1, 2, 3;
$$;
REVOKE ALL ON FUNCTION public._jar_obligations(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._jar_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._jug_can_view()
      OR public.has_permission(auth.uid(), 'sales'::module_key, 'read'::action_key)
      OR public.has_permission(auth.uid(), 'sales'::module_key, 'write'::action_key);
$$;
REVOKE ALL ON FUNCTION public._jar_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._jar_can_view() TO authenticated;

-- The shop's open return-later sales (still owing), newest first; p_search
-- matches the invoice, customer name or phone.
CREATE OR REPLACE FUNCTION public.shop_jar_obligations(p_outlet uuid, p_search text DEFAULT NULL)
RETURNS TABLE(sale_id uuid, invoice_number text, sale_date date, customer_id uuid, customer_name text,
              customer_phone text, container_type_id uuid, container_name text,
              quantity_out numeric, quantity_returned numeric, outstanding numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_factory uuid := (SELECT factory_id FROM sales_reps WHERE id = p_outlet);
BEGIN
  IF NOT public._jar_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT s.id, s.invoice_number, s.sale_date, s.customer_id,
         COALESCE(NULLIF(btrim(s.customer_name), ''), 'Walk-in')::text, s.customer_phone,
         o.container_type_id, ct.name, o.quantity_out, o.quantity_returned, o.quantity_out - o.quantity_returned
    FROM public._jar_obligations(v_factory) o
    JOIN sales s ON s.id = o.sale_id
    JOIN container_types ct ON ct.id = o.container_type_id
   WHERE o.outlet_id = p_outlet AND o.quantity_out - o.quantity_returned > 0
     AND (p_search IS NULL OR btrim(p_search) = ''
          OR s.invoice_number ILIKE '%' || btrim(p_search) || '%'
          OR s.customer_name ILIKE '%' || btrim(p_search) || '%'
          OR s.customer_phone ILIKE '%' || btrim(p_search) || '%')
   ORDER BY s.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.shop_jar_obligations(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shop_jar_obligations(uuid, text) TO authenticated;

-- ============ 5. Empties customers bring back to the shop ============
CREATE TABLE IF NOT EXISTS public.jar_customer_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  return_number text NOT NULL UNIQUE,
  outlet_id uuid NOT NULL REFERENCES public.sales_reps(id),
  sale_id uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  customer_name text,
  container_type_id uuid NOT NULL REFERENCES public.container_types(id),
  quantity_good integer NOT NULL DEFAULT 0 CHECK (quantity_good >= 0),
  quantity_damaged integer NOT NULL DEFAULT 0 CHECK (quantity_damaged >= 0),
  -- Applied to what the customer owed; the rest is excess, waiting for approval.
  quantity_applied integer NOT NULL DEFAULT 0 CHECK (quantity_applied >= 0),
  excess_quantity integer NOT NULL DEFAULT 0 CHECK (excess_quantity >= 0),
  excess_status text NOT NULL DEFAULT 'none' CHECK (excess_status IN ('none', 'pending', 'approved', 'rejected')),
  excess_reason text,
  excess_decided_by uuid REFERENCES auth.users(id),
  excess_decided_at timestamptz,
  notes text,
  client_ref text UNIQUE,
  recorded_by uuid REFERENCES auth.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity_good + quantity_damaged > 0),
  CHECK (quantity_applied + excess_quantity = quantity_good + quantity_damaged)
);
CREATE INDEX IF NOT EXISTS jar_customer_returns_outlet_idx ON public.jar_customer_returns (outlet_id, recorded_at);
GRANT SELECT ON public.jar_customer_returns TO authenticated;
GRANT ALL ON public.jar_customer_returns TO service_role;
ALTER TABLE public.jar_customer_returns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "jar customer returns read" ON public.jar_customer_returns;
CREATE POLICY "jar customer returns read" ON public.jar_customer_returns FOR SELECT TO authenticated
  USING (public._jar_can_view());
-- No write policy: rows are only written by the functions below.

-- payload: outlet_id, container_type_id, quantity_good, quantity_damaged,
--          sale_id or customer_id (whose return-later sales it settles,
--          oldest first), customer_name, notes, client_ref (a resubmit
--          returns the first instead of posting twice).
-- Empties up to what is owed come back to the shop at once; more than that
-- is credited to no one and waits for a manager (decide_jar_return_excess).
CREATE OR REPLACE FUNCTION public.record_customer_jar_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_outlet sales_reps%ROWTYPE;
  v_type uuid := NULLIF(payload->>'container_type_id', '')::uuid;
  v_sale uuid := NULLIF(payload->>'sale_id', '')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id', '')::uuid;
  v_good int := COALESCE(NULLIF(payload->>'quantity_good', '')::int, 0);
  v_damaged int := COALESCE(NULLIF(payload->>'quantity_damaged', '')::int, 0);
  v_ref text := NULLIF(btrim(COALESCE(payload->>'client_ref', '')), '');
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_left int;
  v_take int;
  v_applied int := 0;
  v_ob record;
  v_number text;
  v_id uuid;
  v_name text;
  v_existing jar_customer_returns%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_ref IS NOT NULL THEN
    SELECT * INTO v_existing FROM jar_customer_returns WHERE client_ref = v_ref;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_existing.id, 'return_number', v_existing.return_number,
                                'applied', v_existing.quantity_applied, 'excess', v_existing.excess_quantity,
                                'duplicate', true);
    END IF;
  END IF;
  -- One return at a time per shop, so two tills can't settle the same jug.
  SELECT * INTO v_outlet FROM sales_reps WHERE id = NULLIF(payload->>'outlet_id', '')::uuid FOR UPDATE;
  IF NOT FOUND OR v_outlet.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail shop not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = v_type AND factory_id = v_outlet.factory_id) THEN
    RAISE EXCEPTION 'Jug type not found';
  END IF;
  IF v_good < 0 OR v_damaged < 0 OR v_good + v_damaged = 0 THEN
    RAISE EXCEPTION 'Enter how many empties came back (good and/or damaged)';
  END IF;
  IF v_sale IS NOT NULL THEN
    v_customer := (SELECT customer_id FROM sales WHERE id = v_sale AND sales_rep_id = v_outlet.id);
    v_name := (SELECT COALESCE(NULLIF(btrim(customer_name), ''), 'Walk-in') FROM sales
                WHERE id = v_sale AND sales_rep_id = v_outlet.id);
    IF v_name IS NULL THEN RAISE EXCEPTION 'That sale is not this shop''s'; END IF;
  ELSIF v_customer IS NOT NULL THEN
    v_name := (SELECT name FROM customers WHERE id = v_customer);
  END IF;

  v_number := 'JRN-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  v_left := v_good + v_damaged;
  IF v_sale IS NOT NULL OR v_customer IS NOT NULL THEN
    FOR v_ob IN
      SELECT o.sale_id, s.customer_id, o.quantity_out - o.quantity_returned AS owed
        FROM public._jar_obligations(v_outlet.factory_id) o
        JOIN sales s ON s.id = o.sale_id
       WHERE o.outlet_id = v_outlet.id AND o.container_type_id = v_type
         AND o.quantity_out - o.quantity_returned > 0
         AND (o.sale_id = v_sale OR (v_sale IS NULL AND s.customer_id = v_customer))
       ORDER BY s.created_at
    LOOP
      EXIT WHEN v_left = 0;
      v_take := LEAST(v_left, v_ob.owed::int);
      INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                      source, reference, sale_id, created_by, notes)
      VALUES (v_outlet.factory_id, v_type,
              CASE WHEN v_ob.customer_id IS NOT NULL THEN 'customer' ELSE 'walk_in' END, v_ob.customer_id,
              'sales_rep', v_outlet.id, v_take, 'customer_return', v_number, v_ob.sale_id, v_uid,
              'Empty returned by the customer');
      v_applied := v_applied + v_take;
      v_left := v_left - v_take;
    END LOOP;
  END IF;

  INSERT INTO jar_customer_returns(factory_id, return_number, outlet_id, sale_id, customer_id, customer_name,
                                   container_type_id, quantity_good, quantity_damaged, quantity_applied,
                                   excess_quantity, excess_status, notes, client_ref, recorded_by)
  VALUES (v_outlet.factory_id, v_number, v_outlet.id, v_sale, v_customer,
          COALESCE(v_name, NULLIF(btrim(COALESCE(payload->>'customer_name', '')), ''), 'Walk-in'),
          v_type, v_good, v_damaged, v_applied, v_left, CASE WHEN v_left > 0 THEN 'pending' ELSE 'none' END,
          v_notes, v_ref, v_uid)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_outlet.factory_id, 'customer_jar_return', 'jar_customer_returns', v_id::text,
          jsonb_build_object('return_number', v_number, 'sale_id', v_sale, 'customer_id', v_customer,
                             'good', v_good, 'damaged', v_damaged, 'applied', v_applied, 'excess', v_left));
  RETURN jsonb_build_object('id', v_id, 'return_number', v_number, 'applied', v_applied, 'excess', v_left,
                            'duplicate', false);
END;
$$;
REVOKE ALL ON FUNCTION public.record_customer_jar_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_jar_return(jsonb) TO authenticated;

-- A manager (not the person who recorded it) accepts or refuses empties that
-- came back beyond what was owed. Accepted: into the shop's jugs from outside
-- the books (jars the company had no record of), not from any customer.
CREATE OR REPLACE FUNCTION public.decide_jar_return_excess(p_id uuid, p_approve boolean, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row jar_customer_returns%ROWTYPE;
BEGIN
  IF NOT (public.is_admin(v_uid) OR public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key)) THEN
    RAISE EXCEPTION 'Only a manager can decide on extra empties';
  END IF;
  SELECT * INTO v_row FROM jar_customer_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  IF v_row.excess_status <> 'pending' THEN RAISE EXCEPTION 'This return has nothing waiting for a decision'; END IF;
  IF v_row.recorded_by = v_uid THEN RAISE EXCEPTION 'Someone other than the person who recorded it must decide'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;

  IF p_approve THEN
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                    source, reference, created_by, notes)
    VALUES (v_row.factory_id, v_row.container_type_id, 'external', NULL, 'sales_rep', v_row.outlet_id,
            v_row.excess_quantity, 'customer_return', v_row.return_number, v_uid,
            'Extra empties accepted (not owed on any sale): ' || p_reason);
  END IF;
  UPDATE jar_customer_returns
     SET excess_status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         excess_reason = p_reason, excess_decided_by = v_uid, excess_decided_at = now()
   WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, CASE WHEN p_approve THEN 'approve' ELSE 'reject' END, 'jar_customer_returns',
          p_id::text, jsonb_build_object('excess', v_row.excess_quantity, 'reason', p_reason));
END;
$$;
REVOKE ALL ON FUNCTION public.decide_jar_return_excess(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_jar_return_excess(uuid, boolean, text) TO authenticated;

-- ============ 6. The shop's jug figures ============
-- Per jug type, for one shop. Now: filled on the shelf, empties at the shop
-- (all jugs it holds less the filled ones), still owed by customers, extra
-- empties waiting for a decision, empties sent to the Warehouse not yet
-- confirmed. Over p_from..p_to: filled received, sold by jar choice,
-- empties back from customers (good / damaged), empties sent to and
-- confirmed by the Warehouse.
CREATE OR REPLACE FUNCTION public.shop_jar_summary(p_outlet uuid, p_from date, p_to date)
RETURNS TABLE(container_type_id uuid, container_name text, jar_price numeric, with_jar_price numeric,
              filled_on_hand numeric, empties_at_shop numeric, owed_by_customers numeric,
              excess_pending numeric, sent_unconfirmed numeric,
              filled_received numeric, sold_swap numeric, sold_return_later numeric, sold_permanent numeric,
              returned_good numeric, returned_damaged numeric, sent_to_warehouse numeric,
              confirmed_by_warehouse numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_factory uuid := (SELECT factory_id FROM sales_reps WHERE id = p_outlet);
BEGIN
  IF NOT public._jar_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH t AS (
    SELECT ct.id, ct.name, ct.jar_price, ct.with_jar_price FROM container_types ct
     WHERE ct.factory_id = v_factory AND ct.active AND ct.name ~* 'jug'
  ), held AS (
    SELECT b.container_type_id AS id, SUM(b.balance) AS qty FROM container_balances b
     WHERE b.holder_type = 'sales_rep' AND b.holder_id = p_outlet GROUP BY 1
  ), filled AS (
    SELECT j.container_type_id AS id, SUM(rs.quantity * j.per_unit) AS qty
      FROM rep_stock rs, LATERAL public._product_jug(rs.product_id) j
     WHERE rs.sales_rep_id = p_outlet AND rs.quantity > 0 GROUP BY 1
  ), owed AS (
    SELECT o.container_type_id AS id, SUM(o.quantity_out - o.quantity_returned) AS qty
      FROM public._jar_obligations(v_factory) o WHERE o.outlet_id = p_outlet GROUP BY 1
  ), mv AS (
    SELECT m.container_type_id AS id,
           SUM(CASE WHEN m.source = 'dispatch' AND m.to_id = p_outlet THEN m.quantity
                    WHEN m.source = 'dispatch_reversal' AND m.from_id = p_outlet THEN -m.quantity ELSE 0 END) AS recv
      FROM container_movements m
     WHERE m.factory_id = v_factory AND (m.to_id = p_outlet OR m.from_id = p_outlet)
       AND public._jug_day(m.created_at) BETWEEN p_from AND p_to
     GROUP BY 1
  ), sold AS (
    SELECT j.container_type_id AS id,
           SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'swap') AS swap,
           SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'return_later') AS later,
           SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'permanent') AS perm
      FROM sales s JOIN sale_items si ON si.sale_id = s.id, LATERAL public._product_jug(si.product_id) j
     WHERE s.sales_rep_id = p_outlet AND s.status = 'posted' AND s.deleted_at IS NULL
       AND public._jug_day(COALESCE(s.approved_at, s.created_at)) BETWEEN p_from AND p_to
     GROUP BY 1
  ), back AS (
    SELECT r.container_type_id AS id, SUM(r.quantity_good)::numeric AS good, SUM(r.quantity_damaged)::numeric AS damaged,
           NULL::numeric AS unused
      FROM jar_customer_returns r
     WHERE r.outlet_id = p_outlet AND public._jug_day(r.recorded_at) BETWEEN p_from AND p_to
     GROUP BY 1
  ), pend AS (
    SELECT r.container_type_id AS id, SUM(r.excess_quantity)::numeric AS qty FROM jar_customer_returns r
     WHERE r.outlet_id = p_outlet AND r.excess_status = 'pending' GROUP BY 1
  ), sent AS (
    SELECT j.container_type_id AS id,
           SUM(j.quantity_claimed) FILTER (WHERE public._jug_day(j.recorded_at) BETWEEN p_from AND p_to) AS sent,
           SUM(COALESCE(j.quantity_received, 0)) FILTER (WHERE j.status = 'verified'
                AND public._jug_day(COALESCE(j.verified_at, j.recorded_at)) BETWEEN p_from AND p_to) AS conf,
           SUM(j.quantity_claimed) FILTER (WHERE j.status = 'pending') AS unconf
      FROM jug_returns j
     WHERE j.sales_rep_id = p_outlet AND j.status <> 'cancelled'
     GROUP BY 1
  )
  SELECT t.id, t.name, t.jar_price, t.with_jar_price,
         COALESCE(f.qty, 0), COALESCE(h.qty, 0) - COALESCE(f.qty, 0), COALESCE(ow.qty, 0),
         COALESCE(pd.qty, 0), COALESCE(se.unconf, 0),
         COALESCE(mv.recv, 0), COALESCE(so.swap, 0), COALESCE(so.later, 0), COALESCE(so.perm, 0),
         COALESCE(bk.good, 0), COALESCE(bk.damaged, 0), COALESCE(se.sent, 0), COALESCE(se.conf, 0)
    FROM t
    LEFT JOIN held h ON h.id = t.id
    LEFT JOIN filled f ON f.id = t.id
    LEFT JOIN owed ow ON ow.id = t.id
    LEFT JOIN mv ON mv.id = t.id
    LEFT JOIN sold so ON so.id = t.id
    LEFT JOIN back bk ON bk.id = t.id
    LEFT JOIN pend pd ON pd.id = t.id
    LEFT JOIN sent se ON se.id = t.id
   ORDER BY t.name;
END;
$$;
REVOKE ALL ON FUNCTION public.shop_jar_summary(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shop_jar_summary(uuid, date, date) TO authenticated;

-- ============ 7. Jug reports count the new moves ============
-- As 20261020200000, plus: a jar sold for good counts as a jug that left with
-- water, and empties customers bring back to a shop come off it (Jug + Water
-- Sold is net of them), so the shop's Outstanding still equals its ledger
-- balance. Jars sold are not counted as written off.
CREATE OR REPLACE FUNCTION public.jug_accountability_report(
  p_factory uuid, p_from date, p_to date, p_container_type uuid DEFAULT NULL
) RETURNS TABLE (
  report_date date, sales_rep_id uuid, rep_code text, rep_name text, rep_kind text,
  container_type_id uuid, container_name text,
  opening numeric, loaded numeric, total numeric, jug_water_sold numeric, refills_sold numeric,
  empties_sold numeric, empties_value numeric, returned numeric, pending_claims numeric,
  expected_empties numeric, received numeric, written_off numeric, outstanding numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._jug_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to < p_from THEN RAISE EXCEPTION 'The end date is before the start date'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT CASE WHEN m.to_type = 'sales_rep' THEN m.to_id ELSE m.from_id END AS rep_id,
           m.container_type_id AS type_id, public._jug_day(m.created_at) AS d, m.source,
           CASE WHEN m.to_type = 'sales_rep' THEN m.quantity ELSE -m.quantity END AS delta,
           m.quantity AS qty, pc.jug_role
      FROM container_movements m
      LEFT JOIN product_containers pc ON pc.product_id = m.product_id AND pc.container_type_id = m.container_type_id
     WHERE m.factory_id = p_factory
       AND (p_container_type IS NULL OR m.container_type_id = p_container_type)
       AND (m.to_type = 'sales_rep' OR m.from_type = 'sales_rep')
       AND public._jug_day(m.created_at) <= p_to
  ), opening AS (
    SELECT rep_id, type_id, SUM(delta) AS bal FROM mv WHERE d < p_from GROUP BY 1, 2
  ), day_mv AS (
    SELECT rep_id, type_id, d,
           SUM(CASE WHEN source IN ('dispatch', 'issue') THEN qty WHEN source = 'dispatch_reversal' THEN -qty ELSE 0 END) AS loaded,
           SUM(CASE WHEN source = 'sale' AND COALESCE(jug_role, 'with_water') <> 'empty' THEN qty
                    WHEN source = 'sale_reversal' AND COALESCE(jug_role, 'with_water') <> 'empty' THEN -qty
                    WHEN source = 'jar_sold' THEN qty WHEN source = 'jar_sold_reversal' THEN -qty
                    WHEN source = 'customer_return' THEN -qty ELSE 0 END) AS jw,
           SUM(CASE WHEN source = 'sale' AND jug_role = 'empty' THEN qty
                    WHEN source = 'sale_reversal' AND jug_role = 'empty' THEN -qty ELSE 0 END) AS es,
           SUM(CASE WHEN source IN ('return', 'rep_return') THEN qty WHEN source = 'rep_return_cancelled' THEN -qty ELSE 0 END) AS rcv,
           SUM(CASE WHEN source = 'lost' THEN qty ELSE 0 END) AS wo,
           SUM(delta) AS net
      FROM mv WHERE d BETWEEN p_from AND p_to GROUP BY 1, 2, 3
  ), claims AS (
    SELECT j.sales_rep_id AS rep_id, j.container_type_id AS type_id, public._jug_day(j.recorded_at) AS d,
           SUM(j.quantity_claimed) AS claimed,
           SUM(j.quantity_claimed) FILTER (WHERE j.status = 'pending') AS pending
      FROM jug_returns j
     WHERE j.factory_id = p_factory AND j.status <> 'cancelled'
       AND (p_container_type IS NULL OR j.container_type_id = p_container_type)
       AND public._jug_day(j.recorded_at) BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3
  ), sales_info AS (
    -- Refills (swaps) and the value of empty jugs sold, from posted invoices.
    SELECT s.sales_rep_id AS rep_id, pc.container_type_id AS type_id, public._jug_day(COALESCE(s.approved_at, s.created_at)) AS d,
           SUM(CASE WHEN pc.jug_role = 'refill' THEN si.quantity * pc.quantity_per_unit ELSE 0 END) AS refills,
           SUM(CASE WHEN pc.jug_role = 'empty' THEN si.line_total ELSE 0 END) AS empties_value
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN product_containers pc ON pc.product_id = si.product_id AND pc.jug_role IS NOT NULL
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NOT NULL AND s.status = 'posted' AND s.deleted_at IS NULL
       AND (p_container_type IS NULL OR pc.container_type_id = p_container_type)
       AND public._jug_day(COALESCE(s.approved_at, s.created_at)) BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3
  ), grid AS (
    SELECT r.id AS rep_id, ct.id AS type_id, g.d::date AS d
      FROM sales_reps r
      CROSS JOIN container_types ct
      CROSS JOIN generate_series(p_from, p_to, interval '1 day') g(d)
     WHERE r.factory_id = p_factory AND ct.factory_id = p_factory
       AND (p_container_type IS NULL OR ct.id = p_container_type)
  ), calc AS (
    SELECT g.d, g.rep_id, g.type_id,
           COALESCE(o.bal, 0)
             + COALESCE((SELECT SUM(x.net) FROM day_mv x
                          WHERE x.rep_id = g.rep_id AND x.type_id = g.type_id AND x.d < g.d), 0) AS opening,
           COALESCE(dm.loaded, 0) AS loaded, COALESCE(dm.jw, 0) AS jw, COALESCE(si.refills, 0) AS refills,
           COALESCE(dm.es, 0) AS es, COALESCE(si.empties_value, 0) AS ev,
           COALESCE(c.claimed, 0) AS claimed, COALESCE(c.pending, 0) AS pending,
           COALESCE(dm.rcv, 0) AS rcv, COALESCE(dm.wo, 0) AS wo,
           (dm.rep_id IS NOT NULL OR c.rep_id IS NOT NULL OR si.rep_id IS NOT NULL) AS active
      FROM grid g
      LEFT JOIN opening o ON o.rep_id = g.rep_id AND o.type_id = g.type_id
      LEFT JOIN day_mv dm ON dm.rep_id = g.rep_id AND dm.type_id = g.type_id AND dm.d = g.d
      LEFT JOIN claims c ON c.rep_id = g.rep_id AND c.type_id = g.type_id AND c.d = g.d
      LEFT JOIN sales_info si ON si.rep_id = g.rep_id AND si.type_id = g.type_id AND si.d = g.d
  )
  SELECT c.d, r.id, r.code, r.full_name, r.kind, ct.id, ct.name,
         c.opening, c.loaded, c.opening + c.loaded, c.jw, c.refills, c.es, c.ev, c.claimed, c.pending,
         c.opening + c.loaded - c.jw - c.es,
         c.rcv, c.wo,
         c.opening + c.loaded - c.jw - c.es - c.rcv - c.wo
    FROM calc c
    JOIN sales_reps r ON r.id = c.rep_id
    JOIN container_types ct ON ct.id = c.type_id
   WHERE c.active OR c.opening <> 0
   ORDER BY c.d, r.code, ct.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_accountability_report(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_accountability_report(uuid, date, date, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.jug_overview(p_factory uuid, p_from date, p_to date)
RETURNS TABLE (
  container_type_id uuid, container_name text,
  in_circulation numeric, in_warehouse numeric, filled_in_warehouse numeric, empty_in_warehouse numeric,
  with_marketers numeric, full_with_marketers numeric, with_customers numeric, written_off_total numeric,
  pending_returns numeric, produced_approved numeric, issued numeric, sold_with_water numeric,
  empties_sold numeric, refills_sold numeric, received numeric, empties_value numeric, written_off numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._jug_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH bal AS (
    SELECT b.container_type_id AS type_id, b.holder_type, SUM(b.balance) AS qty
      FROM container_balances b WHERE b.factory_id = p_factory GROUP BY 1, 2
  ), per AS (
    SELECT ct.id AS type_id, ct.name,
           COALESCE((SELECT SUM(qty) FROM bal WHERE type_id = ct.id AND holder_type <> 'external'), 0) AS circ,
           COALESCE((SELECT qty FROM bal WHERE type_id = ct.id AND holder_type = 'warehouse'), 0) AS wh,
           COALESCE((SELECT SUM(p.current_stock * pc.quantity_per_unit) FROM product_containers pc
                      JOIN products p ON p.id = pc.product_id
                     WHERE pc.container_type_id = ct.id AND COALESCE(pc.jug_role, 'with_water') <> 'empty'), 0) AS filled,
           COALESCE((SELECT qty FROM bal WHERE type_id = ct.id AND holder_type = 'sales_rep'), 0) AS reps,
           COALESCE((SELECT SUM(rs.quantity * pc.quantity_per_unit) FROM rep_stock rs
                      JOIN product_containers pc ON pc.product_id = rs.product_id AND pc.container_type_id = ct.id
                     WHERE rs.factory_id = p_factory AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
                       AND rs.quantity > 0), 0) AS reps_full,
           COALESCE((SELECT SUM(qty) FROM bal WHERE type_id = ct.id AND holder_type IN ('customer', 'walk_in')), 0) AS cust,
           COALESCE((SELECT SUM(m.quantity) FROM container_movements m
                      WHERE m.container_type_id = ct.id AND m.to_type = 'external' AND m.source <> 'jar_sold'), 0)
             - COALESCE((SELECT SUM(m.quantity) FROM container_movements m
                          WHERE m.container_type_id = ct.id AND m.from_type = 'external'
                            AND m.source NOT IN ('purchase', 'jar_sold_reversal', 'customer_return')), 0) AS wo_total,
           COALESCE((SELECT SUM(j.quantity_claimed) FROM jug_returns j
                      WHERE j.container_type_id = ct.id AND j.status = 'pending'), 0) AS pend,
           COALESCE((SELECT SUM(pr.accepted_quantity * pc.quantity_per_unit) FROM production_releases pr
                      JOIN product_containers pc ON pc.product_id = pr.product_id AND pc.container_type_id = ct.id
                     WHERE pr.factory_id = p_factory AND pr.status = 'accepted'
                       AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
                       AND public._jug_day(COALESCE(pr.accepted_at, pr.created_at)) BETWEEN p_from AND p_to), 0) AS produced
      FROM container_types ct WHERE ct.factory_id = p_factory
  ), act AS (
    SELECT r.container_type_id AS type_id,
           SUM(r.loaded) AS issued, SUM(r.jug_water_sold) AS jw, SUM(r.empties_sold) AS es,
           SUM(r.refills_sold) AS refills, SUM(r.received) AS rcv, SUM(r.empties_value) AS ev, SUM(r.written_off) AS wo
      FROM public.jug_accountability_report(p_factory, p_from, p_to, NULL) r
     GROUP BY 1
  )
  SELECT per.type_id, per.name, per.circ, per.wh, per.filled, per.wh - per.filled, per.reps, per.reps_full,
         per.cust, per.wo_total, per.pend, per.produced,
         COALESCE(act.issued, 0), COALESCE(act.jw, 0), COALESCE(act.es, 0), COALESCE(act.refills, 0),
         COALESCE(act.rcv, 0), COALESCE(act.ev, 0), COALESCE(act.wo, 0)
    FROM per LEFT JOIN act ON act.type_id = per.type_id
   ORDER BY per.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_overview(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_overview(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
