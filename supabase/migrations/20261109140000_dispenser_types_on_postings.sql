-- ============================================================================
-- Which dispenser type was posted, and the three types on the shop's day close
-- ----------------------------------------------------------------------------
-- User (2026-11-09):
-- 1. The Warehouse posts a dispenser to a marketer or the shop as Dispenser
--    Water or Jug + Water, and every invoice and list says which, with its
--    price. One filled stock: only the line's type and price differ.
--      * Jug + Water is posted at Dispenser Water + Empty Jug (N4,200);
--      * its jug is paid for, so the marketer owes no jug on those lines;
--      * unsold Jug + Water comes back at the price it was posted at;
--      * a Costing price change leaves posted Jug + Water lines alone.
-- 2. The shop's day close lists Dispenser Water, Jug + Water and Empty Jug,
--    each counted. The rows always add up to the one filled stock.
-- Needs 20261109120000 first. Safe to run again.
-- Paste the whole file into the Supabase SQL Editor (run without RLS).
-- ============================================================================

DO $fn$
BEGIN
  IF to_regprocedure('public._sale_line_name(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Run 20261109120000_customer_contact_and_jug_names.sql first';
  END IF;
END;
$fn$;

ALTER TABLE public.stock_dispatch_items
  ADD COLUMN IF NOT EXISTS jar_mode text CHECK (jar_mode IS NULL OR jar_mode = 'permanent');
ALTER TABLE public.rep_return_items
  ADD COLUMN IF NOT EXISTS jar_mode text CHECK (jar_mode IS NULL OR jar_mode = 'permanent');

-- ------------------------------------------------------------- 1. helpers --
CREATE OR REPLACE FUNCTION public._posting_default_price(p_product uuid, p_mode text, p_price numeric)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT CASE WHEN p_mode = 'permanent'
              THEN COALESCE((SELECT j.with_jar_price FROM public._product_jug(p_product) j), p_price)
              ELSE p_price END;
$fn$;
REVOKE ALL ON FUNCTION public._posting_default_price(uuid, text, numeric) FROM PUBLIC, anon, authenticated;

-- Jug + Water posted to this holder and not returned.
CREATE OR REPLACE FUNCTION public._rep_jug_water_held(p_rep uuid, p_product uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT GREATEST(
    COALESCE((SELECT SUM(i.quantity) FROM stock_dispatch_items i
                JOIN stock_dispatches d ON d.id = i.dispatch_id
               WHERE d.sales_rep_id = p_rep AND i.product_id = p_product
                 AND i.jar_mode = 'permanent' AND d.status::text <> 'reversed'), 0)
    - COALESCE((SELECT SUM(i.quantity_returned) FROM rep_return_items i
                  JOIN rep_returns r ON r.id = i.rep_return_id
                 WHERE r.sales_rep_id = p_rep AND i.product_id = p_product
                   AND i.jar_mode = 'permanent' AND r.status::text <> 'cancelled'), 0), 0);
$fn$;
REVOKE ALL ON FUNCTION public._rep_jug_water_held(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rep_jug_water_held(p_rep uuid)
RETURNS TABLE(product_id uuid, quantity numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT x.pid, public._rep_jug_water_held(p_rep, x.pid)
    FROM (SELECT DISTINCT i.product_id AS pid
            FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
           WHERE d.sales_rep_id = p_rep AND i.jar_mode = 'permanent'
             AND public._works_in_factory(auth.uid(), d.factory_id)) x;
END;
$fn$;
REVOKE ALL ON FUNCTION public.rep_jug_water_held(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_jug_water_held(uuid) TO authenticated;

-- ------------------------------------------------------------ 2. postings --
CREATE OR REPLACE FUNCTION public.create_stock_dispatch(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
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
  v_needed numeric;
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
    IF NULLIF(v_item->>'jar_mode', '') IS NOT NULL
       AND (v_item->>'jar_mode' <> 'permanent' OR NOT EXISTS (SELECT 1 FROM public._product_jug(v_product.id))) THEN
      RAISE EXCEPTION '% can''t be posted as Jug + Water', v_product.name;
    END IF;
    -- Two lines of one product (its two types) share the one stock.
    v_needed := (SELECT SUM((e->>'quantity')::numeric) FROM jsonb_array_elements(v_items) e
                  WHERE e->>'product_id' = v_item->>'product_id');
    IF v_product.current_stock < v_needed THEN
      RAISE EXCEPTION 'Insufficient store stock for %: have %, need %', v_product.name, v_product.current_stock, v_needed;
    END IF;
    v_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric,
                        public._posting_default_price(v_product.id, v_item->>'jar_mode', v_product.unit_price));
    v_total := v_total + (v_qty * v_price);
  END LOOP;

  v_number := 'DSP-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO stock_dispatches(factory_id, dispatch_number, dispatch_date, sales_rep_id, vehicle_id, driver_id, route_id, total_value, notes, created_by)
  VALUES (v_factory, v_number, v_date, v_rep, v_vehicle, v_driver, v_route, v_total, v_notes, v_uid)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric,
                        public._posting_default_price(v_product.id, v_item->>'jar_mode', v_product.unit_price));
    v_line := v_qty * v_price;

    INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value, jar_mode)
    VALUES (v_id, v_product.id, v_qty, v_price, v_line, NULLIF(v_item->>'jar_mode', ''));

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
$fn$;

CREATE OR REPLACE FUNCTION public.rep_posting_lines(p_kind text, p_id uuid)
RETURNS TABLE(product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  IF p_kind = 'dispatch' THEN
    RETURN QUERY
    SELECT public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price - i.unit_discount,
           COALESCE(NULLIF(i.line_value, 0), i.quantity * (i.unit_price - i.unit_discount)),
           CASE WHEN i.unit_discount > 0 THEN 'less ' || trim(to_char(i.unit_discount, 'FM999G999G990D00')) || ' a pack' END
      FROM stock_dispatch_items i
      JOIN stock_dispatches d ON d.id = i.dispatch_id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE i.dispatch_id = p_id AND public._works_in_factory(auth.uid(), d.factory_id)
     ORDER BY p.name;
  ELSIF p_kind = 'return' THEN
    RETURN QUERY
    SELECT public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity_returned, i.unit_price,
           i.quantity_returned * i.unit_price,
           NULLIF(concat_ws(', ',
             CASE WHEN i.accepted_quantity IS NOT NULL THEN 'accepted ' || trim(to_char(i.accepted_quantity, 'FM999G999G990D###')) END,
             CASE WHEN i.damaged_quantity > 0 THEN 'damaged ' || trim(to_char(i.damaged_quantity, 'FM999G999G990D###')) END,
             CASE WHEN i.rejected_quantity > 0 THEN 'rejected ' || trim(to_char(i.rejected_quantity, 'FM999G999G990D###')) END), '')
      FROM rep_return_items i
      JOIN rep_returns r ON r.id = i.rep_return_id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE i.rep_return_id = p_id AND public._works_in_factory(auth.uid(), r.factory_id)
     ORDER BY p.name;
  ELSIF p_kind = 'sale' THEN
    RETURN QUERY
    SELECT public._sale_line_name(COALESCE(p.name, '-'), si.jar_mode)::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total,
           NULL::text
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = p_id AND public._works_in_factory(auth.uid(), s.factory_id)
     ORDER BY p.name;
  ELSE
    RAISE EXCEPTION 'Unknown transaction kind: %', p_kind;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.posting_discount_lines(p_dispatches uuid[])
RETURNS TABLE(product_id uuid, product_name text, unit text, unit_price numeric, quantity numeric,
              unit_discount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT i.product_id, public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.unit_price,
         SUM(i.quantity), MAX(i.unit_discount)
    FROM stock_dispatch_items i
    JOIN stock_dispatches d ON d.id = i.dispatch_id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE d.id = ANY (p_dispatches) AND d.status::text <> 'reversed'
     AND public._works_in_factory(auth.uid(), d.factory_id)
   GROUP BY 1, 2, 3, 4
   ORDER BY 2, 4;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.reprice_posted_lines(
  p_product uuid, p_reason text DEFAULT NULL, p_dry_run boolean DEFAULT false,
  p_from date DEFAULT NULL, p_old_price numeric DEFAULT NULL
) RETURNS TABLE(kind text, reference text, party text, day date, quantity numeric,
                old_price numeric, new_price numeric, old_value numeric, new_value numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_p products%ROWTYPE;
  v_d record;
  v_old numeric;
  v_reason text := COALESCE(NULLIF(btrim(p_reason), ''), 'Re-priced to the Costing price');
BEGIN
  IF v_uid IS NOT NULL AND NOT public._is_product_admin(v_uid) THEN
    RAISE EXCEPTION 'Only an administrator can re-price postings';
  END IF;
  SELECT * INTO v_p FROM products WHERE id = p_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF p_from IS NOT NULL AND p_from > (now() AT TIME ZONE 'Africa/Lagos')::date THEN
    RAISE EXCEPTION 'The start date is in the future';
  END IF;

  RETURN QUERY
  SELECT 'posting'::text, d.dispatch_number, r.full_name, d.dispatch_date, i.quantity,
         i.unit_price, v_p.unit_price, i.line_value, i.quantity * v_p.unit_price
    FROM stock_dispatch_items i
    JOIN stock_dispatches d ON d.id = i.dispatch_id
    JOIN sales_reps r ON r.id = d.sales_rep_id
   WHERE i.product_id = p_product AND i.jar_mode IS NULL AND d.status::text <> 'reversed' AND i.unit_price <> v_p.unit_price
     AND (p_from IS NULL OR d.dispatch_date >= p_from)
     AND (p_old_price IS NULL OR i.unit_price = p_old_price)
  UNION ALL
  SELECT 'return', rr.return_number, r.full_name, rr.return_date, i.quantity_returned,
         i.unit_price, v_p.unit_price, i.quantity_returned * i.unit_price, i.quantity_returned * v_p.unit_price
    FROM rep_return_items i
    JOIN rep_returns rr ON rr.id = i.rep_return_id
    JOIN sales_reps r ON r.id = rr.sales_rep_id
   WHERE i.product_id = p_product AND i.jar_mode IS NULL AND rr.status::text <> 'cancelled' AND i.unit_price <> v_p.unit_price
     AND (p_from IS NULL OR rr.return_date >= p_from)
     AND (p_old_price IS NULL OR i.unit_price = p_old_price)
   ORDER BY 4, 2;

  IF p_dry_run THEN RETURN; END IF;

  FOR v_d IN
    SELECT DISTINCT d.id, d.dispatch_number, d.factory_id, d.total_value
      FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
     WHERE i.product_id = p_product AND i.jar_mode IS NULL AND d.status::text <> 'reversed' AND i.unit_price <> v_p.unit_price
       AND (p_from IS NULL OR d.dispatch_date >= p_from)
       AND (p_old_price IS NULL OR i.unit_price = p_old_price)
  LOOP
    v_old := v_d.total_value;
    UPDATE stock_dispatch_items SET unit_price = v_p.unit_price,
           line_value = quantity * GREATEST(v_p.unit_price - unit_discount, 0)
     WHERE dispatch_id = v_d.id AND product_id = p_product AND jar_mode IS NULL AND unit_price <> v_p.unit_price
       AND (p_old_price IS NULL OR unit_price = p_old_price);
    UPDATE stock_dispatches
       SET total_value = (SELECT COALESCE(SUM(line_value), 0) FROM stock_dispatch_items WHERE dispatch_id = v_d.id)
     WHERE id = v_d.id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_d.factory_id, 'reprice_posted_lines', 'stock_dispatches', v_d.id::text,
            jsonb_build_object('dispatch_number', v_d.dispatch_number, 'total_value', v_old),
            jsonb_build_object('product', v_p.name, 'unit_price', v_p.unit_price,
                               'total_value', (SELECT total_value FROM stock_dispatches WHERE id = v_d.id),
                               'reason', v_reason));
  END LOOP;

  FOR v_d IN
    SELECT DISTINCT rr.id, rr.return_number, rr.factory_id
      FROM rep_return_items i JOIN rep_returns rr ON rr.id = i.rep_return_id
     WHERE i.product_id = p_product AND i.jar_mode IS NULL AND rr.status::text <> 'cancelled' AND i.unit_price <> v_p.unit_price
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_old_price IS NULL OR i.unit_price = p_old_price)
  LOOP
    SELECT SUM(quantity_returned * unit_price) INTO v_old FROM rep_return_items
     WHERE rep_return_id = v_d.id AND product_id = p_product;
    UPDATE rep_return_items SET unit_price = v_p.unit_price
     WHERE rep_return_id = v_d.id AND product_id = p_product AND jar_mode IS NULL AND unit_price <> v_p.unit_price
       AND (p_old_price IS NULL OR unit_price = p_old_price);
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_d.factory_id, 'reprice_posted_lines', 'rep_returns', v_d.id::text,
            jsonb_build_object('return_number', v_d.return_number, 'value', v_old),
            jsonb_build_object('product', v_p.name, 'unit_price', v_p.unit_price,
                               'value', (SELECT SUM(quantity_returned * unit_price) FROM rep_return_items
                                          WHERE rep_return_id = v_d.id AND product_id = p_product),
                               'reason', v_reason));
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rep_account_summary(p_sales_rep_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_goods_out numeric := 0;
  v_accepted numeric := 0;
  v_written_off numeric := 0;
  v_damaged numeric := 0;
  v_rejected numeric := 0;
  v_cash numeric := 0;
  v_credit numeric := 0;
  v_collected numeric := 0;
  v_van_value numeric := 0;
  v_sales_count int := 0;
  v_sales_value numeric := 0;
  v_jugs_back numeric := 0;
  v_jugs_value numeric := 0;
  v_jugs_owed numeric := 0;
  v_jugs_owed_value numeric := 0;
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

  v_collected := public._rep_credit_collected(p_sales_rep_id);

  -- Empty jugs QC counted back from the marketer, each credited at the jug
  -- price of the day it was counted (20261101100000).
  SELECT COALESCE(SUM(j.quantity_received), 0), COALESCE(SUM(j.quantity_received * j.credit_price), 0)
    INTO v_jugs_back, v_jugs_value
    FROM jug_returns j
   WHERE j.sales_rep_id = p_sales_rep_id AND j.status = 'verified' AND j.credit_price IS NOT NULL
     AND (p_from IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
     AND (p_to   IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date <= p_to);

  -- Rule A (2026-11-03): every jug that went out with a posting and has not
  -- come back -- in an unsold dispenser or as an empty QC counted -- is owed
  -- at the jug's price (the empty-jug product on Costing).
  WITH moves AS (
    SELECT pj.container_type_id AS t, sdi.quantity * pj.per_unit AS q
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_sales_rep_id AND sd.status = 'posted' AND sdi.jar_mode IS NULL
       AND (p_from IS NULL OR sd.dispatch_date >= p_from)
       AND (p_to   IS NULL OR sd.dispatch_date <= p_to)
    UNION ALL
    SELECT pj.container_type_id, -COALESCE(rri.accepted_quantity, 0) * pj.per_unit
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.sales_rep_id = p_sales_rep_id AND rr.status = 'completed' AND rri.jar_mode IS NULL
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_to   IS NULL OR rr.return_date <= p_to)
    UNION ALL
    SELECT j.container_type_id, -j.quantity_received
      FROM jug_returns j
     WHERE j.sales_rep_id = p_sales_rep_id AND j.status = 'verified'
       AND (p_from IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
       AND (p_to   IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date <= p_to)
  ), per AS (
    SELECT t, GREATEST(SUM(q), 0) AS owed FROM moves GROUP BY t
  )
  SELECT COALESCE(SUM(per.owed), 0), COALESCE(SUM(per.owed * COALESCE(e.unit_price, ct.jar_price, 0)), 0)
    INTO v_jugs_owed, v_jugs_owed_value
    FROM per
    JOIN container_types ct ON ct.id = per.t
    LEFT JOIN LATERAL public._jug_empty_product(ct.id, ct.factory_id) e ON true;

  SELECT COALESCE(SUM(rs.quantity * p.unit_price), 0) INTO v_van_value
  FROM rep_stock rs JOIN products p ON p.id = rs.product_id
  WHERE rs.sales_rep_id = p_sales_rep_id;

  SELECT COUNT(*), COALESCE(SUM(grand_total), 0) INTO v_sales_count, v_sales_value
  FROM sales
  WHERE sales_rep_id = p_sales_rep_id
    AND status = 'posted' AND deleted_at IS NULL AND NOT COALESCE(is_pr, false)
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
    'credit_collected', v_collected,
    'van_stock_value', v_van_value,
    'sales_count', v_sales_count,
    'sales_value', v_sales_value,
    'empty_jugs_returned', v_jugs_back,
    'empty_jugs_value', v_jugs_value,
    'jugs_owed', v_jugs_owed,
    'jugs_owed_value', v_jugs_owed_value,
    'net_balance_owed', v_goods_out - (v_accepted + v_written_off) - v_jugs_value + v_jugs_owed_value
                        - v_cash - v_credit - v_collected
  );
END;
$fn$;

-- ------------------------------------------------------------- 3. returns --
-- A return holding both types is written as two returns, so each type keeps
-- its own price; the core recording the stock is unchanged.
CREATE OR REPLACE FUNCTION public.create_rep_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, public._lagos_today());
  v_rep uuid := NULLIF(payload->>'sales_rep_id', '')::uuid;
  v_plain jsonb;
  v_jug jsonb;
  v_line record;
  v_first jsonb;
  v_second jsonb;
BEGIN
  -- The core's own rights first, so a day's status isn't told to anyone else.
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  PERFORM public._check_return_day(v_date, v_rep);

  SELECT COALESCE(jsonb_agg(e) FILTER (WHERE NULLIF(e->>'jar_mode', '') IS NULL), '[]'::jsonb),
         COALESCE(jsonb_agg(e) FILTER (WHERE e->>'jar_mode' = 'permanent'), '[]'::jsonb)
    INTO v_plain, v_jug
    FROM jsonb_array_elements(payload->'items') e;

  FOR v_line IN
    SELECT (e->>'product_id')::uuid AS pid, SUM((e->>'quantity_returned')::numeric) AS qty
      FROM jsonb_array_elements(v_jug) e GROUP BY 1
  LOOP
    IF v_line.qty > public._rep_jug_water_held(v_rep, v_line.pid) THEN
      RAISE EXCEPTION 'Only % Jug + Water was posted to them and not yet returned',
        trim_scale(public._rep_jug_water_held(v_rep, v_line.pid));
    END IF;
  END LOOP;

  IF jsonb_array_length(v_plain) > 0 OR jsonb_array_length(v_jug) = 0 THEN
    v_first := public._create_rep_return_core(payload || jsonb_build_object('return_date', v_date, 'items', v_plain));
    -- A plain return is priced as a plain posting, never at a Jug + Water line.
    UPDATE rep_return_items i
       SET unit_price = COALESCE(
             (SELECT p.unit_price - p.unit_discount
                FROM stock_dispatch_items p JOIN stock_dispatches d ON d.id = p.dispatch_id
               WHERE d.sales_rep_id = v_rep AND p.product_id = i.product_id
                 AND p.jar_mode IS NULL AND d.status::text <> 'reversed'
               ORDER BY d.created_at DESC LIMIT 1),
             (SELECT x.unit_price FROM products x WHERE x.id = i.product_id))
     WHERE i.rep_return_id = (v_first->>'id')::uuid
       AND EXISTS (SELECT 1 FROM stock_dispatch_items p JOIN stock_dispatches d ON d.id = p.dispatch_id
                    WHERE d.sales_rep_id = v_rep AND p.product_id = i.product_id AND p.jar_mode = 'permanent');
    IF v_date < public._lagos_today() THEN PERFORM public._redate_rep_return((v_first->>'id')::uuid, v_date); END IF;
  END IF;

  IF jsonb_array_length(v_jug) > 0 THEN
    v_second := public._create_rep_return_core(payload || jsonb_build_object('return_date', v_date, 'items', v_jug));
    -- Back at what it was posted at, so the account comes out level.
    UPDATE rep_return_items i
       SET jar_mode = 'permanent',
           unit_price = COALESCE(
             (SELECT p.unit_price - p.unit_discount
                FROM stock_dispatch_items p JOIN stock_dispatches d ON d.id = p.dispatch_id
               WHERE d.sales_rep_id = v_rep AND p.product_id = i.product_id
                 AND p.jar_mode = 'permanent' AND d.status::text <> 'reversed'
               ORDER BY d.created_at DESC LIMIT 1),
             public._posting_default_price(i.product_id, 'permanent', i.unit_price))
     WHERE i.rep_return_id = (v_second->>'id')::uuid;
    IF v_date < public._lagos_today() THEN PERFORM public._redate_rep_return((v_second->>'id')::uuid, v_date); END IF;
  END IF;

  IF v_first IS NULL THEN RETURN v_second; END IF;
  IF v_second IS NULL THEN RETURN v_first; END IF;
  RETURN v_first || jsonb_build_object('return_number', (v_first->>'return_number') || ' + ' || (v_second->>'return_number'));
END;
$fn$;
REVOKE ALL ON FUNCTION public.create_rep_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_rep_return(jsonb) TO authenticated;

-- ---------------------------------------------- 4. lists show the type --
CREATE OR REPLACE FUNCTION public.warehouse_activity(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(kind text, reference text, at timestamptz, party text, items text,
              quantity numeric, status text, posted_by text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Pick a from and to date';
  END IF;

  RETURN QUERY
  SELECT a.* FROM (
    SELECT CASE WHEN r.status = 'rejected' THEN 'refused' ELSE 'received' END,
           r.release_number,
           COALESCE(r.accepted_at, r.released_at),
           'Production'::text,
           pr.name || ' × ' || trim(to_char(COALESCE(r.accepted_quantity, r.quantity), 'FM999G999G990D###')),
           COALESCE(r.accepted_quantity, r.quantity),
           r.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = r.accepted_by)
      FROM production_releases r
      JOIN products pr ON pr.id = r.product_id
     WHERE r.factory_id = p_factory AND r.status IN ('accepted', 'rejected')

    UNION ALL
    SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END,
           d.dispatch_number,
           d.created_at,
           sr.full_name,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
             WHERE i.dispatch_id = d.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
           d.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = d.created_by)
      FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id
     WHERE d.factory_id = p_factory AND d.status <> 'reversed'

    UNION ALL
    SELECT CASE WHEN c.registered THEN 'distributor' ELSE 'sale' END,
           s.invoice_number,
           s.created_at,
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id
             WHERE i.sale_id = s.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i WHERE i.sale_id = s.id),
           s.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = s.created_by)
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL

    UNION ALL
    -- Stock corrections and counts on finished goods: one row per reference
    -- and person (a count touching several products is one row).
    SELECT 'adjusted',
           COALESCE(m.reference, 'Adjustment'),
           MIN(m.created_at),
           CASE WHEN bool_and(m.movement_type = 'opening_balance') THEN 'Balance brought forward'
                ELSE 'Stock correction' END,
           string_agg(p.name || ' ' || CASE WHEN m.quantity > 0 THEN '+' ELSE '' END
                      || trim(to_char(m.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name),
           SUM(m.quantity),
           'posted'::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = m.user_id)
      FROM inventory_movements m
      JOIN products p ON p.id = m.product_id AND p.product_type = 'finished'
     WHERE m.factory_id = p_factory
       AND m.movement_type IN ('adjusted', 'damaged', 'opening_balance')
     GROUP BY COALESCE(m.reference, 'Adjustment'), m.user_id,
              (m.created_at AT TIME ZONE 'Africa/Lagos')::date
  ) a(k, ref, ts, pty, its, qty, st, who)
  WHERE (a.ts AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to
  ORDER BY a.ts DESC
  LIMIT 2000;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.retail_activity(p_outlet uuid, p_from date, p_to date)
RETURNS TABLE(kind text, at timestamptz, reference text, party text, details text,
              amount numeric, paid numeric, balance numeric, method text, status text,
              sale_id uuid, dispatch_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE v_rep sales_reps%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' OR NOT public._works_in_factory(auth.uid(), v_rep.factory_id) THEN
    RAISE EXCEPTION 'Retail outlet not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a from and to date'; END IF;

  RETURN QUERY
  SELECT a.* FROM (
    SELECT 'Posting'::text AS k, d.created_at AS t, d.dispatch_number AS ref, 'From the Warehouse'::text AS who,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')) || ' ' || p.unit, ' · '
                              ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = d.id) AS info,
           d.total_value AS amt, NULL::numeric AS pd, NULL::numeric AS bal, NULL::text AS how, d.status AS st,
           NULL::uuid AS sid, d.id AS did
      FROM stock_dispatches d
     WHERE d.sales_rep_id = p_outlet AND d.dispatch_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Sale', s.created_at, s.invoice_number, COALESCE(NULLIF(btrim(s.customer_name), ''), 'Walk-in'),
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')) || ' ' || p.unit, ' · '
                              ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = s.id),
           s.grand_total, s.amount_paid, s.balance, s.payment_method::text,
           CASE WHEN COALESCE(s.is_pr, false) THEN 'PR' ELSE s.status::text END, s.id, NULL::uuid
      FROM sales s
     WHERE s.sales_rep_id = p_outlet AND s.deleted_at IS NULL AND s.sale_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Customer return', COALESCE(r.inspected_at, r.received_at), r.return_number,
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           p.name || ' × ' || trim(to_char(r.quantity_returned, 'FM999G999G990D###')) || ' ' || COALESCE(r.unit, p.unit)
             || CASE WHEN r.refund_amount > 0 THEN ' · refunded ' || trim(to_char(r.refund_amount, 'FM999G999G990'))
                     WHEN r.credit_added > 0 THEN ' · kept as credit ' || trim(to_char(r.credit_added, 'FM999G999G990'))
                     ELSE '' END,
           r.value, NULL::numeric, NULL::numeric, r.refund_method::text, r.status, r.sale_id, NULL::uuid
      FROM sales_returns r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN sales s ON s.id = r.sale_id
     WHERE r.sales_rep_id = p_outlet AND r.return_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Payment', pr.created_at, pr.receipt_number, COALESCE(c.name, s.customer_name, '—'),
           CASE WHEN s.invoice_number IS NOT NULL THEN 'On ' || s.invoice_number END,
           pr.amount, NULL::numeric, NULL::numeric, pr.payment_method::text, pr.status::text, pr.sale_id, NULL::uuid
      FROM payments_received pr
      LEFT JOIN customers c ON c.id = pr.customer_id
      LEFT JOIN sales s ON s.id = pr.sale_id
     WHERE pr.collected_by_rep = p_outlet AND NOT pr.at_point_of_sale
       AND pr.payment_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Return', COALESCE(x.received_at, x.created_at), x.return_number, 'To the Warehouse',
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity_returned, 'FM999G999G990D###')) || ' ' || p.unit,
                              ' · ' ORDER BY p.name)
              FROM rep_return_items i JOIN products p ON p.id = i.product_id WHERE i.rep_return_id = x.id),
           (SELECT COALESCE(SUM(i.quantity_returned * i.unit_price), 0) FROM rep_return_items i WHERE i.rep_return_id = x.id),
           NULL::numeric, NULL::numeric, NULL::text, x.status, NULL::uuid, NULL::uuid
      FROM rep_returns x
     WHERE x.sales_rep_id = p_outlet AND x.return_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Cash remitted', m.created_at, m.remittance_number, 'Handed in', m.remarks,
           m.amount, NULL::numeric, NULL::numeric, m.payment_method::text, 'received', NULL::uuid, NULL::uuid
      FROM rep_remittances m
     WHERE m.sales_rep_id = p_outlet AND m.remittance_date BETWEEN p_from AND p_to
  ) a
  ORDER BY a.t DESC NULLS LAST
  LIMIT 2000;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.warehouse_transactions(p_factory uuid, p_limit int DEFAULT 200, p_party uuid DEFAULT NULL)
