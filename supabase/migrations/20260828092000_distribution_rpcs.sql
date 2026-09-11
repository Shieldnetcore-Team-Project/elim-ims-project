-- ============================================================================
-- DISTRIBUTION (Sales Reps) — RPCs
-- ----------------------------------------------------------------------------
-- All SECURITY DEFINER, each guarded with has_permission(uid,'distribution',
-- <action>). Reference numbers are generated inline in the same style as
-- create_sales_return (20260820090000).
--
--   create_stock_dispatch    Store -> rep, single step (store stock drops
--                            now, rep van stock rises now)
--   reverse_stock_dispatch   undo a dispatch nothing has consumed yet
--   create_rep_return        rep hands goods back -> status 'received',
--                            rep van stock drops now
--   inspect_rep_return       someone OTHER than the receiver splits the
--                            return accepted/damaged/rejected; only accepted
--                            re-enters store stock; damaged -> damage_records
--   record_rep_remittance    log cash handed in (reconciliation only)
--   rep_account_summary       the rep's account: goods out vs returns vs
--                            damages vs cash vs outstanding credit
--
-- Plus create_sale() re-declared to draw a rep sale down from rep_stock
-- instead of products.current_stock.
-- ============================================================================

-- ============ 1. create_stock_dispatch ============
CREATE OR REPLACE FUNCTION public.create_stock_dispatch(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_rep uuid := (payload->>'sales_rep_id')::uuid;
  v_date date := COALESCE((payload->>'dispatch_date')::date, CURRENT_DATE);
  v_vehicle uuid := NULLIF(payload->>'vehicle_id','')::uuid;
  v_driver uuid := NULLIF(payload->>'driver_id','')::uuid;
  v_route uuid := NULLIF(payload->>'route_id','')::uuid;
  v_notes text := payload->>'notes';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_rep_row public.sales_reps%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
  v_line numeric;
  v_total numeric := 0;
  v_number text;
  v_id uuid;
  v_rep_before numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'No items to dispatch'; END IF;

  SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_rep;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
  IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;
  IF v_rep_row.status <> 'active' THEN RAISE EXCEPTION 'Sales rep is not active'; END IF;

  -- validate every line first (all-or-nothing)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_product.current_stock < v_qty THEN
      RAISE EXCEPTION 'Insufficient store stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
    END IF;
    v_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, v_product.unit_price);
    v_total := v_total + (v_qty * v_price);
  END LOOP;

  v_number := 'DSP-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO stock_dispatches(factory_id, dispatch_number, dispatch_date, sales_rep_id, vehicle_id, driver_id, route_id, total_value, notes, created_by)
  VALUES (v_factory, v_number, v_date, v_rep, v_vehicle, v_driver, v_route, v_total, v_notes, v_uid)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, v_product.unit_price);
    v_line := v_qty * v_price;

    INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value)
    VALUES (v_id, v_product.id, v_qty, v_price, v_line);

    -- store side
    UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product.id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_product.id, 'dispatched_to_rep', v_qty, v_number,
            'Dispatched to ' || v_rep_row.full_name, v_uid, v_product.current_stock, v_product.current_stock - v_qty);

    -- rep side
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_rep AND product_id = v_product.id FOR UPDATE;
    IF NOT FOUND THEN
      v_rep_before := 0;
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity) VALUES (v_rep, v_product.id, v_factory, v_qty);
    ELSE
      UPDATE rep_stock SET quantity = quantity + v_qty, updated_at = now()
       WHERE sales_rep_id = v_rep AND product_id = v_product.id;
    END IF;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_rep, v_product.id, 'dispatch_in', v_qty, v_number, 'Stock dispatch', v_uid, v_rep_before, v_rep_before + v_qty);
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create_stock_dispatch', 'stock_dispatch', v_id::text,
          jsonb_build_object('dispatch_number', v_number, 'sales_rep_id', v_rep, 'total_value', v_total));

  RETURN jsonb_build_object('id', v_id, 'dispatch_number', v_number, 'total_value', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_stock_dispatch(jsonb) TO authenticated;

-- ============ 2. reverse_stock_dispatch ============
CREATE OR REPLACE FUNCTION public.reverse_stock_dispatch(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.stock_dispatches%ROWTYPE;
  v_item record;
  v_store_before numeric;
  v_rep_before numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'reverse'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a dispatch'; END IF;

  SELECT * INTO v_row FROM stock_dispatches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch not found'; END IF;
  IF v_row.status <> 'posted' THEN RAISE EXCEPTION 'Dispatch is already %', v_row.status; END IF;

  -- Only reversible while every dispatched unit is still sitting in the
  -- rep's van stock (nothing sold or returned against it).
  FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = p_id LOOP
    SELECT quantity INTO v_rep_before FROM rep_stock
      WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
    IF COALESCE(v_rep_before,0) < v_item.quantity THEN
      RAISE EXCEPTION 'Cannot reverse: the rep has already sold or returned some of this dispatch';
    END IF;

    UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
      WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.sales_rep_id, v_item.product_id, 'reversal', -v_item.quantity, v_row.dispatch_number, p_reason, v_uid, v_rep_before, v_rep_before - v_item.quantity);

    SELECT current_stock INTO v_store_before FROM products WHERE id = v_item.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_item.product_id, 'return_from_rep', v_item.quantity, v_row.dispatch_number, 'Dispatch reversed: ' || p_reason, v_uid, v_store_before, v_store_before + v_item.quantity);
  END LOOP;

  UPDATE stock_dispatches SET status = 'reversed', reversed_by = v_uid, reversed_at = now(), reverse_reason = p_reason WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_stock_dispatch', 'stock_dispatch', p_id::text, jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('reversed', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reverse_stock_dispatch(uuid, text) TO authenticated;

