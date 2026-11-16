-- ============================================================================
-- Acceptance tests: 20261116100000_marketer_jug_water_at_return.sql
--   100 Dispenser Water posted to a marketer; the Warehouse marks 40 as Jug +
--   Water at the return: the posting reads 60 Dispenser Water + 40 Jug +
--   Water, 60 empty jugs to return, the balance and the jug ledger unchanged
--   (user, 2026-11-16).
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7710000-0000-0000-0000-000000000001', 'jwrfac', 'JWR Factory');
INSERT INTO auth.users(id, email) VALUES ('a7710000-0000-0000-0000-000000000001', 'admin@jwr');
INSERT INTO user_roles(user_id, role) VALUES ('a7710000-0000-0000-0000-000000000001', 'super_admin') ON CONFLICT DO NOTHING;
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e7710000-0000-0000-0000-000000000001', 'f7710000-0000-0000-0000-000000000001', 'JWR Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b7710000-0000-0000-0000-000000000001', 'f7710000-0000-0000-0000-000000000001', 'Dispenser Water', 'Piece', 1200, 500, 'finished'),
  ('b7710000-0000-0000-0000-000000000002', 'f7710000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 3000, 0, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b7710000-0000-0000-0000-000000000001', 'e7710000-0000-0000-0000-000000000001', 1, 'with_water'),
  ('b7710000-0000-0000-0000-000000000002', 'e7710000-0000-0000-0000-000000000001', 1, 'empty');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c7710000-0000-0000-0000-000000000001', 'f7710000-0000-0000-0000-000000000001', 'JWR Marketer', 'active', 'rep');
SELECT set_config('test.uid', 'a7710000-0000-0000-0000-000000000001', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.jugs_on_rep() RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(CASE WHEN to_type = 'sales_rep' THEN quantity ELSE -quantity END), 0)
    FROM container_movements
   WHERE (to_type = 'sales_rep' AND to_id = 'c7710000-0000-0000-0000-000000000001')
      OR (from_type = 'sales_rep' AND from_id = 'c7710000-0000-0000-0000-000000000001');
$$;

-- @@ Test 1: 40 of 100 marked Jug + Water -- same balance, same jugs, 60 to return
DO $$
DECLARE f uuid := 'f7710000-0000-0000-0000-000000000001'; m uuid := 'c7710000-0000-0000-0000-000000000001';
  w uuid := 'b7710000-0000-0000-0000-000000000001'; b jsonb; s jsonb; v_before numeric; d record;
BEGIN
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', m,
    'items', jsonb_build_array(jsonb_build_object('product_id', w, 'quantity', 100))));
  v_before := (public.rep_account_summary(m)->>'net_balance_owed')::numeric;
  PERFORM pg_temp.check(v_before = 100 * 1200 + 100 * 3000, 'before: ' || v_before);
  PERFORM pg_temp.check(pg_temp.jugs_on_rep() = 100, 'jugs out 100');

  PERFORM public.set_rep_jug_water_sold(m, w, CURRENT_DATE, 40, 'test');

  SELECT sum(quantity) FILTER (WHERE jar_mode IS NULL) AS water,
         sum(quantity) FILTER (WHERE jar_mode = 'permanent' AND jw_marked) AS jw,
         max(unit_price) FILTER (WHERE jw_marked) AS jw_price,
         sum(line_value) AS value
    INTO d
    FROM stock_dispatch_items i JOIN stock_dispatches sd ON sd.id = i.dispatch_id WHERE sd.sales_rep_id = m;
  PERFORM pg_temp.check(d.water = 60 AND d.jw = 40 AND d.jw_price = 4200, 'lines: ' || row_to_json(d)::text);
  PERFORM pg_temp.check((SELECT total_value FROM stock_dispatches WHERE sales_rep_id = m) = 60 * 1200 + 40 * 4200,
                        'posting total');
  s := public.rep_account_summary(m);
  PERFORM pg_temp.check((s->>'net_balance_owed')::numeric = v_before, 'balance unchanged: ' || (s->>'net_balance_owed'));
  PERFORM pg_temp.check((s->>'jugs_owed')::numeric = 60, 'jugs owed 60: ' || s::text);
  PERFORM pg_temp.check(pg_temp.jugs_on_rep() = 100, 'jug ledger unchanged: ' || pg_temp.jugs_on_rep());
  b := public.rep_dispenser_breakdown(m);
  PERFORM pg_temp.check((b->>'jug_water_sold')::numeric = 40 AND (b->>'empties_to_return')::numeric = 60,
                        'breakdown: ' || b::text);
  PERFORM pg_temp.check((SELECT jw_marked FROM public.rep_jug_water_day(m, CURRENT_DATE)) = 40, 'day view');
END $$;

-- @@ Test 2: up to all 100, then back to 30 -- still the same balance and jugs
DO $$
DECLARE m uuid := 'c7710000-0000-0000-0000-000000000001'; w uuid := 'b7710000-0000-0000-0000-000000000001';
  s jsonb;
BEGIN
  PERFORM public.set_rep_jug_water_sold(m, w, CURRENT_DATE, 100, NULL);
  PERFORM pg_temp.check((SELECT count(*) FROM stock_dispatch_items i JOIN stock_dispatches sd ON sd.id = i.dispatch_id
                          WHERE sd.sales_rep_id = m) = 1, 'one Jug + Water line');
  PERFORM public.set_rep_jug_water_sold(m, w, CURRENT_DATE, 30, NULL);
  PERFORM pg_temp.check((SELECT sum(quantity) FILTER (WHERE jar_mode IS NULL) FROM stock_dispatch_items i
                           JOIN stock_dispatches sd ON sd.id = i.dispatch_id WHERE sd.sales_rep_id = m) = 70,
                        '70 Dispenser Water');
  s := public.rep_account_summary(m);
  PERFORM pg_temp.check((s->>'net_balance_owed')::numeric = 100 * 1200 + 100 * 3000, 'balance: ' || s::text);
  PERFORM pg_temp.check(pg_temp.jugs_on_rep() = 100, 'jug ledger: ' || pg_temp.jugs_on_rep());
END $$;

-- @@ Test 3: 60 empties back -> only 10 jugs out; marking 70 more is refused
DO $$
DECLARE f uuid := 'f7710000-0000-0000-0000-000000000001'; m uuid := 'c7710000-0000-0000-0000-000000000001';
  w uuid := 'b7710000-0000-0000-0000-000000000001'; b jsonb; v_err text;
BEGIN
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity, source, reference)
  VALUES (f, 'e7710000-0000-0000-0000-000000000001', 'sales_rep', m, 'qc', NULL, 60, 'return', 'JRQ-JWR');
  b := public.rep_dispenser_breakdown(m);
  PERFORM pg_temp.check((b->>'jug_water_sold')::numeric = 30 AND (b->>'water_sold')::numeric = 60
                        AND (b->>'empties_to_return')::numeric = 10, 'after empties: ' || b::text);
  BEGIN
    PERFORM public.set_rep_jug_water_sold(m, w, CURRENT_DATE, 100, NULL);
    v_err := 'none';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.check(v_err LIKE 'Only 10 jug(s) are still out%', 'refused: ' || v_err);
END $$;
