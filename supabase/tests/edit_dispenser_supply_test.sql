-- ============================================================================
-- Acceptance tests: 20261113120000_edit_dispenser_supply.sql
--   A Warehouse Manager lowers a dispenser supply on the same posting
--   (distributor invoice or marketer posting): stock back, money and jugs
--   down by the same amount; nothing else can be edited, nobody else can.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7700000-0000-0000-0000-000000000001', 'edsfac', 'EDS Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a7700000-0000-0000-0000-000000000001', 'manager@eds'),
  ('a7700000-0000-0000-0000-000000000002', 'officer@eds'),
  ('a7700000-0000-0000-0000-000000000003', 'admin@eds');
DELETE FROM user_roles WHERE user_id IN ('a7700000-0000-0000-0000-000000000001', 'a7700000-0000-0000-0000-000000000002',
                                         'a7700000-0000-0000-0000-000000000003');
INSERT INTO user_roles(user_id, role) VALUES
  ('a7700000-0000-0000-0000-000000000001', 'warehouse_manager'),
  ('a7700000-0000-0000-0000-000000000002', 'store_officer'),
  ('a7700000-0000-0000-0000-000000000003', 'super_admin');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'EDS Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 1000, 'finished'),
  ('b7700000-0000-0000-0000-000000000002', 'f7700000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 3000, 0, 'finished'),
  ('b7700000-0000-0000-0000-000000000003', 'f7700000-0000-0000-0000-000000000001', '75cl Bottle Water', 'Pack', 1700, 500, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b7700000-0000-0000-0000-000000000001', 'e7700000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b7700000-0000-0000-0000-000000000002', 'e7700000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO customers(id, factory_id, name, registered) VALUES
  ('d7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'EDS Medix', true);
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'EDS Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a7700000-0000-0000-0000-000000000003', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p text) RETURNS numeric LANGUAGE sql AS
  $$ SELECT current_stock FROM products WHERE id = ('b7700000-0000-0000-0000-00000000000' || p)::uuid $$;
-- Jugs held by a party (to - from).
CREATE OR REPLACE FUNCTION pg_temp.jugs(p_type text, p_id uuid) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(sum(CASE WHEN to_type = p_type AND to_id IS NOT DISTINCT FROM p_id THEN quantity
                           WHEN from_type = p_type AND from_id IS NOT DISTINCT FROM p_id THEN -quantity ELSE 0 END), 0)
    FROM container_movements WHERE container_type_id = 'e7700000-0000-0000-0000-000000000001';
$$;
-- A posting to the distributor, posted at once.
CREATE OR REPLACE FUNCTION pg_temp.post(p_items jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := public.create_sale(jsonb_build_object('factory_id', 'f7700000-0000-0000-0000-000000000001',
         'customer_id', 'd7700000-0000-0000-0000-000000000001', 'customer_name', 'EDS Medix',
         'sale_date', (now() AT TIME ZONE 'Africa/Lagos')::date, 'payments', '[]'::jsonb, 'items', p_items));
  IF v->>'status' = 'pending_approval' THEN PERFORM public._post_sale((v->>'sale_id')::uuid, 'test'); END IF;
  RETURN (v->>'sale_id')::uuid;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_sale uuid, p_mode text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM sale_items WHERE sale_id = p_sale AND jar_mode IS NOT DISTINCT FROM p_mode LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION pg_temp.fails(p_sql text, p_like text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT ILIKE p_like THEN RAISE EXCEPTION 'wrong error: %', SQLERRM; END IF;
  RETURN true;
END $$;

-- @@ Test 1: distributor -- Dispenser Water 440 -> 421 on the same invoice
DO $$
DECLARE s uuid; inv text; tot numeric; bal numeric; cust numeric; jugs_before numeric;
  w uuid := 'b7700000-0000-0000-0000-000000000001'; b uuid := 'b7700000-0000-0000-0000-000000000003';
BEGIN
  s := pg_temp.post(jsonb_build_array(
         jsonb_build_object('product_id', w, 'quantity', 440, 'unit_price', 1200, 'jar_mode', 'swap'),
         jsonb_build_object('product_id', w, 'quantity', 19, 'jar_mode', 'permanent'),
         jsonb_build_object('product_id', b, 'quantity', 150, 'unit_price', 1700)));
  SELECT invoice_number, grand_total, balance INTO inv, tot, bal FROM sales WHERE id = s;
  cust := (SELECT outstanding_balance FROM customers WHERE id = 'd7700000-0000-0000-0000-000000000001');
  jugs_before := pg_temp.jugs('external', NULL);
  PERFORM pg_temp.check(pg_temp.stock('1') = 1000 - 459, 'stock after posting');

  SELECT set_config('test.uid', 'a7700000-0000-0000-0000-000000000001', false) INTO inv;
  inv := (SELECT invoice_number FROM sales WHERE id = s);
  PERFORM public.edit_dispenser_supply('sale', s,
            jsonb_build_array(jsonb_build_object('item_id', pg_temp.item(s, 'swap'), 'quantity', 421)),
            'only 421 empties');
  PERFORM pg_temp.check((SELECT invoice_number FROM sales WHERE id = s AND deleted_at IS NULL) = inv, 'same invoice, still live');
  PERFORM pg_temp.check((SELECT quantity FROM sale_items WHERE id = pg_temp.item(s, 'swap')) = 421, 'line 421');
  PERFORM pg_temp.check((SELECT line_total FROM sale_items WHERE id = pg_temp.item(s, 'swap')) = 421 * 1200, 'line total');
  PERFORM pg_temp.check(pg_temp.stock('1') = 1000 - 459 + 19, 'stock +19');
  PERFORM pg_temp.check((SELECT grand_total FROM sales WHERE id = s) = tot - 19 * 1200, 'invoice -22,800');
  PERFORM pg_temp.check((SELECT balance FROM sales WHERE id = s) = bal - 19 * 1200, 'balance -22,800');
  PERFORM pg_temp.check((SELECT outstanding FROM debts WHERE sale_id = s) = bal - 19 * 1200, 'debt -22,800');
  PERFORM pg_temp.check((SELECT outstanding_balance FROM customers WHERE id = 'd7700000-0000-0000-0000-000000000001')
                        = cust - 19 * 1200, 'customer -22,800');
  PERFORM pg_temp.check(pg_temp.jugs('external', NULL) = jugs_before, 'swap line: no jug change');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM audit_logs WHERE action = 'edit_dispenser_supply' AND entity_id = s::text),
                        'audited');

  -- Jug + Water 19 -> 0: the line goes, its 19 sold jugs come back.
  PERFORM public.edit_dispenser_supply('sale', s,
            jsonb_build_array(jsonb_build_object('item_id', pg_temp.item(s, 'permanent'), 'quantity', 0)),
            'Jug + Water came back');
  PERFORM pg_temp.check(pg_temp.item(s, 'permanent') IS NULL, 'Jug + Water line removed');
  PERFORM pg_temp.check(pg_temp.jugs('external', NULL) = jugs_before - 19, 'jar_sold reversed');
  PERFORM pg_temp.check((SELECT grand_total FROM sales WHERE id = s) = tot - 19 * 1200 - 19 * 4200, 'invoice -79,800 more');
  PERFORM pg_temp.check(pg_temp.stock('1') = 1000 - 421, 'stock 579');
END $$;

-- @@ Test 2: refused -- not a dispenser, going up, below returns, no reason, not a manager
DO $$
DECLARE s uuid; it uuid;
  w uuid := 'b7700000-0000-0000-0000-000000000001'; b uuid := 'b7700000-0000-0000-0000-000000000003';
BEGIN
  PERFORM set_config('test.uid', 'a7700000-0000-0000-0000-000000000003', false);
  s := pg_temp.post(jsonb_build_array(
         jsonb_build_object('product_id', w, 'quantity', 50, 'unit_price', 1200, 'jar_mode', 'swap'),
         jsonb_build_object('product_id', b, 'quantity', 10, 'unit_price', 1700)));
  it := pg_temp.item(s, 'swap');
  PERFORM public.warehouse_receive_customer_return(jsonb_build_object('customer_id', 'd7700000-0000-0000-0000-000000000001',
            'all_products', true, 'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 30))));
  PERFORM set_config('test.uid', 'a7700000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(pg_temp.fails(format($q$SELECT public.edit_dispenser_supply('sale', %L, jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 5)), 'x')$q$,
            s, (SELECT id FROM sale_items WHERE sale_id = s AND product_id = b)), '%Only dispenser lines%'), 'bottles refused');
  PERFORM pg_temp.check(pg_temp.fails(format($q$SELECT public.edit_dispenser_supply('sale', %L, jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 60)), 'x')$q$,
            s, it), '%only go down%'), 'up refused');
  PERFORM pg_temp.check(pg_temp.fails(format($q$SELECT public.edit_dispenser_supply('sale', %L, jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 20)), 'x')$q$,
            s, it), '%already returned%'), 'below returns refused');
  PERFORM pg_temp.check(pg_temp.fails(format($q$SELECT public.edit_dispenser_supply('sale', %L, jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 40)), ' ')$q$,
            s, it), '%reason%'), 'reason required');
  PERFORM public.edit_dispenser_supply('sale', s, jsonb_build_array(jsonb_build_object('item_id', it, 'quantity', 30)), 'down to returns');
  PERFORM pg_temp.check((SELECT quantity FROM sale_items WHERE id = it) = 30, 'down to what was returned is fine');
  PERFORM set_config('test.uid', 'a7700000-0000-0000-0000-000000000002', false);
  PERFORM pg_temp.check(NOT public.can_edit_dispenser_supply(), 'officer may not');
  PERFORM pg_temp.check(pg_temp.fails(format($q$SELECT public.edit_dispenser_supply('sale', %L, jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 30)), 'x')$q$,
            s, it), '%Warehouse Manager%'), 'officer refused');
  PERFORM set_config('test.uid', 'a7700000-0000-0000-0000-000000000001', false);
  PERFORM pg_temp.check(public.can_edit_dispenser_supply(), 'manager may');
