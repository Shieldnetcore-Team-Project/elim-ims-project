-- ============================================================================
-- Customer contact on invoices, and the three dispenser names
-- ----------------------------------------------------------------------------
-- User (2026-11-09):
-- 1. The invoice's BILLED TO box carries the customer's contact and address
--    from their account, and staff can enter those on any customer.
--      customer_contact / update_customer_contact: phone and address only
--      (audit-logged) for whoever works with customers: Customers edit,
--      Marketer & Retail Accounts edit,
--      Distribution create / edit, Accounts (finance view) or Sales create.
-- 2. One set of names everywhere: Dispenser Water N1,200 -- Jug + Water N4,200
--    -- Empty Jug N3,000 (a company buying jugs only).
--      * the empty-jug product (Dispenser Empty) is renamed Empty Jug and stays
--        a finished product the Warehouse posts to any channel;
--      * a Jug + Water sale line (one Dispenser Water stock, jar_mode
--        'permanent') reads "Jug + Water" on every list and invoice;
--      * Accounts' postings show each line's name, quantity and price;
--      * Empty Jug is restocked in the Warehouse like Sachet Water, and the
--        officers who handle dispensers handle it too;
--      * selling an Empty Jug takes the jug out of the ledger: the buyer owes
--        none back. A marketer or shop still answers for those on their stock.
-- Past invoices and postings keep their amounts. Safe to run again.
-- Paste the whole file into the Supabase SQL Editor (run without RLS).
-- ============================================================================