RETURNS TABLE(kind text, reference text, at timestamptz, party_type text, party_id uuid, party text,
              items text, quantity numeric, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  RETURN QUERY
  SELECT a.* FROM (
    SELECT CASE WHEN r.status = 'rejected' THEN 'refused' ELSE 'received' END AS k,
           r.release_number AS ref, COALESCE(r.accepted_at, r.released_at) AS t,
           'production'::text AS ptype, NULL::uuid AS pid, 'Production'::text AS who,
           pr.name || ' × ' || trim(to_char(COALESCE(r.accepted_quantity, r.quantity), 'FM999G999G990D###')) AS info,
           COALESCE(r.accepted_quantity, r.quantity) AS qty, r.status::text AS st
      FROM production_releases r
      JOIN products pr ON pr.id = r.product_id
     WHERE r.factory_id = p_factory AND r.status IN ('accepted', 'rejected') AND p_party IS NULL

    UNION ALL
    SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, d.dispatch_number, d.created_at,
           CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, sr.id, sr.full_name,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = d.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
           d.status
      FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id
     WHERE d.factory_id = p_factory AND d.status <> 'reversed' AND (p_party IS NULL OR sr.id = p_party)

    UNION ALL
    SELECT CASE WHEN c.registered THEN 'distributor' ELSE 'sale' END, s.invoice_number, s.created_at,
           CASE WHEN c.registered THEN 'distributor' ELSE 'walk_in' END, c.id,
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = s.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i WHERE i.sale_id = s.id),
           s.status::text
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
       AND (p_party IS NULL OR c.id = p_party)

    UNION ALL
    SELECT 'returned', x.return_number, COALESCE(x.received_at, x.created_at),
           CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, sr.id, sr.full_name,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity_returned, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM rep_return_items i JOIN products p ON p.id = i.product_id WHERE i.rep_return_id = x.id),
           (SELECT COALESCE(SUM(i.quantity_returned), 0) FROM rep_return_items i WHERE i.rep_return_id = x.id),
           x.status
      FROM rep_returns x
      JOIN sales_reps sr ON sr.id = x.sales_rep_id
     WHERE x.factory_id = p_factory AND x.status <> 'cancelled' AND (p_party IS NULL OR sr.id = p_party)

    UNION ALL
    SELECT 'customer_return', r.return_number, COALESCE(r.inspected_at, r.received_at),
           CASE WHEN c.registered THEN 'distributor' ELSE 'walk_in' END, c.id,
           COALESCE(c.name, 'Customer'),
           p.name || ' × ' || trim(to_char(r.quantity_returned, 'FM999G999G990D###')),
           r.quantity_returned, r.status
      FROM sales_returns r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.factory_id = p_factory AND r.sales_rep_id IS NULL AND r.status <> 'cancelled'
       AND (p_party IS NULL OR c.id = p_party)

    UNION ALL
    SELECT 'jugs_returned', j.reference, j.recorded_at,
           CASE WHEN j.customer_id IS NOT NULL THEN 'distributor'
                WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END,
           COALESCE(j.sales_rep_id, j.customer_id), COALESCE(sr.full_name, c.name),
           'Empty ' || ct.name || ' × ' || trim(to_char(j.quantity_claimed, 'FM999G999G990'))
             || CASE WHEN j.status = 'verified' THEN ' (QC counted ' || trim(to_char(j.quantity_received, 'FM999G999G990')) || ')'
                     ELSE '' END,
           j.quantity_claimed, j.status
      FROM jug_returns j
      JOIN container_types ct ON ct.id = j.container_type_id
      LEFT JOIN sales_reps sr ON sr.id = j.sales_rep_id
      LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.factory_id = p_factory AND j.status <> 'cancelled'
       AND (p_party IS NULL OR j.sales_rep_id = p_party OR j.customer_id = p_party)
  ) a
  ORDER BY a.t DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 2000);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.accounting_postings(p_factory uuid, p_limit int DEFAULT 300)
