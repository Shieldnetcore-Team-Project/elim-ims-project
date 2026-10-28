-- ============================================================================
-- Warehouse: restock (Sachet Water), products report, and Gideon's rights
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-28):
--
-- 1. warehouse_restock(payload) -- the Warehouse adds stock of a product that
--    doesn't come through Production, e.g. Sachet Water: stock goes up at
--    once, with a 'received' ledger line (RST-...) and an audit row. Bottle
--    Water and Dispenser Water are refused: they reach the Warehouse only as
--    production releases (Production Releases to Accept). Needs
--    finished-goods:create.
--      payload: { factory_id, product_id, quantity, notes? }
--
-- 2. warehouse_products_report(p_factory, p_from, p_to) -- one row per
--    finished product for the days p_from..p_to (Lagos time), in the
--    factory's "WAREHOUSE: PRODUCTS REPORT" layout:
--      opening    stock at the start of p_from
--      qty_in     received into the Warehouse: production releases accepted,
--                 restocks, and stock counts / adjustments (net)
--      qty_out    goods sent out: postings to marketers / the retail shop and
--                 direct sales (a posting reversed or corrected is taken back
--                 out of this, not counted as a return)
--      gift       Chairman's gifts and PR / complimentary sales
--      returned   goods that came back: marketer returns, accepted sales
--                 returns
--      sold       qty_out - returned
--      balance    opening + qty_in - sold - gift  (= stock at the end of p_to)
--    Empty Jug is not a row of its own: what of it went out shows as
--    empty_jug_sold on the Dispenser Water row. Products with no stock and no
--    movement in the period are left out. Needs finished-goods:view.
--
-- 3. Gideon (gideonsunday24@gmail.com, Warehouse Manager) may restock
--    (finished-goods:create) and accept / refuse Production Releases --
--    Dispenser Water from the Production Manager included
--    (production:confirm, production:reject) -- as per-user rights; his role
--    is not changed. The Warehouse page is allowed in his page access.
-- ============================================================================

-- ---- 1. Restock ----
CREATE OR REPLACE FUNCTION public.warehouse_restock(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  SELECT name INTO v_category FROM product_categories WHERE id = v_product.category_id;
  IF lower(COALESCE(v_category, '')) IN ('bottle water', 'dispenser water')
     OR v_product.name ILIKE '%bottle water%' OR v_product.name ILIKE 'dispenser%' THEN
    RAISE EXCEPTION '% comes from Production -- accept it under Production Releases to Accept', v_product.name;
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
$$;
REVOKE ALL ON FUNCTION public.warehouse_restock(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_restock(jsonb) TO authenticated;

-- ---- 2. Products report ----
CREATE OR REPLACE FUNCTION public.warehouse_products_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(product_id uuid, product_name text, unit text,
              opening numeric, qty_in numeric, qty_out numeric, gift numeric,
              returned numeric, sold numeric, empty_jug_sold numeric, balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start timestamptz := (p_from::timestamp) AT TIME ZONE 'Africa/Lagos';
  v_end timestamptz := ((p_to + 1)::timestamp) AT TIME ZONE 'Africa/Lagos';
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;

  RETURN QUERY
  WITH w AS (
    SELECT p.id AS pid, p.name AS pname, p.unit AS punit, p.current_stock AS cur,
           COALESCE(SUM(m.d) FILTER (WHERE m.created_at >= v_start), 0) AS after_start,
           COALESCE(SUM(m.d) FILTER (WHERE m.created_at >= v_end), 0) AS after_end,
           COALESCE(SUM(m.d) FILTER (WHERE m.in_range AND m.cls = 'in'), 0) AS q_in,
           COALESCE(SUM(-m.d) FILTER (WHERE m.in_range AND m.cls = 'out'), 0) AS q_out,
           COALESCE(SUM(-m.d) FILTER (WHERE m.in_range AND m.cls = 'gift'), 0) AS q_gift,
           COALESCE(SUM(m.d) FILTER (WHERE m.in_range AND m.cls = 'returned'), 0) AS q_ret
      FROM products p
      LEFT JOIN LATERAL (
        SELECT im.created_at,
               im.quantity_after - im.quantity_before AS d,
               im.created_at >= v_start AND im.created_at < v_end AS in_range,
               CASE
                 WHEN im.movement_type = 'dispatched_to_rep' THEN 'out'
                 WHEN im.movement_type = 'sold' AND im.reason ILIKE 'PR%' THEN 'gift'
                 WHEN im.movement_type = 'sold' THEN 'out'
                 WHEN im.movement_type = 'issued' THEN 'gift'
                 -- A posting reversed / corrected comes back under the posting's
                 -- own number: it cancels that posting, it isn't a return.
                 WHEN im.movement_type = 'return_from_rep'
                      AND EXISTS (SELECT 1 FROM stock_dispatches sd
                                   WHERE sd.dispatch_number = im.reference) THEN 'out'
                 WHEN im.movement_type IN ('return_from_rep', 'returned') THEN 'returned'
                 ELSE 'in'
               END AS cls
          FROM inventory_movements im
         WHERE im.product_id = p.id AND im.created_at >= v_start
      ) m ON true
     WHERE p.factory_id = p_factory AND p.product_type = 'finished'
     GROUP BY p.id, p.name, p.unit, p.current_stock
  ), jug AS (
    SELECT COALESCE(SUM(w.q_out - w.q_ret), 0) AS jug_sold FROM w WHERE lower(btrim(w.pname)) = 'empty jug'
  )
  SELECT w.pid, w.pname, w.punit,
         w.cur - w.after_start,
         w.q_in, w.q_out, w.q_gift, w.q_ret,
         w.q_out - w.q_ret,
         CASE WHEN w.pname ILIKE 'dispenser%' THEN (SELECT jug.jug_sold FROM jug) ELSE 0 END,
         w.cur - w.after_end
    FROM w
   WHERE lower(btrim(w.pname)) <> 'empty jug'
     AND (w.cur - w.after_start <> 0 OR w.q_in <> 0 OR w.q_out <> 0
          OR w.q_gift <> 0 OR w.q_ret <> 0 OR w.cur - w.after_end <> 0)
   ORDER BY w.pname;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_products_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_products_report(uuid, date, date) TO authenticated;

-- ---- 3. Gideon's rights ----
DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
BEGIN
  SELECT count(*) INTO v_count FROM profiles WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com';
  IF v_count <> 1 THEN
    RAISE NOTICE 'Skipped: % accounts have gideonsunday24@gmail.com -- give the rights in Admin Panel → Users', v_count;
    RETURN;
  END IF;
  SELECT id, COALESCE(full_name, email) INTO v_user, v_name FROM profiles
   WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com';

  INSERT INTO permission_overrides (user_id, module, action, granted) VALUES
    (v_user, 'finished-goods', 'create', true),
    (v_user, 'production', 'confirm', true),
    (v_user, 'production', 'reject', true)
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();
  INSERT INTO user_page_access (user_id, page_id, granted)
  VALUES (v_user, 'Warehouse › Stock', true)
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant_permission', 'permission_overrides', v_user::text,
          jsonb_build_object('rights', jsonb_build_array('finished-goods:create', 'production:confirm', 'production:reject'),
                             'page', 'Warehouse › Stock',
                             'reason', format('%s restocks Sachet Water and accepts Production Releases (2026-10-28)', v_name)));
  RAISE NOTICE '% can now restock and accept Production Releases', v_name;
END $$;