-- ============ 3. create_rep_return ============
CREATE OR REPLACE FUNCTION public.create_rep_return(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_rep uuid := (payload->>'sales_rep_id')::uuid;
  v_date date := COALESCE((payload->>'return_date')::date, CURRENT_DATE);
  v_notes text := payload->>'notes';
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_rep_row public.sales_reps%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
  v_number text;
  v_id uuid;
  v_rep_before numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'No items to return'; END IF;

  SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_rep;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
  IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity_returned')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity returned must be > 0'; END IF;
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_rep AND product_id = v_product.id FOR UPDATE;
    IF COALESCE(v_rep_before,0) < v_qty THEN
      RAISE EXCEPTION 'Rep cannot return more % than they hold (have %, returning %)', v_product.name, COALESCE(v_rep_before,0), v_qty;
    END IF;
  END LOOP;

  v_number := 'RRN-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO rep_returns(factory_id, return_number, sales_rep_id, return_date, received_by, notes)
  VALUES (v_factory, v_number, v_rep, v_date, v_uid, v_notes)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity_returned')::numeric;
    v_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, v_product.unit_price);

    INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price)
    VALUES (v_id, v_product.id, v_qty, v_price);

    -- goods physically leave the van now; store stock is untouched until inspection
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_rep AND product_id = v_product.id FOR UPDATE;
    UPDATE rep_stock SET quantity = quantity - v_qty, updated_at = now()
      WHERE sales_rep_id = v_rep AND product_id = v_product.id;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_rep, v_product.id, 'returned_out', -v_qty, v_number, 'Return to store (pending inspection)', v_uid, v_rep_before, v_rep_before - v_qty);
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'return_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_rep_return(jsonb) TO authenticated;

