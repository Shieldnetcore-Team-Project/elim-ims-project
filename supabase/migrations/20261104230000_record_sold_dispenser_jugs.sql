-- ============================================================================
-- Warehouse: "Record sold Dispenser + Water" for a distributor
-- ----------------------------------------------------------------------------
-- User (2026-11-04), Gideon's Warehouse window for a Distributor/Office
-- Delivery customer: replace "Return empty Dispenser Jugs" with "Record sold
-- Dispenser + Water" -- the distributor sold dispensers with the jug (their
-- customer keeps it), so the jugs will not come back. Decision: each jug is
-- charged at the empty-jug price (Dispenser Empty on Costing), on an invoice
-- Accounts confirms like any Warehouse posting; the jugs stop being owed.
--
-- record_sold_dispenser_jugs(payload {customer_id, quantity, sale_date?}):
--   * never more than the jugs the customer holds (_jug_customer_balance);
--   * the invoice: a Warehouse posting of the empty-jug product x quantity at
--     its price, through create_sale (posted at once, debt, ledger, Accounts'
--     Postings). The jugs are already with the customer, so Warehouse stock
--     is unchanged: the same quantity is booked in just before the sale takes
--     it out (inventory movements, reason says why);
--   * the jug ledger: the sale's own move (Warehouse -> customer) is put back
--     ('count') and the jugs go customer -> outside as sold ('jar_sold').
-- Who: whoever posts to distributors (sales write), with their product rule
-- (Gideon: dispensers). Audited.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_sold_dispenser_jugs(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cust customers%ROWTYPE;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_date date := COALESCE(NULLIF(payload->>'sale_date', '')::date, (now() AT TIME ZONE 'Africa/Lagos')::date);
  v_prod products%ROWTYPE;
  v_type uuid;
  v_held numeric;
  v_before numeric;
  v_sale jsonb;
  v_sale_id uuid;
  v_inv text;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_cust FROM customers WHERE id = NULLIF(payload->>'customer_id', '')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_cust.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole number of dispensers above 0'; END IF;
  IF v_date > (now() AT TIME ZONE 'Africa/Lagos')::date THEN RAISE EXCEPTION 'Can''t be dated in the future'; END IF;

  -- The empty-jug product (Dispenser Empty) and its jug type.
  SELECT p.* INTO v_prod FROM products p JOIN product_containers pc ON pc.product_id = p.id
   WHERE p.factory_id = v_cust.factory_id AND p.active AND pc.jug_role = 'empty'
   ORDER BY p.name LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No empty-jug product is set up (Dispenser Empty on Costing)'; END IF;
  SELECT pc.container_type_id INTO v_type FROM product_containers pc
   WHERE pc.product_id = v_prod.id AND pc.jug_role = 'empty' LIMIT 1;

  v_held := public._jug_customer_balance(v_cust.id, v_type);
  IF v_qty > GREATEST(v_held, 0) THEN
    RAISE EXCEPTION '% holds only % jugs -- record no more than that as sold', v_cust.name, trim_scale(GREATEST(v_held, 0));
  END IF;

  -- Warehouse stock unchanged: booked in, then the sale takes it out.
  SELECT current_stock INTO v_before FROM products WHERE id = v_prod.id FOR UPDATE;
  UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_prod.id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after)
  VALUES (v_cust.factory_id, v_prod.id, 'adjusted', v_qty, 'JUG-SOLD',
          format('Jugs %s sold on with the water -- billed, not taken from stock', v_cust.name), v_uid,
          v_before, v_before + v_qty);

  v_sale := public.create_sale(jsonb_build_object(
    'factory_id', v_cust.factory_id, 'sale_date', v_date, 'customer_id', v_cust.id,
    'customer_name', v_cust.name, 'customer_phone', v_cust.phone, 'amount_paid', 0,
    'remarks', format('%s jug(s) sold on with Dispenser Water -- kept by their customers', trim_scale(v_qty)),
    'items', jsonb_build_array(jsonb_build_object('product_id', v_prod.id, 'quantity', v_qty,
                                                  'unit_price', v_prod.unit_price))));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  IF v_sale->>'status' = 'pending_approval' THEN
    PERFORM public._post_sale(v_sale_id, 'Jugs sold by a distributor - posted at once');
  END IF;
  v_inv := (SELECT invoice_number FROM sales WHERE id = v_sale_id);

  -- Jug ledger: the sale's Warehouse -> customer move put back, then sold.
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, quantity, source,
                                  reference, sale_id, notes, created_by)
  VALUES (v_cust.factory_id, v_type, 'customer', v_cust.id, 'warehouse', v_qty, 'count', v_inv, v_sale_id,
          'The jugs were already with the customer', v_uid),
         (v_cust.factory_id, v_type, 'customer', v_cust.id, 'external', v_qty, 'jar_sold', v_inv, v_sale_id,
          'Sold on with the water -- kept by their customers', v_uid);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_cust.factory_id, 'record_sold_dispenser_jugs', 'sales', v_sale_id::text,
          jsonb_build_object('customer', v_cust.name, 'quantity', v_qty, 'unit_price', v_prod.unit_price,
                             'invoice_number', v_inv));
  RETURN jsonb_build_object('invoice_number', v_inv, 'quantity', v_qty,
                            'total', v_qty * v_prod.unit_price);
END;
$$;
REVOKE ALL ON FUNCTION public.record_sold_dispenser_jugs(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_sold_dispenser_jugs(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