-- -------------------------------------------------------- 1. helper names --
CREATE OR REPLACE FUNCTION public._sale_line_name(p_name text, p_jar_mode text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN p_jar_mode = 'permanent' THEN 'Jug + Water' ELSE p_name END;
$fn$;

CREATE OR REPLACE FUNCTION public._posting_item(p_name text, p_quantity numeric, p_price numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p_name || ' × ' || rtrim(to_char(p_quantity, 'FM999G999G990D###'), '.')
      || ' @ ' || rtrim(to_char(COALESCE(p_price, 0), 'FM999G999G990D##'), '.');
$fn$;

-- ------------------------------------------------ 2. the Empty Jug product --
CREATE OR REPLACE FUNCTION public._adopt_empty_jug_name()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_factory record;
  v_keep uuid;
  v_other record;
  v_category uuid;
BEGIN
  FOR v_factory IN SELECT id, code FROM factories LOOP
    -- Dispenser Empty (or an already renamed Empty Jug); a live product first.
    SELECT p.id INTO v_keep
      FROM products p
     WHERE p.factory_id = v_factory.id
       AND lower(btrim(p.name)) IN ('dispenser empty', 'empty jug')
     ORDER BY p.active DESC, (lower(btrim(p.name)) = 'dispenser empty') DESC, p.created_at
     LIMIT 1;

    IF v_keep IS NULL THEN
      IF v_factory.code <> 'water' THEN CONTINUE; END IF;
      SELECT id INTO v_category FROM product_categories
       WHERE factory_id = v_factory.id AND name IN ('Dispenser/Jug Water', 'Dispenser Water')
       ORDER BY name LIMIT 1;
      INSERT INTO products(factory_id, name, unit, unit_price, product_type, category_id, active)
      VALUES (v_factory.id, 'Empty Jug', 'Piece', 3000, 'finished', v_category, true)
      RETURNING id INTO v_keep;
    ELSE
      -- The name is unique per factory: a retired twin steps aside first.
      FOR v_other IN
        SELECT id, name, current_stock FROM products
         WHERE factory_id = v_factory.id AND id <> v_keep
           AND lower(btrim(name)) IN ('dispenser empty', 'empty jug')
      LOOP
        UPDATE products
           SET name = 'Retired ' || v_other.name || ' ' || left(v_other.id::text, 8),
               active = CASE WHEN v_other.current_stock = 0 THEN false ELSE active END,
               updated_at = now()
         WHERE id = v_other.id;
        IF v_other.current_stock <> 0 THEN
          RAISE NOTICE '% still holds % in stock under its retired name -- move it to Empty Jug', v_other.name, v_other.current_stock;
        END IF;
      END LOOP;

      UPDATE products
         SET name = 'Empty Jug', active = true, product_type = 'finished',
             unit_price = CASE WHEN COALESCE(unit_price, 0) = 0 THEN 3000 ELSE unit_price END,
             updated_at = now()
       WHERE id = v_keep;
    END IF;
  END LOOP;

  IF to_regprocedure('public._link_empty_jug_products()') IS NOT NULL THEN
    PERFORM public._link_empty_jug_products();
  END IF;

  -- Whoever handles dispensers handles what they are now called and sold as.
  IF to_regclass('public.user_product_rules') IS NOT NULL THEN
    INSERT INTO user_product_rules(user_id, name_pattern, label)
    SELECT DISTINCT r.user_id, 'empty jug|jug \+ water', 'Empty Jug / Jug + Water'
      FROM user_product_rules r WHERE r.name_pattern ~* 'dispenser'
    ON CONFLICT (user_id, name_pattern) DO NOTHING;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public._adopt_empty_jug_name() FROM PUBLIC, anon, authenticated;
SELECT public._adopt_empty_jug_name();

-- ----------------------------- 3. An Empty Jug sold outright owes no jug --
CREATE OR REPLACE FUNCTION public._is_empty_jug_product(p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $q$
  SELECT EXISTS (SELECT 1 FROM product_containers pc WHERE pc.product_id = p_product AND pc.jug_role = 'empty');
$q$;
REVOKE ALL ON FUNCTION public._is_empty_jug_product(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._containers_on_sale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
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
        -- An Empty Jug is bought outright: the buyer keeps it, nothing is owed.
        IF NEW.customer_id IS NOT NULL AND public._is_empty_jug_product(v_item.product_id) THEN
          PERFORM public._container_move_for_product(NEW.factory_id, v_item.product_id, v_item.quantity,
            'customer', NEW.customer_id, 'external', NULL,
            'jar_sold', NEW.invoice_number, NEW.id, NULL, NULL, NULL);
        END IF;
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
$fn$;

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

  -- Jug ledger: posting the sale sent a jug Warehouse -> customer -> outside
  -- ('jar_sold'). These jugs were already with the customer, so the Warehouse
  -- gets its one back.
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, quantity, source,
                                  reference, sale_id, notes, created_by)
  VALUES (v_cust.factory_id, v_type, 'customer', v_cust.id, 'warehouse', v_qty, 'count', v_inv, v_sale_id,
          'Sold on with the water -- kept by their customers', v_uid);

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

-- ------------------------------------- 4. Empty Jug stock into the Warehouse --
CREATE OR REPLACE FUNCTION public.warehouse_restock(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(payload->>'notes'), '');
  v_product products%ROWTYPE;
  v_category text;
  v_number text;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be more than 0'; END IF;
  SELECT * INTO v_product FROM products WHERE id = (payload->>'product_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to this factory'; END IF;
  IF v_product.product_type <> 'finished' OR NOT v_product.active THEN
    RAISE EXCEPTION '% can''t be restocked here', v_product.name;
  END IF;
  IF NOT public._user_may_handle_product(v_uid, v_product.id) THEN
    RAISE EXCEPTION '% is not one of your products -- it is handled by another Warehouse officer', v_product.name;
  END IF;
  SELECT name INTO v_category FROM product_categories WHERE id = v_product.category_id;
  IF NOT (v_product.name ~* '(sachet|satchet)' OR lower(COALESCE(v_category, '')) = 'sachet water'
          OR lower(btrim(v_product.name)) = 'empty jug') THEN
    RAISE EXCEPTION 'Only Sachet Water and Empty Jug are restocked in the Warehouse -- % comes in another way (Production Releases, marketer returns, or the Store)', v_product.name;
  END IF;

  v_number := 'RST-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_product.id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_factory, v_product.id, 'received', v_qty, v_number,
          COALESCE('Restocked: ' || v_notes, 'Restocked'), v_uid,
          v_product.current_stock, v_product.current_stock + v_qty);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'warehouse_restock', 'products', v_product.id::text,
          jsonb_build_object('reference', v_number, 'product', v_product.name, 'quantity', v_qty,
                             'unit', v_product.unit, 'notes', v_notes));
  RETURN jsonb_build_object('reference', v_number, 'stock', v_product.current_stock + v_qty);
END;
$fn$;

-- Its own row on the products report (Opening + In - Out ... = Balance).
CREATE OR REPLACE FUNCTION public.warehouse_products_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(product_id uuid, product_name text, unit text,
              opening numeric, qty_in numeric, qty_out numeric, gift numeric,
              returned numeric, sold numeric, empty_jug_sold numeric, adjusted numeric,
              balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
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
  )
  SELECT w.pid, w.pname, w.punit, w.op, w.q_in, w.q_out, w.q_gift, w.q_ret,
         GREATEST(w.q_out - w.q_ret, 0),
         CASE WHEN lower(btrim(w.pname)) = 'empty jug' THEN GREATEST(w.q_out - w.q_ret, 0) ELSE 0 END,
         w.q_adj, w.bal
    FROM w
   WHERE (w.op <> 0 OR w.q_in <> 0 OR w.q_out <> 0 OR w.q_gift <> 0 OR w.q_ret <> 0
          OR w.q_adj <> 0 OR w.bal <> 0)
   ORDER BY w.pname;
END;
$fn$;

-- ---------------------------------------- 5. "Jug + Water" on every list --
CREATE OR REPLACE FUNCTION public.sale_invoice_lines(p_sales uuid[])
RETURNS TABLE(sale_id uuid, product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric,
              item_id uuid, discount numeric, surcharge numeric, unit_discount numeric, unit_surcharge numeric,
              jar_mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF COALESCE(array_length(p_sales, 1), 0) > 1000 THEN RAISE EXCEPTION 'At most 1000 sales at a time'; END IF;

  RETURN QUERY
  SELECT si.sale_id,
         public._sale_line_name(COALESCE(p.name, '-'), si.jar_mode)::text,
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
$fn$;
REVOKE ALL ON FUNCTION public.sale_invoice_lines(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sale_invoice_lines(uuid[]) TO authenticated;

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
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
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
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')) || ' ' || p.unit, ' · '
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
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity_returned, 'FM999G999G990D###')) || ' ' || p.unit,
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
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
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
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity_returned, 'FM999G999G990D###')), ', ' ORDER BY p.name)
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

