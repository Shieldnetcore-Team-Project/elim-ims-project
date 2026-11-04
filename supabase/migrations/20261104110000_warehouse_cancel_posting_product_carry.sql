-- ============================================================================
-- Warehouse: each officer carries only their own returned products, cancels
-- a wrong posting; Ranshak (PM) handles every product
-- ----------------------------------------------------------------------------
-- User (2026-11-04):
--  1. "in warehouse posting with returns like the marketer, isolate products
--     for warehouse officers the products is not assigned to them" -- the
--     returns box on Post to Marketer / Post to Retail Shop listed every
--     returned product (sachet, dispensers, bottles) to Kemi (bottles only),
--     and carrying a whole return took the other officer's products with it.
--     Carrying is now per product line:
--       rep_return_items.carried_dispatch_id   the posting that carried this
--                 line back onto the marketer's / shop's supplies;
--       create_stock_dispatch  carries only the lines of each return the
--                 poster handles (_user_may_handle_product); the return
--                 itself (rep_returns.carried_dispatch_id) counts as carried
--                 once every line is. The rest stay open for the officer who
--                 handles them.
--       correct_stock_dispatch  moves the carried lines to the corrected
--                 posting too (body as 20261027200000 plus that line).
--     A reversed / cancelled posting frees its lines again (as before).
--  2. "create a icon to cancel posting in warehouse - all transactions ...
--     for marketers, distributors or retail when mistakes are done and the
--     products goes back to warehouse":
--       cancel_warehouse_posting(p_kind, p_id, p_reason)
--         p_kind 'dispatch'  a posting to a marketer / the Retail Shop: the
--                goods come off their stock and back into the Warehouse, the
--                posting is marked reversed (Accounts sees it as such), its
--                carried returns open again. Refused when they have already
--                sold or returned part of it.
--         p_kind 'sale'      a Warehouse posting to a distributor: reversed
--                as an approved deletion (_reverse_posted_sale): goods back,
--                debt removed, anything paid back to their credit, soft-
--                deleted.
--       Who: whoever can post it (distribution create / sales write), in the
--       factory, and only a posting whose products are all theirs.
--  3. Ranshak, the production manager: every product -- his product limits
--     removed, the Production page and the rights to record and release
--     batches (as Grand Joy, 20261031180000).
-- ============================================================================

-- ---------------------------------------------------------------- 1. carry
ALTER TABLE public.rep_return_items
  ADD COLUMN IF NOT EXISTS carried_dispatch_id uuid REFERENCES public.stock_dispatches(id) ON DELETE SET NULL;

-- Lines of returns already carried were carried with them.
UPDATE public.rep_return_items i
   SET carried_dispatch_id = r.carried_dispatch_id
  FROM public.rep_returns r
 WHERE r.id = i.rep_return_id AND r.carried_dispatch_id IS NOT NULL AND i.carried_dispatch_id IS NULL;

