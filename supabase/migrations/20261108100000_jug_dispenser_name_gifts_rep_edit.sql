-- ============================================================================
-- 8 Nov 2026 fixes (user, 2026-11-08)
-- ----------------------------------------------------------------------------
-- 1. Gift/Sample on the Warehouse "All Products Report" stayed 0: the report
--    only counted lines whose reason starts 'PR - complimentary'. A Chairman's
--    gift (post_chairmans_gift, 20261017090000) writes its stock line as
--    "Chairman's gift ..." with reference CGF-..., so it fell into Qty Out.
--    Now both count as Gift/Sample (the Balance does not change), and
--    warehouse_gift_details(factory, day) lists each gift / sample line --
--    number, kind, given to, product, quantity, value, notes, who posted it.
-- 2. "Jug + Dispenser": a dispenser sold with its jug for good (sale_items
--    .jar_mode = 'permanent') is named "Jug + <product>" by
--    sale_invoice_lines() -- Accountant, invoices, monthly sales, customer
--    activity -- and the line's jar_mode is returned too.
-- 3. Accounts edits a marketer's / outlet's name, phone, address and remarks
--    (sales_reps.address is new) through update_rep_details, without needing
--    Distribution edit rights; every change goes to the audit log. A
--    marketer's customers are edited the same way (update_marketer_customer).
-- 4. Chairman's gifts are worth their SELLING price (not cost), never revenue;
--    gifts already posted are re-valued once at today's price.
-- 0. Indexes on inventory_movements, and the From / To products report
--    (warehouse_products_report(factory, from, to)) the live database lacked.
-- Run once (re-running re-values old gifts at the prices of that day). Paste the whole file into the Supabase SQL Editor.
-- ============================================================================

-- ------------------------------------------------------------- 0. speed --
-- inventory_movements had no index but its key, so every report read the
-- whole table (user, 2026-11-08: "should not take long").
CREATE INDEX IF NOT EXISTS inventory_movements_factory_at_idx
  ON public.inventory_movements(factory_id, created_at);
CREATE INDEX IF NOT EXISTS inventory_movements_product_at_idx
  ON public.inventory_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS inventory_movements_reference_idx
  ON public.inventory_movements(reference);

-- ---------------------------------------------------------------- 1. gifts --
CREATE OR REPLACE FUNCTION public._is_gift_movement(p_reason text, p_reference text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_reason, '') ILIKE 'PR - complimentary%'
      OR COALESCE(p_reason, '') ILIKE 'Chairman''s gift%'
      OR COALESCE(p_reference, '') LIKE 'CGF-%';
$$;