END $$;

-- @@ Test 3: marketer posting 100 -> 80
DO $$
DECLARE v jsonb; d uuid; it uuid; st numeric; jr numeric;
  r uuid := 'c7700000-0000-0000-0000-000000000001'; w uuid := 'b7700000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', 'a7700000-0000-0000-0000-000000000003', false);
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', 'f7700000-0000-0000-0000-000000000001',
         'sales_rep_id', r, 'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 100))));
  d := (v->>'id')::uuid;
  it := (SELECT id FROM stock_dispatch_items WHERE dispatch_id = d);
  st := pg_temp.stock('1');
  jr := pg_temp.jugs('sales_rep', r);
  PERFORM set_config('test.uid', 'a7700000-0000-0000-0000-000000000001', false);
  PERFORM public.edit_dispenser_supply('dispatch', d, jsonb_build_array(jsonb_build_object('item_id', it, 'quantity', 80)),
                                       'customers had no empties');
  PERFORM pg_temp.check((SELECT status FROM stock_dispatches WHERE id = d) = 'posted', 'same posting, still posted');
  PERFORM pg_temp.check((SELECT quantity FROM stock_dispatch_items WHERE id = it) = 80, 'line 80');
  PERFORM pg_temp.check((SELECT line_value FROM stock_dispatch_items WHERE id = it)
                        = 80 * (SELECT unit_price FROM stock_dispatch_items WHERE id = it), 'line value');
  PERFORM pg_temp.check((SELECT total_value FROM stock_dispatches WHERE id = d)
                        = (SELECT line_value FROM stock_dispatch_items WHERE id = it), 'posting total');
  PERFORM pg_temp.check(pg_temp.stock('1') = st + 20, 'warehouse +20');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = r AND product_id = w) = 80, 'marketer holds 80');
  PERFORM pg_temp.check(pg_temp.jugs('sales_rep', r) = jr - 20, 'marketer jugs -20');
  -- More than they hold: refused.
  UPDATE rep_stock SET quantity = 10 WHERE sales_rep_id = r AND product_id = w;
  PERFORM pg_temp.check(pg_temp.fails(format($q$SELECT public.edit_dispenser_supply('dispatch', %L, jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 50)), 'x')$q$,
            d, it), '%hold only%'), 'more than held refused');
END $$;