-- ------------------------------------- 6. Accounts: each line with its price --
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
             (SELECT string_agg(public._posting_item(p.name, i.quantity, i.unit_price), ', ' ORDER BY p.name)
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
             (SELECT string_agg(public._posting_item(p.name, i.quantity, i.unit_price), ', ' ORDER BY p.name)
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

-- ----------------------------------------------- 7. Customer contact details --
CREATE OR REPLACE FUNCTION public.sale_invoice_party(p_sale uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_sale sales%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public._marketer_can_view(COALESCE(
            (SELECT account_rep_id FROM sales WHERE id = p_sale),
            (SELECT sales_rep_id FROM sales WHERE id = p_sale)), true)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_sale FROM sales WHERE id = p_sale;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

  RETURN jsonb_build_object(
    'seller', (SELECT jsonb_build_object('id', r.id, 'code', r.code, 'name', r.full_name, 'kind', r.kind)
                 FROM sales_reps r WHERE r.id = v_sale.sales_rep_id),
    'owner', (SELECT jsonb_build_object('id', r.id, 'code', r.code, 'name', r.full_name, 'kind', r.kind)
                FROM sales_reps r WHERE r.id = v_sale.account_rep_id),
    'customer', (SELECT jsonb_build_object(
                   'code', c.code,
                   'registered', c.registered,
                   'phone', c.phone,
                   'address', c.address
                 )
                   FROM customers c WHERE c.id = v_sale.customer_id),
    'delivered', EXISTS (SELECT 1 FROM deliveries d WHERE d.sale_id = p_sale AND d.status <> 'cancelled'));
END;
$fn$;
REVOKE ALL ON FUNCTION public.sale_invoice_party(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sale_invoice_party(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public._can_edit_customer_contact()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.has_permission(auth.uid(), 'customers'::module_key, 'edit'::action_key)
      OR public.has_permission(auth.uid(), 'distribution'::module_key, 'create'::action_key)
      OR public.has_permission(auth.uid(), 'distribution'::module_key, 'edit'::action_key)
      OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'edit'::action_key)
      OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'sales'::module_key, 'create'::action_key);
$fn$;
REVOKE ALL ON FUNCTION public._can_edit_customer_contact() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._can_edit_customer_contact() TO authenticated;

DROP FUNCTION IF EXISTS public.customer_contact(uuid);
CREATE FUNCTION public.customer_contact(p_customer uuid)
RETURNS TABLE(id uuid, name text, phone text, address text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT public._can_edit_customer_contact() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT c.id, c.name::text, c.phone::text, c.address::text
    FROM customers c
   WHERE c.id = p_customer AND public._works_in_factory(auth.uid(), c.factory_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.customer_contact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_contact(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_customer_contact(p_customer uuid, p_phone text, p_address text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_old public.customers%ROWTYPE;
  v_phone text := NULLIF(btrim(COALESCE(p_phone, '')), '');
  v_address text := NULLIF(btrim(COALESCE(p_address, '')), '');
BEGIN
  IF NOT public._can_edit_customer_contact() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_old FROM customers WHERE id = p_customer FOR UPDATE;
  IF NOT FOUND OR NOT public._works_in_factory(auth.uid(), v_old.factory_id) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  UPDATE customers SET phone = v_phone, address = v_address, updated_at = now() WHERE id = p_customer;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_old.factory_id, 'update', 'customers', p_customer::text,
          jsonb_build_object('phone', v_old.phone, 'address', v_old.address),
          jsonb_build_object('phone', v_phone, 'address', v_address));
END;
$fn$;
REVOKE ALL ON FUNCTION public.update_customer_contact(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_customer_contact(uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Read-only check: the three names and their prices as now on Costing.
SELECT 'Dispenser Water' AS name, p.unit_price AS price, p.current_stock AS warehouse_stock
  FROM products p WHERE lower(btrim(p.name)) = 'dispenser water' AND p.active
UNION ALL
SELECT 'Jug + Water', w.unit_price + e.unit_price, NULL
  FROM products w JOIN products e ON e.factory_id = w.factory_id AND lower(btrim(e.name)) = 'empty jug'
 WHERE lower(btrim(w.name)) = 'dispenser water' AND w.active
UNION ALL
SELECT 'Empty Jug', p.unit_price, p.current_stock
  FROM products p WHERE lower(btrim(p.name)) = 'empty jug' AND p.active;