RETURNS TABLE(kind text, posting_kind text, posting_id uuid, reference text, at timestamptz,
              party_id uuid, party text, items text, value numeric, paid numeric,
              balance numeric, status text, assessed_at timestamptz, assessed_by text,
              assessment_remarks text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT a.*, pa.assessed_at, pf.full_name, pa.remarks
    FROM (
      SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END AS kind,
             'dispatch'::text AS posting_kind,
             d.id AS posting_id,
             d.dispatch_number AS reference,
             d.created_at AS at,
             sr.id AS party_id,
             sr.full_name AS party,
             (SELECT string_agg(public._posting_item(public._sale_line_name(p.name, i.jar_mode), i.quantity, i.unit_price), ', ' ORDER BY p.name)
                FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
               WHERE i.dispatch_id = d.id) AS items,
             COALESCE((SELECT SUM(i.line_value) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
                      d.total_value)::numeric AS value,
             NULL::numeric AS paid,
             NULL::numeric AS balance,
             d.status AS status
        FROM stock_dispatches d
        JOIN sales_reps sr ON sr.id = d.sales_rep_id
       WHERE d.factory_id = p_factory

      UNION ALL
      SELECT 'distributor', 'sale', s.id, s.invoice_number, s.created_at,
             c.id, c.name,
             (SELECT string_agg(public._posting_item(public._sale_line_name(p.name, i.jar_mode), i.quantity, i.unit_price), ', ' ORDER BY p.name)
                FROM sale_items i JOIN products p ON p.id = i.product_id
               WHERE i.sale_id = s.id),
             s.grand_total::numeric, s.amount_paid::numeric, s.balance::numeric, s.status::text
        FROM sales s
        JOIN customers c ON c.id = s.customer_id AND c.registered
       WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
         AND NOT COALESCE(s.is_pr, false)

      -- Chairman's gifts: value at cost, nothing to pay.
      UNION ALL
      SELECT 'chairmans_gift', 'gift', g.id, g.gift_number, g.created_at,
             NULL::uuid, COALESCE(g.recipient, 'Chairman''s request'),
             (SELECT string_agg(public._posting_item(p.name, i.quantity, i.unit_cost), ', ' ORDER BY p.name)
                FROM chairmans_gift_items i JOIN products p ON p.id = i.product_id
               WHERE i.gift_id = g.id),
             g.total_value::numeric, NULL::numeric, NULL::numeric, g.status
        FROM chairmans_gifts g
       WHERE g.factory_id = p_factory
    ) a
    LEFT JOIN posting_assessments pa ON pa.posting_kind = a.posting_kind AND pa.posting_id = a.posting_id
    LEFT JOIN profiles pf ON pf.id = pa.assessed_by
   ORDER BY a.at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 300), 1), 1000);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.accounting_postings_between(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(kind text, posting_kind text, posting_id uuid, reference text, at timestamptz,
              party_id uuid, party text, items text, value numeric, paid numeric,
              balance numeric, status text, assessed_at timestamptz, assessed_by text,
              assessment_remarks text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;

  RETURN QUERY
  SELECT a.*, pa.assessed_at, pf.full_name, pa.remarks
    FROM (
      SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END AS kind,
             'dispatch'::text AS posting_kind,
             d.id AS posting_id,
             d.dispatch_number AS reference,
             d.created_at AS at,
             sr.id AS party_id,
             sr.full_name AS party,
             (SELECT string_agg(public._posting_item(public._sale_line_name(p.name, i.jar_mode), i.quantity, i.unit_price), ', ' ORDER BY p.name)
                FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
               WHERE i.dispatch_id = d.id) AS items,
             COALESCE((SELECT SUM(i.line_value) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
                      d.total_value)::numeric AS value,
             NULL::numeric AS paid,
             NULL::numeric AS balance,
             d.status AS status
        FROM stock_dispatches d
        JOIN sales_reps sr ON sr.id = d.sales_rep_id
       WHERE d.factory_id = p_factory

      UNION ALL
      SELECT 'distributor', 'sale', s.id, s.invoice_number, s.created_at,
             c.id, c.name,
             (SELECT string_agg(public._posting_item(public._sale_line_name(p.name, i.jar_mode), i.quantity, i.unit_price), ', ' ORDER BY p.name)
                FROM sale_items i JOIN products p ON p.id = i.product_id
               WHERE i.sale_id = s.id),
             s.grand_total::numeric, s.amount_paid::numeric, s.balance::numeric, s.status::text
        FROM sales s
        JOIN customers c ON c.id = s.customer_id AND c.registered
       WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
         AND NOT COALESCE(s.is_pr, false)

      -- Chairman's gifts: value at cost, nothing to pay.
      UNION ALL
      SELECT 'chairmans_gift', 'gift', g.id, g.gift_number, g.created_at,
             NULL::uuid, COALESCE(g.recipient, 'Chairman''s request'),
             (SELECT string_agg(public._posting_item(p.name, i.quantity, i.unit_cost), ', ' ORDER BY p.name)
                FROM chairmans_gift_items i JOIN products p ON p.id = i.product_id
               WHERE i.gift_id = g.id),
             g.total_value::numeric, NULL::numeric, NULL::numeric, g.status
        FROM chairmans_gifts g
       WHERE g.factory_id = p_factory
    ) a
    LEFT JOIN posting_assessments pa ON pa.posting_kind = a.posting_kind AND pa.posting_id = a.posting_id
    LEFT JOIN profiles pf ON pf.id = pa.assessed_by
   WHERE (a.at AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to
   ORDER BY a.at DESC;
END;
$fn$;

-- ----------------------------------------------------- 5. the day close --
-- Dispenser Water's one stock shown as its two types, with Empty Jug always
-- listed. Jug + Water sold beyond what was posted as Jug + Water came off the
-- Dispenser Water stock; the rows still add up to the one stock.
CREATE OR REPLACE FUNCTION public._outlet_split_dispenser(p_outlet uuid, p_date date, p_products jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_factory uuid := (SELECT factory_id FROM sales_reps WHERE id = p_outlet);
  v_water products%ROWTYPE;
  v_empty products%ROWTYPE;
  v_row jsonb;
  v_day record;
  v_held numeric := 0;
  v_in numeric := 0;
  v_sold numeric := 0;
  v_open numeric;
  v_close numeric;
  v_moved numeric;
  v_value numeric;
  v_out jsonb;
BEGIN
  SELECT * INTO v_water FROM products
   WHERE factory_id = v_factory AND active AND lower(btrim(name)) = 'dispenser water'
   ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN RETURN p_products; END IF;

  SELECT x INTO v_row FROM jsonb_array_elements(p_products) x WHERE x->>'product_id' = v_water.id::text;
  v_row := COALESCE(v_row, jsonb_build_object(
    'product_id', v_water.id, 'name', v_water.name, 'unit', v_water.unit, 'unit_price', v_water.unit_price,
    'opening', 0, 'received', 0, 'sold', 0, 'returned', 0, 'damaged', 0, 'corrections', 0,
    'closing', 0, 'sold_value', 0));

  FOR v_day IN
    SELECT x.d, SUM(x.posted) AS posted, SUM(x.sold) AS sold
      FROM (
        SELECT (d.created_at AT TIME ZONE 'Africa/Lagos')::date AS d, i.quantity AS posted, 0::numeric AS sold
          FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
         WHERE d.sales_rep_id = p_outlet AND d.status::text <> 'reversed'
           AND i.product_id = v_water.id AND i.jar_mode = 'permanent'
        UNION ALL
        SELECT (s.created_at AT TIME ZONE 'Africa/Lagos')::date, 0, si.quantity
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.sales_rep_id = p_outlet AND s.status = 'posted' AND s.deleted_at IS NULL
           AND si.product_id = v_water.id AND si.jar_mode = 'permanent'
      ) x
     WHERE x.d <= p_date
     GROUP BY x.d ORDER BY x.d
  LOOP
    IF v_day.d < p_date THEN
      v_held := GREATEST(v_held + v_day.posted - v_day.sold, 0);
    ELSE
      v_in := v_day.posted;
      v_sold := v_day.sold;
    END IF;
  END LOOP;

  v_open := LEAST(v_held, GREATEST((v_row->>'opening')::numeric, 0));
  v_close := LEAST(GREATEST(v_open + v_in - v_sold, 0), GREATEST((v_row->>'closing')::numeric, 0));
  v_moved := v_close - (v_open + v_in - v_sold);

  SELECT COALESCE(SUM(si.line_total), 0) INTO v_value
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
   WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
     AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
     AND si.product_id = v_water.id AND si.jar_mode = 'permanent';

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_out
    FROM jsonb_array_elements(p_products) x WHERE x->>'product_id' <> v_water.id::text;

  v_out := v_out
    || jsonb_build_array(v_row || jsonb_build_object(
         'opening', (v_row->>'opening')::numeric - v_open,
         'received', (v_row->>'received')::numeric - v_in,
         'sold', (v_row->>'sold')::numeric - v_sold,
         'closing', (v_row->>'closing')::numeric - v_close,
         'sold_value', (v_row->>'sold_value')::numeric - v_value,
         'note', CASE WHEN v_moved > 0 THEN format('%s sold as Jug + Water from this stock', trim_scale(v_moved)) END))
    || jsonb_build_array(jsonb_build_object(
         'product_id', v_water.id::text || ':jug_water', 'name', 'Jug + Water', 'unit', v_water.unit,
         'unit_price', v_water.unit_price,
         'opening', v_open, 'received', v_in, 'sold', v_sold, 'returned', 0, 'damaged', 0, 'corrections', 0,
         'closing', v_close, 'sold_value', v_value,
         'note', CASE WHEN v_moved > 0 THEN format('%s taken from Dispenser Water stock', trim_scale(v_moved)) END));

  SELECT * INTO v_empty FROM products
   WHERE factory_id = v_factory AND active AND lower(btrim(name)) = 'empty jug'
   ORDER BY created_at LIMIT 1;
  IF FOUND AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_out) x WHERE x->>'product_id' = v_empty.id::text) THEN
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'product_id', v_empty.id, 'name', v_empty.name, 'unit', v_empty.unit, 'unit_price', v_empty.unit_price,
      'opening', 0, 'received', 0, 'sold', 0, 'returned', 0, 'damaged', 0, 'corrections', 0,
      'closing', 0, 'sold_value', 0));
  END IF;

  RETURN (SELECT jsonb_agg(x ORDER BY x->>'name') FROM jsonb_array_elements(v_out) x);
END;
$fn$;
REVOKE ALL ON FUNCTION public._outlet_split_dispenser(uuid, date, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._outlet_day_figures(p_outlet uuid, p_date date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_products jsonb;
  v_stock jsonb;
  v_money jsonb;
  v_held_before numeric;
  v_remit_before numeric;
  v_remit_day numeric;
  v_pending int;
  v_ref_cash numeric;
  v_ref_other numeric;
  v_rev jsonb;
BEGIN
  WITH mv AS (
    SELECT m.product_id, m.movement_type, m.quantity AS delta,
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM rep_stock_movements m
     WHERE m.sales_rep_id = p_outlet AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date <= p_date
  ), st AS (
    SELECT product_id,
      COALESCE(SUM(delta) FILTER (WHERE d < p_date), 0) AS opening,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'dispatch_in'), 0) AS received,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'sold'), 0) AS sold,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'returned_out'), 0) AS returned,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'damaged_out'), 0) AS damaged,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND movement_type IN ('reversal', 'adjustment')), 0) AS corrections,
      COALESCE(SUM(delta), 0) AS closing
    FROM mv GROUP BY product_id
  ), sv AS (
    SELECT si.product_id, SUM(si.line_total) AS value
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
       AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
     GROUP BY si.product_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'unit', p.unit, 'unit_price', p.unit_price,
           'opening', st.opening, 'received', st.received, 'sold', st.sold,
           'returned', st.returned, 'damaged', st.damaged, 'corrections', st.corrections,
           'closing', st.closing, 'sold_value', COALESCE(sv.value, 0)
         ) ORDER BY p.name), '[]'::jsonb)
    INTO v_products
    FROM st JOIN products p ON p.id = st.product_id
    LEFT JOIN sv ON sv.product_id = st.product_id
   WHERE st.opening <> 0 OR st.received <> 0 OR st.sold <> 0 OR st.returned <> 0
      OR st.damaged <> 0 OR st.corrections <> 0 OR st.closing <> 0;

  SELECT jsonb_build_object(
    'opening', COALESCE(SUM((x->>'opening')::numeric), 0),
    'received', COALESCE(SUM((x->>'received')::numeric), 0),
    'sold', COALESCE(SUM((x->>'sold')::numeric), 0),
    'returned', COALESCE(SUM((x->>'returned')::numeric), 0),
    'damaged', COALESCE(SUM((x->>'damaged')::numeric), 0),
    'corrections', COALESCE(SUM((x->>'corrections')::numeric), 0),
    'closing', COALESCE(SUM((x->>'closing')::numeric), 0),
    'closing_value', COALESCE(SUM((x->>'closing')::numeric * (x->>'unit_price')::numeric), 0))
    INTO v_stock FROM jsonb_array_elements(v_products) x;

  -- Money the shop took on the day, by method: at the till with the day's
  -- sales, plus payments it received later on earlier unpaid sales (Receive
  -- on Retail › POS, stamped collected_by_rep = the shop -- 20261030110000).
  -- The day's credit sales count the till only.
  WITH s AS (
    SELECT s.id, s.grand_total, s.credit_applied
      FROM sales s
     WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
       AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
  ), p AS (
    SELECT p.payment_method, p.amount
      FROM payments_received p JOIN s ON s.id = p.sale_id
     WHERE p.at_point_of_sale AND p.status NOT IN ('reversed', 'rejected')
  ), c AS (
    SELECT p.payment_method, p.amount
      FROM payments_received p
     WHERE p.collected_by_rep = p_outlet AND NOT p.at_point_of_sale AND p.payment_date = p_date
       AND p.status NOT IN ('reversed', 'rejected')
  ), pc AS (
    SELECT * FROM p UNION ALL SELECT * FROM c
  )
  SELECT jsonb_build_object(
    'sales_count', (SELECT COUNT(*) FROM s),
    'sales_value', (SELECT COALESCE(SUM(grand_total), 0) FROM s),
    'advance_applied', (SELECT COALESCE(SUM(credit_applied), 0) FROM s),
    'cash_expected', (SELECT COALESCE(SUM(amount), 0) FROM pc WHERE payment_method = 'cash'),
    'other_expected', (SELECT COALESCE(SUM(amount), 0) FROM pc WHERE payment_method <> 'cash'),
    'collections_cash', (SELECT COALESCE(SUM(amount), 0) FROM c WHERE payment_method = 'cash'),
    'collections_other', (SELECT COALESCE(SUM(amount), 0) FROM c WHERE payment_method <> 'cash'),
    'credit_sales', GREATEST((SELECT COALESCE(SUM(grand_total - credit_applied), 0) FROM s)
                             - (SELECT COALESCE(SUM(amount), 0) FROM p), 0),
    'by_method', (SELECT COALESCE(jsonb_object_agg(m, amt), '{}'::jsonb)
                    FROM (SELECT payment_method::text AS m, SUM(amount) AS amt FROM pc GROUP BY payment_method) q))
    INTO v_money;

  -- Money handed back to customers for goods they returned on the day
  -- (record_retail_return, 20261029290000) comes off what the shop should
  -- hand over.
  SELECT COALESCE(SUM(refund_amount) FILTER (WHERE refund_method = 'cash'), 0),
         COALESCE(SUM(refund_amount) FILTER (WHERE refund_method IS DISTINCT FROM 'cash'), 0)
    INTO v_ref_cash, v_ref_other
    FROM sales_returns
   WHERE sales_rep_id = p_outlet AND return_date = p_date AND status = 'completed' AND refund_amount > 0;
  v_money := v_money || jsonb_build_object(
    'refunds_cash', v_ref_cash, 'refunds_other', v_ref_other,
    'cash_expected', (v_money->>'cash_expected')::numeric - v_ref_cash,
    'other_expected', (v_money->>'other_expected')::numeric - v_ref_other);

  -- Revenue by kind (2026-11-02). A line's jar part is quantity x
  -- jar_unit_price (the jug type's jar price, fixed on a Permanent line at
  -- the sale); the rest of every line is water. Invoice discounts, VAT and
  -- later price corrections are "adjustments", so the parts add up to
  -- sales_value.
  SELECT jsonb_build_object(
    'water_revenue', COALESCE(SUM(si.line_total - si.quantity * si.jar_unit_price), 0),
    'dispenser_water_revenue', COALESCE(SUM(si.line_total - si.quantity * si.jar_unit_price)
                                          FILTER (WHERE j.container_type_id IS NOT NULL), 0),
    'jar_revenue', COALESCE(SUM(si.quantity * si.jar_unit_price), 0),
    'dispensers_sold', COALESCE(SUM(si.quantity) FILTER (WHERE j.container_type_id IS NOT NULL), 0),
    'sold_return_later', COALESCE(SUM(si.quantity) FILTER (WHERE si.jar_mode = 'return_later'), 0),
    'sold_permanent', COALESCE(SUM(si.quantity) FILTER (WHERE si.jar_mode = 'permanent'), 0),
    'sold_swap', COALESCE(SUM(si.quantity) FILTER (WHERE si.jar_mode = 'swap'), 0),
    'jars_sold', COALESCE(SUM(si.quantity * j.per_unit) FILTER (WHERE si.jar_mode = 'permanent'), 0))
    INTO v_rev
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN LATERAL public._product_jug(si.product_id) j ON true
   WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
     AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false);
  v_rev := v_rev || jsonb_build_object('adjustments',
    (v_money->>'sales_value')::numeric - (v_rev->>'water_revenue')::numeric - (v_rev->>'jar_revenue')::numeric);
  v_money := v_money || jsonb_build_object('revenue', v_rev);

  -- Earlier money the outlet took but has not yet handed over (information
  -- only: the day's expected figures are the day's own takings).
  SELECT COALESCE(SUM(p.amount), 0) INTO v_held_before
    FROM payments_received p LEFT JOIN sales s ON s.id = p.sale_id
   WHERE p.status NOT IN ('reversed', 'rejected')
     AND ((p.at_point_of_sale AND s.sales_rep_id = p_outlet AND s.deleted_at IS NULL AND s.sale_date < p_date)
       OR (NOT p.at_point_of_sale AND p.collected_by_rep = p_outlet AND p.payment_date < p_date));
  SELECT COALESCE(SUM(amount), 0) INTO v_remit_before FROM rep_remittances
   WHERE sales_rep_id = p_outlet AND remittance_date < p_date;
  SELECT COALESCE(SUM(amount), 0) INTO v_remit_day FROM rep_remittances
   WHERE sales_rep_id = p_outlet AND remittance_date = p_date;

  SELECT COUNT(*) INTO v_pending FROM sales
   WHERE sales_rep_id = p_outlet AND sale_date = p_date AND status = 'pending_approval' AND deleted_at IS NULL;

  v_products := public._outlet_split_dispenser(p_outlet, p_date, v_products);

  RETURN jsonb_build_object(
    'date', p_date, 'products', v_products, 'stock', v_stock, 'money', v_money,
    'unremitted_before', v_held_before - v_remit_before,
    'remitted_on_day', v_remit_day,
    'pending_sales', v_pending);
END;
$fn$;

NOTIFY pgrst, 'reload schema';

-- Read-only check: both columns are in.
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name = 'jar_mode'
   AND table_name IN ('stock_dispatch_items', 'rep_return_items');