-- ============ 4. inspect_rep_return ============
CREATE OR REPLACE FUNCTION public.inspect_rep_return(p_id uuid, p_items jsonb, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.rep_returns%ROWTYPE;
  v_line jsonb;
  v_item public.rep_return_items%ROWTYPE;
  v_accepted numeric;
  v_damaged numeric;
  v_rejected numeric;
  v_charge_rep boolean;
  v_before numeric;
  v_unit text;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'confirm'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT * INTO v_row FROM rep_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rep return not found'; END IF;
  IF v_row.status <> 'received' THEN RAISE EXCEPTION 'This return has already been inspected'; END IF;
  IF v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Inspection must be done by someone other than who received the return';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'No inspection lines supplied'; END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_item FROM rep_return_items WHERE id = (v_line->>'item_id')::uuid AND rep_return_id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Return line % not found on this return', v_line->>'item_id'; END IF;

    v_accepted := COALESCE((v_line->>'accepted_quantity')::numeric, 0);
    v_damaged  := COALESCE((v_line->>'damaged_quantity')::numeric, 0);
    v_rejected := COALESCE((v_line->>'rejected_quantity')::numeric, 0);
    v_charge_rep := COALESCE((v_line->>'charge_rep')::boolean, true);

    IF v_accepted < 0 OR v_damaged < 0 OR v_rejected < 0 THEN RAISE EXCEPTION 'Quantities cannot be negative'; END IF;
    IF v_accepted + v_damaged + v_rejected <> v_item.quantity_returned THEN
      RAISE EXCEPTION 'Accepted + damaged + rejected must equal the % returned', v_item.quantity_returned;
    END IF;

    UPDATE rep_return_items
       SET accepted_quantity = v_accepted, damaged_quantity = v_damaged,
           rejected_quantity = v_rejected, charge_rep = v_charge_rep
     WHERE id = v_item.id;

    SELECT unit INTO v_unit FROM products WHERE id = v_item.product_id;

    IF v_accepted > 0 THEN
      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock + v_accepted, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_item.product_id, 'return_from_rep', v_accepted, v_row.return_number, 'Accepted rep return', v_uid, v_before, v_before + v_accepted);
    END IF;

    IF v_damaged > 0 THEN
      INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, reason, reported_by, status)
      VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
              'DELIVERY', v_row.return_number, v_item.product_id, v_damaged, v_unit,
              'Damaged on rep return inspection', v_uid, 'posted');
    END IF;
  END LOOP;

  UPDATE rep_returns SET status = 'completed', inspected_by = v_uid, inspected_at = now(), notes = COALESCE(p_notes, notes)
   WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'inspect_rep_return', 'rep_return', p_id::text, jsonb_build_object('return_number', v_row.return_number));

  RETURN jsonb_build_object('completed', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.inspect_rep_return(uuid, jsonb, text) TO authenticated;

-- ============ 5. cancel_rep_return (pre-inspection only) ============
CREATE OR REPLACE FUNCTION public.cancel_rep_return(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.rep_returns%ROWTYPE;
  v_item record;
  v_rep_before numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'cancel'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_row FROM rep_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rep return not found'; END IF;
  IF v_row.status <> 'received' THEN RAISE EXCEPTION 'Only an uninspected return can be cancelled'; END IF;

  -- goods go back onto the van
  FOR v_item IN SELECT * FROM rep_return_items WHERE rep_return_id = p_id LOOP
    SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
    IF NOT FOUND THEN
      v_rep_before := 0;
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity) VALUES (v_row.sales_rep_id, v_item.product_id, v_row.factory_id, v_item.quantity_returned);
    ELSE
      UPDATE rep_stock SET quantity = quantity + v_item.quantity_returned, updated_at = now()
        WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id;
    END IF;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.sales_rep_id, v_item.product_id, 'adjustment', v_item.quantity_returned, v_row.return_number, 'Rep return cancelled: ' || COALESCE(p_reason,''), v_uid, v_rep_before, v_rep_before + v_item.quantity_returned);
  END LOOP;

  UPDATE rep_returns SET status = 'cancelled', notes = COALESCE(p_reason, notes) WHERE id = p_id;
  RETURN jsonb_build_object('cancelled', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_rep_return(uuid, text) TO authenticated;

-- ============ 6. record_rep_remittance ============
CREATE OR REPLACE FUNCTION public.record_rep_remittance(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_rep uuid := (payload->>'sales_rep_id')::uuid;
  v_amount numeric := (payload->>'amount')::numeric;
  v_method public.payment_method := COALESCE((payload->>'payment_method')::public.payment_method, 'cash');
  v_date date := COALESCE((payload->>'remittance_date')::date, CURRENT_DATE);
  v_remarks text := payload->>'remarks';
  v_rep_row public.sales_reps%ROWTYPE;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'post'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;

  SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_rep;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
  IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;

  v_number := 'RMT-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO rep_remittances(factory_id, remittance_number, sales_rep_id, amount, payment_method, remittance_date, received_by, remarks)
  VALUES (v_factory, v_number, v_rep, v_amount, v_method, v_date, v_uid, v_remarks)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'record_rep_remittance', 'rep_remittance', v_id::text,
          jsonb_build_object('remittance_number', v_number, 'sales_rep_id', v_rep, 'amount', v_amount));

  RETURN jsonb_build_object('id', v_id, 'remittance_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_rep_remittance(jsonb) TO authenticated;

-- ============ 7. rep_account_summary ============
-- The rep's account, "full cash accountability":
--   net_balance_owed = goods_out_value
--                      - accepted_returns_value  (incl. damage written off to company)
--                      - cash_remitted
--                      - credit_outstanding      (running, not date-filtered)
CREATE OR REPLACE FUNCTION public.rep_account_summary(p_sales_rep_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_goods_out numeric := 0;
  v_accepted numeric := 0;
  v_written_off numeric := 0;
  v_damaged numeric := 0;
  v_rejected numeric := 0;
  v_cash numeric := 0;
  v_credit numeric := 0;
  v_van_value numeric := 0;
  v_sales_count int := 0;
  v_sales_value numeric := 0;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT COALESCE(SUM(sdi.line_value), 0) INTO v_goods_out
  FROM stock_dispatch_items sdi
  JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
  WHERE sd.sales_rep_id = p_sales_rep_id AND sd.status = 'posted'
    AND (p_from IS NULL OR sd.dispatch_date >= p_from)
    AND (p_to   IS NULL OR sd.dispatch_date <= p_to);

  SELECT
    COALESCE(SUM(COALESCE(rri.accepted_quantity,0) * rri.unit_price), 0),
    COALESCE(SUM(CASE WHEN NOT rri.charge_rep THEN (rri.damaged_quantity + rri.rejected_quantity) * rri.unit_price ELSE 0 END), 0),
    COALESCE(SUM(rri.damaged_quantity * rri.unit_price), 0),
    COALESCE(SUM(rri.rejected_quantity * rri.unit_price), 0)
  INTO v_accepted, v_written_off, v_damaged, v_rejected
  FROM rep_return_items rri
  JOIN rep_returns rr ON rr.id = rri.rep_return_id
  WHERE rr.sales_rep_id = p_sales_rep_id AND rr.status = 'completed'
    AND (p_from IS NULL OR rr.return_date >= p_from)
    AND (p_to   IS NULL OR rr.return_date <= p_to);

  SELECT COALESCE(SUM(amount), 0) INTO v_cash
  FROM rep_remittances
  WHERE sales_rep_id = p_sales_rep_id
    AND (p_from IS NULL OR remittance_date >= p_from)
    AND (p_to   IS NULL OR remittance_date <= p_to);

  SELECT COALESCE(SUM(outstanding), 0) INTO v_credit
  FROM debts
  WHERE sales_rep_id = p_sales_rep_id AND status <> 'paid';

  SELECT COALESCE(SUM(rs.quantity * p.unit_price), 0) INTO v_van_value
  FROM rep_stock rs JOIN products p ON p.id = rs.product_id
  WHERE rs.sales_rep_id = p_sales_rep_id;

  SELECT COUNT(*), COALESCE(SUM(grand_total), 0) INTO v_sales_count, v_sales_value
  FROM sales
  WHERE sales_rep_id = p_sales_rep_id
    AND (p_from IS NULL OR sale_date >= p_from)
    AND (p_to   IS NULL OR sale_date <= p_to);

  RETURN jsonb_build_object(
    'goods_out_value', v_goods_out,
    'accepted_returns_value', v_accepted + v_written_off,
    'accepted_only_value', v_accepted,
    'written_off_value', v_written_off,
    'damaged_value', v_damaged,
    'rejected_value', v_rejected,
    'cash_remitted', v_cash,
    'credit_outstanding', v_credit,
    'van_stock_value', v_van_value,
    'sales_count', v_sales_count,
    'sales_value', v_sales_value,
    'net_balance_owed', v_goods_out - (v_accepted + v_written_off) - v_cash - v_credit
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.rep_account_summary(uuid, date, date) TO authenticated;

-- ============ 8. create_sale(): rep sales draw down rep_stock ============
-- Re-declared from 20260816109000_fix_has_permission_module_cast.sql,
-- byte-identical EXCEPT the sales_rep_id handling: when a rep is named, the
-- goods have already left the store (at dispatch time), so the sale draws
-- from rep_stock and records a rep_stock_movement instead of touching
-- products.current_stock / inventory_movements. sales.sales_rep_id and
-- debts.sales_rep_id are stamped so the sale and its credit land on the
-- rep's account.
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
  v_sales_rep uuid := NULLIF(payload->>'sales_rep_id','')::uuid;
  v_rep_row public.sales_reps%ROWTYPE;
  v_rep_before numeric;
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
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'no items'; END IF;

  IF v_sales_rep IS NOT NULL THEN
    SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_sales_rep;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
    IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;
    IF v_rep_row.status <> 'active' THEN RAISE EXCEPTION 'Sales rep is not active'; END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_sales_rep IS NOT NULL THEN
      SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id;
      IF COALESCE(v_rep_before, 0) < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %: rep has %, need %', v_product.name, COALESCE(v_rep_before,0), v_qty;
      END IF;
    ELSE
      IF v_product.current_stock < v_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
      END IF;
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
  END LOOP;

  v_grand := GREATEST(v_subtotal - v_discount + v_vat, 0);
  v_balance := GREATEST(v_grand - v_amount_paid, 0);

  SELECT COALESCE(invoice_prefix,'INV-') INTO v_prefix FROM settings WHERE factory_id = v_factory;
  IF v_prefix IS NULL THEN v_prefix := 'INV-'; END IF;
  v_invoice := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales(factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, customer_address,
                    subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, sales_rep_id, remarks, created_by)
  VALUES (v_factory, v_invoice, v_sale_date, v_customer, v_customer_name, v_customer_phone, v_customer_address,
          v_subtotal, v_discount, v_vat, v_grand, v_amount_paid, v_balance, v_payment_method, v_sales_person, v_sales_rep, v_remarks, v_uid)
  RETURNING id INTO v_sale_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);

    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total)
    VALUES (v_sale_id, v_product.id, v_qty, v_price, v_qty * v_price);

    IF v_sales_rep IS NOT NULL THEN
      SELECT quantity INTO v_rep_before FROM rep_stock WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id FOR UPDATE;
      IF COALESCE(v_rep_before,0) < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %', v_product.name;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_qty, updated_at = now()
       WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_factory, v_sales_rep, v_product.id, 'sold', -v_qty, v_invoice, 'Rep sale', v_uid, v_rep_before, v_rep_before - v_qty);
    ELSE
      UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product.id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_factory, v_product.id, 'sold', v_qty, v_invoice, 'Sale', v_uid, v_product.current_stock, v_product.current_stock - v_qty);
    END IF;
  END LOOP;

  IF v_amount_paid > 0 THEN
    SELECT COALESCE(receipt_prefix,'RCP-') INTO v_receipt_prefix FROM settings WHERE factory_id = v_factory;
    IF v_receipt_prefix IS NULL THEN v_receipt_prefix := 'RCP-'; END IF;
    v_receipt := v_receipt_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_factory, v_receipt, v_customer, v_sale_id, v_amount_paid, v_payment_method, v_sale_date, v_uid, 'Payment at point of sale');
  END IF;

  IF v_balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_factory, v_customer, v_sale_id, v_sales_rep, v_grand, v_amount_paid, v_balance,
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
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;