-- Still to be carried: not on a live posting.
CREATE OR REPLACE FUNCTION public._return_line_open(p_dispatch uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_dispatch IS NULL
      OR NOT EXISTS (SELECT 1 FROM stock_dispatches d WHERE d.id = p_dispatch AND d.status <> 'reversed');
$$;
REVOKE ALL ON FUNCTION public._return_line_open(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._return_line_open(uuid) TO authenticated;

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
  v_carry uuid := NULLIF(payload->>'carry_return_id','')::uuid;
  -- Every return carried: carry_return_id and/or carry_return_ids.
  v_carries uuid[] := ARRAY(
    SELECT DISTINCT x::uuid FROM (
      SELECT NULLIF(payload->>'carry_return_id','') AS x
      UNION ALL
      SELECT NULLIF(e, '') FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(payload->'carry_return_ids') = 'array' THEN payload->'carry_return_ids' ELSE '[]'::jsonb END) e
    ) s WHERE x IS NOT NULL);
  v_carry_id uuid;
  v_carry_row public.rep_returns%ROWTYPE;
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

  FOREACH v_carry_id IN ARRAY v_carries LOOP
    SELECT * INTO v_carry_row FROM rep_returns WHERE id = v_carry_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
    IF v_carry_row.sales_rep_id <> v_rep THEN RAISE EXCEPTION 'That return belongs to another marketer'; END IF;
    IF v_carry_row.status <> 'completed' THEN RAISE EXCEPTION 'Only a completed return can be carried over'; END IF;
    -- Something of it still open that this person handles (2026-11-04: per
    -- product line; a reversed posting frees its lines again).
    IF NOT EXISTS (SELECT 1 FROM rep_return_items i
                    WHERE i.rep_return_id = v_carry_id
                      AND public._return_line_open(i.carried_dispatch_id)
                      AND public._user_may_handle_product(v_uid, i.product_id)) THEN
      RAISE EXCEPTION 'Return % has already been added to a dispatch', v_carry_row.return_number;
    END IF;
  END LOOP;

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

  IF cardinality(v_carries) > 0 THEN
    -- The lines this person handles go on this posting ...
    UPDATE rep_return_items i SET carried_dispatch_id = v_id
     WHERE i.rep_return_id = ANY (v_carries)
       AND public._return_line_open(i.carried_dispatch_id)
       AND public._user_may_handle_product(v_uid, i.product_id);
    -- ... and a return is carried once all of its lines are.
    UPDATE rep_returns r SET carried_dispatch_id = v_id
     WHERE r.id = ANY (v_carries)
       AND NOT EXISTS (SELECT 1 FROM rep_return_items i
                        WHERE i.rep_return_id = r.id AND public._return_line_open(i.carried_dispatch_id));
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create_stock_dispatch', 'stock_dispatch', v_id::text,
          jsonb_build_object('dispatch_number', v_number, 'sales_rep_id', v_rep, 'total_value', v_total,
                             'carry_return_id', v_carry, 'carry_return_ids', to_jsonb(v_carries)));

  RETURN jsonb_build_object('id', v_id, 'dispatch_number', v_number, 'total_value', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_stock_dispatch(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.correct_stock_dispatch(p_id uuid, payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row stock_dispatches%ROWTYPE;
  v_item record;
  v_before numeric;
  v_reason text := COALESCE(NULLIF(btrim(payload->>'reason'), ''), 'Corrected');
  v_new jsonb;
  v_new_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_row FROM stock_dispatches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Posting not found'; END IF;
  IF v_row.status <> 'posted' THEN RAISE EXCEPTION 'This posting is already %', v_row.status; END IF;
  IF payload->'items' IS NULL OR jsonb_array_length(payload->'items') = 0 THEN
    RAISE EXCEPTION 'Add at least one product line';
  END IF;

  FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = p_id LOOP
    SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now()
     WHERE id = v_item.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_item.product_id, 'return_from_rep', v_item.quantity, v_row.dispatch_number,
            'Posting corrected: ' || v_reason, v_uid, v_before, v_before + v_item.quantity);
  END LOOP;

  v_new := public.create_stock_dispatch(jsonb_build_object(
    'factory_id', v_row.factory_id,
    'sales_rep_id', v_row.sales_rep_id,
    'dispatch_date', COALESCE(NULLIF(payload->>'dispatch_date', ''), v_row.dispatch_date::text),
    'vehicle_id', v_row.vehicle_id, 'driver_id', v_row.driver_id, 'route_id', v_row.route_id,
    'notes', COALESCE(NULLIF(payload->>'notes', ''), v_row.notes),
    'items', payload->'items'));
  v_new_id := (v_new->>'id')::uuid;

  FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = p_id LOOP
    SELECT quantity INTO v_before FROM rep_stock
     WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
    IF COALESCE(v_before, 0) < v_item.quantity THEN
      RAISE EXCEPTION 'Cannot correct: the marketer has already sold or returned some of %, so it can''t be reduced that far',
        (SELECT name FROM products WHERE id = v_item.product_id);
    END IF;
    UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
     WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.sales_rep_id, v_item.product_id, 'reversal', -v_item.quantity, v_row.dispatch_number,
            'Posting corrected: ' || v_reason, v_uid, v_before, v_before - v_item.quantity);
  END LOOP;

  UPDATE stock_dispatches
     SET status = 'reversed', reversed_by = v_uid, reversed_at = now(),
         reverse_reason = format('Corrected by %s: %s', v_new->>'dispatch_number', v_reason)
   WHERE id = p_id;
  UPDATE rep_returns SET carried_dispatch_id = v_new_id WHERE carried_dispatch_id = p_id;
  UPDATE rep_return_items SET carried_dispatch_id = v_new_id WHERE carried_dispatch_id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'correct_stock_dispatch', 'stock_dispatch', p_id::text,
          jsonb_build_object('dispatch_number', v_row.dispatch_number, 'total_value', v_row.total_value),
          jsonb_build_object('dispatch_number', v_new->>'dispatch_number', 'total_value', v_new->'total_value',
                             'reason', v_reason));

  RETURN jsonb_build_object('id', v_new_id, 'dispatch_number', v_new->>'dispatch_number',
                            'replaced', v_row.dispatch_number);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_stock_dispatch(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_stock_dispatch(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------- 2. cancel
CREATE OR REPLACE FUNCTION public.cancel_warehouse_posting(p_kind text, p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), 'posted by mistake');
  v_d stock_dispatches%ROWTYPE;
  v_s sales%ROWTYPE;
  v_item record;
  v_rep_before numeric;
  v_before numeric;
  v_other text;
  v_party text;
BEGIN
  IF p_kind = 'dispatch' THEN
    IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    SELECT * INTO v_d FROM stock_dispatches WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Posting not found'; END IF;
    IF NOT public._works_in_factory(v_uid, v_d.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    IF v_d.status <> 'posted' THEN RAISE EXCEPTION '% is already %', v_d.dispatch_number, v_d.status; END IF;
    SELECT string_agg(DISTINCT p.name, ', ') INTO v_other
      FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
     WHERE i.dispatch_id = p_id AND NOT public._user_may_handle_product(v_uid, i.product_id);
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION '% has % on it, which another Warehouse officer handles -- ask them or an Admin to cancel it',
        v_d.dispatch_number, v_other;
    END IF;
    v_party := (SELECT full_name FROM sales_reps WHERE id = v_d.sales_rep_id);

    FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = p_id LOOP
      SELECT quantity INTO v_rep_before FROM rep_stock
       WHERE sales_rep_id = v_d.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      IF COALESCE(v_rep_before, 0) < v_item.quantity THEN
        RAISE EXCEPTION 'Cannot cancel %: % has already sold or returned some of the % on it (holds %, posting %)',
          v_d.dispatch_number, v_party, (SELECT name FROM products WHERE id = v_item.product_id),
          COALESCE(v_rep_before, 0), v_item.quantity;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
       WHERE sales_rep_id = v_d.sales_rep_id AND product_id = v_item.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_d.factory_id, v_d.sales_rep_id, v_item.product_id, 'reversal', -v_item.quantity, v_d.dispatch_number,
              'Posting cancelled: ' || v_reason, v_uid, v_rep_before, v_rep_before - v_item.quantity);

      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_d.factory_id, v_item.product_id, 'return_from_rep', v_item.quantity, v_d.dispatch_number,
              'Posting cancelled: ' || v_reason, v_uid, v_before, v_before + v_item.quantity);
    END LOOP;

    UPDATE stock_dispatches
       SET status = 'reversed', reversed_by = v_uid, reversed_at = now(),
           reverse_reason = 'Cancelled: ' || v_reason
     WHERE id = p_id;
    -- Its carried returns open again for the next posting.
    UPDATE rep_returns SET carried_dispatch_id = NULL WHERE carried_dispatch_id = p_id;
    UPDATE rep_return_items SET carried_dispatch_id = NULL WHERE carried_dispatch_id = p_id;

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_d.factory_id, 'cancel_warehouse_posting', 'stock_dispatch', p_id::text,
            jsonb_build_object('dispatch_number', v_d.dispatch_number, 'party', v_party, 'total_value', v_d.total_value),
            jsonb_build_object('status', 'reversed', 'reason', v_reason));
    RETURN jsonb_build_object('cancelled', v_d.dispatch_number, 'party', v_party);

  ELSIF p_kind = 'sale' THEN
    IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    SELECT * INTO v_s FROM sales WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Posting not found'; END IF;
    IF NOT public._works_in_factory(v_uid, v_s.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    IF NOT public.is_warehouse_posting(v_s) THEN
      RAISE EXCEPTION '% isn''t a Warehouse posting to a distributor', v_s.invoice_number;
    END IF;
    IF v_s.status <> 'posted' THEN
      RAISE EXCEPTION '% is %, not posted', v_s.invoice_number, replace(v_s.status::text, '_', ' ');
    END IF;
    SELECT string_agg(DISTINCT p.name, ', ') INTO v_other
      FROM sale_items i JOIN products p ON p.id = i.product_id
     WHERE i.sale_id = p_id AND NOT public._user_may_handle_product(v_uid, i.product_id);
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION '% has % on it, which another Warehouse officer handles -- ask them or an Admin to cancel it',
        v_s.invoice_number, v_other;
    END IF;

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_s.factory_id, 'cancel_warehouse_posting', 'sales', p_id::text,
            jsonb_build_object('invoice_number', v_s.invoice_number, 'customer', v_s.customer_name,
                               'grand_total', v_s.grand_total,
                               'items', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity,
                                                                            'unit_price', unit_price))
                                           FROM sale_items WHERE sale_id = p_id)),
            jsonb_build_object('reason', v_reason));
    PERFORM public._reverse_posted_sale(p_id, 'Cancelled: ' || v_reason);
    RETURN jsonb_build_object('cancelled', v_s.invoice_number, 'party', v_s.customer_name);
  END IF;
  RAISE EXCEPTION 'Unknown posting kind %', p_kind;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_warehouse_posting(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_warehouse_posting(text, uuid, text) TO authenticated;

-- ---------------------------------------------------------------- 3. Ranshak
DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
BEGIN
  v_count := (SELECT count(*) FROM profiles p WHERE p.full_name ILIKE '%ranshak%' OR p.email ILIKE '%ranshak%');
  IF v_count <> 1 THEN
    RAISE NOTICE 'Ranshak skipped: % accounts match "ranshak" -- give him the Production rights in Admin Panel -> Users', v_count;
    RETURN;
  END IF;
  SELECT p.id, COALESCE(p.full_name, p.email) INTO v_user, v_name FROM profiles p
   WHERE p.full_name ILIKE '%ranshak%' OR p.email ILIKE '%ranshak%';
  IF public.has_role(v_user, 'super_admin') OR public.has_role(v_user, 'chairman') THEN
    RAISE NOTICE 'Ranshak skipped: % is an Admin / Chairman -- already has every product', v_name;
    RETURN;
  END IF;

  -- Every product: no limits.
  IF to_regclass('public.user_product_rules') IS NOT NULL THEN
    DELETE FROM user_product_rules WHERE user_id = v_user;
  END IF;
  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, 'production'::module_key, a, true
    FROM unnest(ARRAY['view', 'create', 'submit']::action_key[]) AS a
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();
  INSERT INTO user_page_access (user_id, page_id, granted)
  VALUES (v_user, 'Production › Production', true)
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();

  v_factory := (SELECT factory_id FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant', 'permission_overrides', v_user::text,
          jsonb_build_object('module', 'production', 'actions', jsonb_build_array('view', 'create', 'submit'),
                             'page', 'Production › Production', 'products', 'all',
                             'reason', format('%s is the production manager: sachet, bottles and dispensers (2026-11-04)', v_name)));
  RAISE NOTICE '% now has every product on Production (sachet, bottles, dispensers)', v_name;
END $$;

NOTIFY pgrst, 'reload schema';