CREATE OR REPLACE FUNCTION public.warehouse_products_report(p_factory uuid, p_date date)
RETURNS TABLE(product_id uuid, product text, unit text, opening numeric, qty_in numeric,
              total numeric, qty_out numeric, returned numeric, gift numeric,
              adjusted numeric, balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_date IS NULL THEN RAISE EXCEPTION 'Pick a day'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT m.product_id AS pid,
           COALESCE(m.quantity_after - m.quantity_before,
                    CASE WHEN m.movement_type::text IN ('sold', 'issued', 'transferred', 'damaged', 'used_for_production')
                         THEN -abs(m.quantity) ELSE m.quantity END) AS delta,
           m.movement_type::text AS mtype,
           COALESCE(m.reason, '') AS reason,
           COALESCE(m.reference, '') AS ref,
           m.created_at AS at,
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM inventory_movements m
     WHERE m.factory_id = p_factory
       -- A plain time bound (not a cast of created_at) so the index is used.
       AND m.created_at >= (p_date::timestamp AT TIME ZONE 'Africa/Lagos')
  ), sn AS (
    SELECT s.*, public._report_snapshot_cutoff(s.product_id, s.report_date) AS cutoff
      FROM warehouse_report_snapshots s
     WHERE s.factory_id = p_factory AND s.report_date = p_date
  ), cls AS (
    SELECT mv.pid, mv.delta, mv.d,
           (mv.d = p_date AND (sn.product_id IS NULL OR mv.at > sn.cutoff)) AS counts,
           CASE WHEN public._is_gift_movement(mv.reason, mv.ref) AND mv.delta < 0 THEN 'gift'
                WHEN mv.mtype = 'returned' THEN 'returned'
                WHEN mv.mtype IN ('adjusted', 'opening_balance') THEN 'adjusted'
                WHEN mv.delta > 0 THEN 'in'
                ELSE 'out' END AS col
      FROM mv LEFT JOIN sn ON sn.product_id = mv.pid
  ), day AS (
    SELECT pid,
      COALESCE(SUM(delta) FILTER (WHERE d > p_date), 0) AS after_day,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date), 0) AS on_day,
      COALESCE(SUM(delta) FILTER (WHERE counts), 0) AS counted,
      COALESCE(SUM(-delta) FILTER (WHERE counts AND col = 'gift'), 0) AS gift,
      COALESCE(SUM(delta) FILTER (WHERE counts AND col = 'returned'), 0) AS returned,
      COALESCE(SUM(delta) FILTER (WHERE counts AND col = 'adjusted'), 0) AS adjusted,
      COALESCE(SUM(delta) FILTER (WHERE counts AND col = 'in'), 0) AS qty_in,
      COALESCE(SUM(-delta) FILTER (WHERE counts AND col = 'out'), 0) AS qty_out
      FROM cls GROUP BY pid
  )
  SELECT p.id, p.name, p.unit,
         COALESCE(sn.opening, p.current_stock - COALESCE(dy.after_day, 0) - COALESCE(dy.on_day, 0)),
         COALESCE(sn.qty_in, 0) + COALESCE(dy.qty_in, 0),
         COALESCE(sn.opening, p.current_stock - COALESCE(dy.after_day, 0) - COALESCE(dy.on_day, 0))
           + COALESCE(sn.qty_in, 0) + COALESCE(dy.qty_in, 0),
         COALESCE(sn.qty_out, 0) + COALESCE(dy.qty_out, 0),
         COALESCE(sn.returned, 0) + COALESCE(dy.returned, 0),
         COALESCE(sn.gift, 0) + COALESCE(dy.gift, 0),
         COALESCE(dy.adjusted, 0),
         CASE WHEN sn.product_id IS NULL THEN p.current_stock - COALESCE(dy.after_day, 0)
              ELSE sn.balance + COALESCE(dy.counted, 0) END
    FROM products p
    LEFT JOIN day dy ON dy.pid = p.id
    LEFT JOIN sn ON sn.product_id = p.id
   WHERE p.factory_id = p_factory AND p.product_type = 'finished' AND p.active
   ORDER BY p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_products_report(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_products_report(uuid, date) TO authenticated;

-- Warehouse Overview -> "Products report" (From / To): missing on the live
-- database ("Could not find the function public.warehouse_products_report(
-- p_factory, p_from, p_to)"), so nothing showed from 1 Nov. Same columns as
-- before plus Adjusted, sorted the day report's way: Opening + In - Out -
-- Gift + Returned + Adjusted = Balance. One pass over the range's lines.
DROP FUNCTION IF EXISTS public.warehouse_products_report(uuid, date, date);
CREATE FUNCTION public.warehouse_products_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(product_id uuid, product_name text, unit text,
              opening numeric, qty_in numeric, qty_out numeric, gift numeric,
              returned numeric, sold numeric, empty_jug_sold numeric, adjusted numeric,
              balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start timestamptz := p_from::timestamp AT TIME ZONE 'Africa/Lagos';
  v_end timestamptz := (p_to + 1)::timestamp AT TIME ZONE 'Africa/Lagos';
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT m.product_id AS pid,
           COALESCE(m.quantity_after - m.quantity_before,
                    CASE WHEN m.movement_type::text IN ('sold', 'issued', 'transferred', 'damaged', 'used_for_production')
                         THEN -abs(m.quantity) ELSE m.quantity END) AS delta,
           m.movement_type::text AS mtype,
           COALESCE(m.reason, '') AS reason,
           COALESCE(m.reference, '') AS ref,
           m.created_at < v_end AS in_range
      FROM inventory_movements m
     WHERE m.factory_id = p_factory AND m.created_at >= v_start
  ), cls AS (
    SELECT mv.pid, mv.delta, mv.in_range,
           CASE WHEN public._is_gift_movement(mv.reason, mv.ref) AND mv.delta < 0 THEN 'gift'
                WHEN mv.mtype = 'returned' THEN 'returned'
                WHEN mv.mtype IN ('adjusted', 'opening_balance') THEN 'adjusted'
                WHEN mv.delta > 0 THEN 'in'
                ELSE 'out' END AS col
      FROM mv
  ), agg AS (
    SELECT pid,
      COALESCE(SUM(delta), 0) AS after_start,
      COALESCE(SUM(delta) FILTER (WHERE NOT in_range), 0) AS after_end,
      COALESCE(SUM(delta) FILTER (WHERE in_range AND col = 'in'), 0) AS q_in,
      COALESCE(SUM(-delta) FILTER (WHERE in_range AND col = 'out'), 0) AS q_out,
      COALESCE(SUM(-delta) FILTER (WHERE in_range AND col = 'gift'), 0) AS q_gift,
      COALESCE(SUM(delta) FILTER (WHERE in_range AND col = 'returned'), 0) AS q_ret,
      COALESCE(SUM(delta) FILTER (WHERE in_range AND col = 'adjusted'), 0) AS q_adj
      FROM cls GROUP BY pid
  ), w AS (
    SELECT p.id AS pid, p.name::text AS pname, p.unit::text AS punit,
           p.current_stock - COALESCE(a.after_start, 0) AS op,
           COALESCE(a.q_in, 0) AS q_in, COALESCE(a.q_out, 0) AS q_out,
           COALESCE(a.q_gift, 0) AS q_gift, COALESCE(a.q_ret, 0) AS q_ret,
           COALESCE(a.q_adj, 0) AS q_adj,
           p.current_stock - COALESCE(a.after_end, 0) AS bal
      FROM products p LEFT JOIN agg a ON a.pid = p.id
     WHERE p.factory_id = p_factory AND p.product_type = 'finished' AND p.active
  ), jug AS (
    SELECT COALESCE(SUM(w.q_out - w.q_ret), 0) AS jug_sold FROM w
     WHERE lower(btrim(w.pname)) IN ('empty jug', 'dispenser empty')
  ), first_dispenser AS (
    SELECT w.pid FROM w WHERE w.pname ILIKE 'dispenser%' AND w.pname NOT ILIKE '%empty%'
     ORDER BY w.pname LIMIT 1
  )
  SELECT w.pid, w.pname, w.punit, w.op, w.q_in, w.q_out, w.q_gift, w.q_ret,
         GREATEST(w.q_out - w.q_ret, 0),
         CASE WHEN w.pid = (SELECT first_dispenser.pid FROM first_dispenser)
              THEN (SELECT jug.jug_sold FROM jug) ELSE 0 END,
         w.q_adj, w.bal
    FROM w
   WHERE lower(btrim(w.pname)) NOT IN ('empty jug', 'dispenser empty')
     AND (w.op <> 0 OR w.q_in <> 0 OR w.q_out <> 0 OR w.q_gift <> 0 OR w.q_ret <> 0
          OR w.q_adj <> 0 OR w.bal <> 0)
   ORDER BY w.pname;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_products_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_products_report(uuid, date, date) TO authenticated;

-- Each gift / sample line that left the Warehouse from p_from to p_to (by
-- the day it was keyed in, as the report counts it).
DROP FUNCTION IF EXISTS public.warehouse_gift_details(uuid, date, date);
CREATE FUNCTION public.warehouse_gift_details(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(at timestamptz, day date, reference text, kind text, given_to text,
              product_id uuid, product text, unit text, quantity numeric,
              unit_cost numeric, value numeric, notes text, posted_by text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Not your factory'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick the days'; END IF;

  RETURN QUERY
  SELECT m.created_at,
         (m.created_at AT TIME ZONE 'Africa/Lagos')::date,
         COALESCE(m.reference, '')::text,
         (CASE WHEN g.id IS NOT NULL OR COALESCE(m.reference, '') LIKE 'CGF-%'
                 OR COALESCE(m.reason, '') ILIKE 'Chairman''s gift%'
               THEN 'Chairman''s gift' ELSE 'PR / Sample' END)::text,
         COALESCE(g.recipient, s.customer_name, '')::text,
         p.id, p.name::text, p.unit::text,
         abs(COALESCE(m.quantity_after - m.quantity_before, -abs(m.quantity))),
         COALESCE(gi.unit_cost, p.unit_price, 0),
         abs(COALESCE(m.quantity_after - m.quantity_before, -abs(m.quantity)))
           * COALESCE(gi.unit_cost, p.unit_price, 0),
         COALESCE(g.notes, s.remarks, '')::text,
         COALESCE(pr.full_name, pr.email, '')::text
    FROM inventory_movements m
    JOIN products p ON p.id = m.product_id
    LEFT JOIN chairmans_gifts g ON g.gift_number = m.reference AND g.factory_id = m.factory_id
    LEFT JOIN LATERAL (SELECT gi2.unit_cost FROM chairmans_gift_items gi2
                        WHERE gi2.gift_id = g.id AND gi2.product_id = m.product_id LIMIT 1) gi ON true
    LEFT JOIN sales s ON s.invoice_number = m.reference AND s.factory_id = m.factory_id AND g.id IS NULL
    LEFT JOIN profiles pr ON pr.id = m.user_id
   WHERE m.factory_id = p_factory
     AND m.created_at >= (p_from::timestamp AT TIME ZONE 'Africa/Lagos')
     AND m.created_at < ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Lagos')
     AND public._is_gift_movement(m.reason, m.reference)
     AND COALESCE(m.quantity_after - m.quantity_before, -abs(m.quantity)) < 0
   ORDER BY m.created_at, p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_gift_details(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_gift_details(uuid, date, date) TO authenticated;

-- ------------------------------------------------------ 2. Jug + Dispenser --
DROP FUNCTION IF EXISTS public.sale_invoice_lines(uuid[]);
CREATE FUNCTION public.sale_invoice_lines(p_sales uuid[])
RETURNS TABLE(sale_id uuid, product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric,
              item_id uuid, discount numeric, surcharge numeric, unit_discount numeric, unit_surcharge numeric,
              jar_mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF COALESCE(array_length(p_sales, 1), 0) > 1000 THEN RAISE EXCEPTION 'At most 1000 sales at a time'; END IF;

  RETURN QUERY
  SELECT si.sale_id,
         (CASE WHEN si.jar_mode = 'permanent' AND COALESCE(p.name, '') NOT ILIKE 'Jug +%'
               THEN 'Jug + ' || COALESCE(p.name, '-')
               ELSE COALESCE(p.name, '-') END)::text,
         COALESCE(p.unit, '')::text,
         si.quantity, si.unit_price, si.line_total, si.id, si.discount, si.surcharge,
         si.unit_discount, si.unit_surcharge, si.jar_mode::text
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN products p ON p.id = si.product_id
   WHERE si.sale_id = ANY(p_sales)
     AND public._works_in_factory(auth.uid(), s.factory_id)
   ORDER BY si.sale_id, si.id;
END;
$$;
REVOKE ALL ON FUNCTION public.sale_invoice_lines(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sale_invoice_lines(uuid[]) TO authenticated;

-- ------------------------------------------- 3. Accounts edits marketers --
ALTER TABLE public.sales_reps ADD COLUMN IF NOT EXISTS address text;

CREATE OR REPLACE FUNCTION public.update_rep_details(
  p_id uuid, p_full_name text, p_phone text, p_address text, p_remarks text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old public.sales_reps%ROWTYPE;
  v_name text := NULLIF(btrim(COALESCE(p_full_name, '')), '');
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'edit'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_old FROM sales_reps WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT public._works_in_factory(auth.uid(), v_old.factory_id) THEN
    RAISE EXCEPTION 'Marketer not found';
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Name is required'; END IF;

  UPDATE sales_reps
     SET full_name = v_name,
         phone = NULLIF(btrim(COALESCE(p_phone, '')), ''),
         address = NULLIF(btrim(COALESCE(p_address, '')), ''),
         remarks = NULLIF(btrim(COALESCE(p_remarks, '')), ''),
         updated_at = now()
   WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_old.factory_id, 'update', 'sales_reps', p_id::text,
          jsonb_build_object('full_name', v_old.full_name, 'phone', v_old.phone,
                             'address', v_old.address, 'remarks', v_old.remarks),
          jsonb_build_object('full_name', v_name, 'phone', NULLIF(btrim(COALESCE(p_phone, '')), ''),
                             'address', NULLIF(btrim(COALESCE(p_address, '')), ''),
                             'remarks', NULLIF(btrim(COALESCE(p_remarks, '')), '')));
END;
$$;
REVOKE ALL ON FUNCTION public.update_rep_details(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_rep_details(uuid, text, text, text, text) TO authenticated;

-- A marketer's customer: Accounts / Distribution edit the name, phone,
-- address and email from the marketer's "Customers of ..." list (user,
-- 2026-11-08). Read through a function too: an accountant may not read the
-- customers table directly.
CREATE OR REPLACE FUNCTION public._can_edit_marketer_customer()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'distribution'::module_key, 'edit'::action_key)
      OR public.has_permission(auth.uid(), 'customers'::module_key, 'edit'::action_key)
      OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key);
$$;
REVOKE ALL ON FUNCTION public._can_edit_marketer_customer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._can_edit_marketer_customer() TO authenticated;

DROP FUNCTION IF EXISTS public.marketer_customer_details(uuid);
CREATE FUNCTION public.marketer_customer_details(p_customer uuid)
RETURNS TABLE(id uuid, name text, phone text, address text, email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._can_edit_marketer_customer() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT c.id, c.name::text, c.phone::text, c.address::text, c.email::text
    FROM customers c
   WHERE c.id = p_customer AND public._works_in_factory(auth.uid(), c.factory_id);
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_customer_details(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_customer_details(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_marketer_customer(
  p_customer uuid, p_name text, p_phone text, p_address text, p_email text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old public.customers%ROWTYPE;
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_phone text := NULLIF(btrim(COALESCE(p_phone, '')), '');
  v_address text := NULLIF(btrim(COALESCE(p_address, '')), '');
  v_email text := NULLIF(btrim(COALESCE(p_email, '')), '');
BEGIN
  IF NOT public._can_edit_marketer_customer() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_old FROM customers WHERE id = p_customer FOR UPDATE;
  IF NOT FOUND OR NOT public._works_in_factory(auth.uid(), v_old.factory_id) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Name is required'; END IF;

  UPDATE customers
     SET name = v_name, phone = v_phone, address = v_address, email = v_email, updated_at = now()
   WHERE id = p_customer;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_old.factory_id, 'update', 'customers', p_customer::text,
          jsonb_build_object('name', v_old.name, 'phone', v_old.phone,
                             'address', v_old.address, 'email', v_old.email),
          jsonb_build_object('name', v_name, 'phone', v_phone, 'address', v_address, 'email', v_email));
END;
$$;
REVOKE ALL ON FUNCTION public.update_marketer_customer(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_marketer_customer(uuid, text, text, text, text) TO authenticated;

-- ---------------------------------------- 4. Chairman's gift at selling price --
-- User (2026-11-08): a gift is worth what the products sell for (the price
-- the Warehouse / Retail Shop post at), not their cost. Still no revenue and
-- nothing to pay. post_chairmans_gift now values each line at the product's
-- selling price; gifts already posted are re-valued at today's selling price
-- (their price on the day was not kept), logged in the audit log.
CREATE OR REPLACE FUNCTION public.post_chairmans_gift(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'gift_date','')::date, CURRENT_DATE);
  v_recipient text := NULLIF(btrim(COALESCE(payload->>'recipient','')), '');
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes','')), '');
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_product public.products%ROWTYPE;
  v_qty numeric;
  v_cost numeric;
  v_total numeric := 0;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'Add at least one product'; END IF;

  -- Validate every line first (all-or-nothing).
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_product.current_stock < v_qty THEN
      RAISE EXCEPTION 'Insufficient warehouse stock for %: have %, need %', v_product.name, v_product.current_stock, v_qty;
    END IF;
  END LOOP;

  v_number := 'CGF-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
  INSERT INTO chairmans_gifts(factory_id, gift_number, gift_date, recipient, notes, created_by)
  VALUES (v_factory, v_number, v_date, v_recipient, v_notes, v_uid)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;
    v_qty := (v_item->>'quantity')::numeric;
    -- Valued at the product's selling price -- the price the Warehouse /
    -- Retail Shop post at (user, 2026-11-08) -- never typed in. Still not
    -- revenue: nothing is billed. (Stored in unit_cost / line_value.)
    v_cost := COALESCE(v_product.unit_price, 0);
    v_total := v_total + v_qty * v_cost;

    INSERT INTO chairmans_gift_items(gift_id, product_id, quantity, unit_cost, line_value)
    VALUES (v_id, v_product.id, v_qty, v_cost, v_qty * v_cost);

    UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = v_product.id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_product.id, 'issued', v_qty, v_number,
            'Chairman''s gift' || COALESCE(' to ' || v_recipient, ''), v_uid,
            v_product.current_stock, v_product.current_stock - v_qty);
  END LOOP;

  UPDATE chairmans_gifts SET total_value = v_total WHERE id = v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'post_chairmans_gift', 'chairmans_gift', v_id::text,
          jsonb_build_object('gift_number', v_number, 'recipient', v_recipient, 'total_value', v_total));

  RETURN jsonb_build_object('id', v_id, 'gift_number', v_number, 'total_value', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.post_chairmans_gift(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_chairmans_gift(jsonb) TO authenticated;

DO $$
DECLARE v_changed jsonb;
BEGIN
  IF to_regclass('public.chairmans_gifts') IS NULL THEN RETURN; END IF;
  SELECT jsonb_agg(jsonb_build_object('gift', g.gift_number, 'was', g.total_value))
    INTO v_changed
    FROM chairmans_gifts g
   WHERE g.total_value IS DISTINCT FROM (
         SELECT COALESCE(SUM(i.quantity * COALESCE(p.unit_price, 0)), 0)
           FROM chairmans_gift_items i JOIN products p ON p.id = i.product_id
          WHERE i.gift_id = g.id);

  UPDATE chairmans_gift_items i
     SET unit_cost = COALESCE(p.unit_price, 0),
         line_value = i.quantity * COALESCE(p.unit_price, 0)
    FROM products p
   WHERE p.id = i.product_id;
  UPDATE chairmans_gifts g
     SET total_value = COALESCE((SELECT SUM(i.line_value) FROM chairmans_gift_items i
                                  WHERE i.gift_id = g.id), 0);

  IF v_changed IS NOT NULL THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), (SELECT id FROM factories WHERE code = 'water'), 'update', 'chairmans_gifts',
            'REVALUE-AT-SELLING-PRICE-2026-11-08', jsonb_build_object('gifts', v_changed));
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Read-only check: every function above is in.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('warehouse_products_report', 'warehouse_gift_details', 'sale_invoice_lines',
                     'update_rep_details', '_is_gift_movement', 'update_marketer_customer',
                     'marketer_customer_details')
 ORDER BY 1;
