-- ============================================================================
-- Record sold Jug + Water: limited by the dispensers supplied, not the jug
-- ledger
-- ----------------------------------------------------------------------------
-- User (2026-11-18): the Warehouse tried "Record sold Jug + Water" for
-- BRITISH HIGH COMMISSION (Dispenser Water x 681 supplied and still out) and
-- got "BRITISH HIGH COMMISSION holds only 0 jugs -- record no more than that
-- as sold".
--
-- Why: since 20261112120000 a N1,200 Dispenser Water line is saved as a
-- 'swap' (empty handed in), and a swap puts no jug on the customer's jug
-- ledger. record_sold_dispenser_jugs capped the quantity by that ledger, so a
-- distributor supplied only Dispenser Water always "held" 0 jugs.
--
-- Now the cap is what was really supplied:
--     Dispenser Water supplied to the customer (any line not already sold as
--       Jug + Water), in jugs
--   - unsold dispensers they returned
--   - empty jugs they returned (jug ledger, source 'return')
--   - jugs already recorded sold this way
-- or the jug-ledger balance, whichever is larger (older ledger-tracked sales
-- keep working).
-- The ledger 'count' entry (customer -> Warehouse) is written only for jugs
-- that were on the customer's ledger, so a swap-supplied customer is never
-- left with a minus jug balance. Billing, invoice and stock are as before.
-- Paste into the Supabase SQL Editor. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._customer_jugs_sellable(p_customer uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH supplied AS (
    SELECT COALESCE(SUM(si.quantity * j.per_unit), 0) AS q
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      CROSS JOIN LATERAL public._product_jug(si.product_id) j
     WHERE s.customer_id = p_customer AND s.status = 'posted' AND s.deleted_at IS NULL
       AND NOT COALESCE(s.is_pr, false)
       AND si.jar_mode IS DISTINCT FROM 'permanent'
  ), back AS (
    SELECT COALESCE(SUM(r.quantity_returned * j.per_unit), 0) AS q
      FROM sales_returns r
      JOIN sales s ON s.id = r.sale_id
      CROSS JOIN LATERAL public._product_jug(r.product_id) j
     WHERE s.customer_id = p_customer AND r.status <> 'cancelled'
       AND EXISTS (SELECT 1 FROM sale_items si
                    WHERE si.sale_id = r.sale_id AND si.product_id = r.product_id
                      AND si.jar_mode IS DISTINCT FROM 'permanent')
  ), empties AS (
    SELECT COALESCE(SUM(m.quantity), 0) AS q
      FROM container_movements m
      JOIN container_types ct ON ct.id = m.container_type_id
     WHERE m.from_type = 'customer' AND m.from_id = p_customer AND m.source = 'return'
       AND ct.name ~* 'jug|dispenser'
  ), sold AS (
    SELECT COALESCE(SUM((a.new_value->>'quantity')::numeric), 0) AS q
      FROM audit_logs a
      JOIN sales s ON s.id::text = a.entity_id
     WHERE a.action = 'record_sold_dispenser_jugs' AND s.customer_id = p_customer
       AND s.deleted_at IS NULL AND s.status = 'posted'
  )
  SELECT GREATEST(supplied.q - back.q - empties.q - sold.q, 0)
    FROM supplied, back, empties, sold;
$$;
REVOKE ALL ON FUNCTION public._customer_jugs_sellable(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_sold_dispenser_jugs(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_cust customers%ROWTYPE;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_date date := COALESCE(NULLIF(payload->>'sale_date', '')::date, (now() AT TIME ZONE 'Africa/Lagos')::date);
  v_prod products%ROWTYPE;
  v_type uuid;
  v_held numeric;
  v_cap numeric;
  v_on_ledger numeric;
  v_before numeric;
  v_sale jsonb;
  v_sale_id uuid;
  v_inv text;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_cust FROM customers WHERE id = NULLIF(payload->>'customer_id', '')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_cust.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole number of dispensers above 0'; END IF;
  IF v_date > (now() AT TIME ZONE 'Africa/Lagos')::date THEN RAISE EXCEPTION 'Can''t be dated in the future'; END IF;

  -- The empty-jug product (Empty Jug) and its jug type.
  SELECT p.* INTO v_prod FROM products p JOIN product_containers pc ON pc.product_id = p.id
   WHERE p.factory_id = v_cust.factory_id AND p.active AND pc.jug_role = 'empty'
   ORDER BY p.name LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No empty-jug product is set up (Empty Jug on Costing)'; END IF;
  SELECT pc.container_type_id INTO v_type FROM product_containers pc
   WHERE pc.product_id = v_prod.id AND pc.jug_role = 'empty' LIMIT 1;

  v_held := GREATEST(public._jug_customer_balance(v_cust.id, v_type), 0);
  v_cap := GREATEST(public._customer_jugs_sellable(v_cust.id), v_held);
  IF v_qty > v_cap THEN
    RAISE EXCEPTION '% has only % dispenser jug(s) out (supplied, less returned and already sold) -- record no more than that as sold',
      v_cust.name, trim_scale(v_cap);
  END IF;
  v_on_ledger := LEAST(v_qty, v_held);

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

  -- Jug ledger: posting the sale sent a jug Warehouse -> customer -> outside
  -- ('jar_sold'). Jugs that were already on the customer's ledger give the
  -- Warehouse its one back; swap-supplied jugs were never on it -- the
  -- Warehouse's jug really left with the dispenser.
  IF v_on_ledger > 0 THEN
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, quantity, source,
                                    reference, sale_id, notes, created_by)
    VALUES (v_cust.factory_id, v_type, 'customer', v_cust.id, 'warehouse', v_on_ledger, 'count', v_inv, v_sale_id,
            'Sold on with the water -- kept by their customers', v_uid);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_cust.factory_id, 'record_sold_dispenser_jugs', 'sales', v_sale_id::text,
          jsonb_build_object('customer', v_cust.name, 'quantity', v_qty, 'unit_price', v_prod.unit_price,
                             'invoice_number', v_inv));
  RETURN jsonb_build_object('invoice_number', v_inv, 'quantity', v_qty,
                            'total', v_qty * v_prod.unit_price);
END;
$fn$;
REVOKE ALL ON FUNCTION public.record_sold_dispenser_jugs(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_sold_dispenser_jugs(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
