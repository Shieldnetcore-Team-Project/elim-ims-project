-- ============================================================================
-- Acceptance tests: godwin_loadout_30oct (20261102100000_godwin_loadout_30oct.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Godwin (seeded) already holds 5 packs of
-- 75cl; a Warehouse officer posted bottles before. The 30 Oct load-outs and
-- return land on his account and van, dated 30 Oct; the Warehouse's stock
-- doesn't move; the return isn't offered on his next posting; a re-run adds
-- nothing.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('90300000-0000-0000-0000-000000000001', 'kemi@gw');
CREATE TEMP TABLE ids AS
SELECT 'godwin'::text AS k, id AS v FROM sales_reps WHERE full_name = 'Godwin'
UNION ALL SELECT '50', id FROM products WHERE product_type = 'finished' AND active AND btrim(name) ~* '^50 ?cl bottle'
UNION ALL SELECT '75', id FROM products WHERE product_type = 'finished' AND active AND btrim(name) ~* '^75 ?cl bottle';
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
SELECT (SELECT v FROM ids WHERE k = 'godwin'), (SELECT v FROM ids WHERE k = '75'), id, 5 FROM factories WHERE code = 'water';
-- An earlier bottle posting by the Warehouse officer (to someone else).
INSERT INTO stock_dispatches(id, factory_id, dispatch_number, dispatch_date, sales_rep_id, created_by, created_at)
SELECT '90300000-0000-0000-0000-0000000000d1', f.id, 'DSP-GW-OLD', '2026-10-29', r.id,
       '90300000-0000-0000-0000-000000000001', '2026-10-29 10:00+01'
  FROM factories f, sales_reps r WHERE f.code = 'water' AND r.full_name = 'Malla';
INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value)
VALUES ('90300000-0000-0000-0000-0000000000d1', (SELECT v FROM ids WHERE k = '50'), 1, 0, 0);
CREATE TEMP TABLE wh AS SELECT id, current_stock FROM products WHERE id IN (SELECT v FROM ids WHERE k IN ('50', '75'));

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: four postings and the return, dated 30 Oct, on Godwin's account and van
DO $$
DECLARE r jsonb; g uuid := (SELECT v FROM ids WHERE k = 'godwin');
  p50 uuid := (SELECT v FROM ids WHERE k = '50'); p75 uuid := (SELECT v FROM ids WHERE k = '75');
BEGIN
  PERFORM pg_temp.check((SELECT count(*) FROM ids) = 3, 'Godwin and both products found');
  r := public._godwin_loadout_30oct();
  PERFORM pg_temp.check(jsonb_array_length(r->'postings') = 4, 'result: ' || r::text);
  PERFORM pg_temp.check((SELECT count(*) FROM stock_dispatches WHERE sales_rep_id = g AND dispatch_date = '2026-10-30'
                          AND (created_at AT TIME ZONE 'Africa/Lagos')::date = '2026-10-30'
                          AND created_by = '90300000-0000-0000-0000-000000000001') = 4, 'four postings on 30 Oct by the officer');
  PERFORM pg_temp.check((SELECT sum(i.quantity) FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
                          WHERE d.sales_rep_id = g AND i.product_id = p50) = 116, '50cl supplied 116');
  PERFORM pg_temp.check((SELECT sum(i.quantity) FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
                          WHERE d.sales_rep_id = g AND i.product_id = p75) = 410, '75cl supplied 410');
  PERFORM pg_temp.check((SELECT sum(i.accepted_quantity) FROM rep_return_items i JOIN rep_returns x ON x.id = i.rep_return_id
                          WHERE x.sales_rep_id = g AND x.return_date = '2026-10-30' AND x.status = 'completed' AND i.product_id = p50) = 16, '50cl returned 16');
  PERFORM pg_temp.check((SELECT sum(i.accepted_quantity) FROM rep_return_items i JOIN rep_returns x ON x.id = i.rep_return_id
                          WHERE x.sales_rep_id = g AND x.return_date = '2026-10-30' AND x.status = 'completed' AND i.product_id = p75) = 4, '75cl returned 4');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = g AND product_id = p50) = 100, 'van 50cl 100');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = g AND product_id = p75) = 411, 'van 75cl 5 + 406');
  -- Warehouse untouched; no Warehouse stock lines.
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM products p JOIN wh ON wh.id = p.id WHERE p.current_stock <> wh.current_stock), 'Warehouse stock unchanged');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM inventory_movements m JOIN stock_dispatches d ON d.dispatch_number = m.reference
                                     WHERE d.sales_rep_id = g), 'no Warehouse lines');
  -- The return is not open for carry-over.
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM rep_returns WHERE sales_rep_id = g AND carried_dispatch_id IS NULL), 'not carried again');
END $$;

-- @@ Test 2: Godwin's account shows it; a re-run adds nothing
DO $$
DECLARE r jsonb; g uuid := (SELECT v FROM ids WHERE k = 'godwin');
BEGIN
  r := public._godwin_loadout_30oct();
  PERFORM pg_temp.check(r ? 'skipped', 're-run: ' || r::text);
  PERFORM pg_temp.check((SELECT count(*) FROM stock_dispatches WHERE sales_rep_id = g) = 4
                        AND (SELECT count(*) FROM rep_returns WHERE sales_rep_id = g) = 1, 'nothing twice');
END $$;

-- @@ Test 3: the return is reopened, shows for his next posting, and carrying it nets the Warehouse to zero
DO $$
DECLARE g uuid := (SELECT v FROM ids WHERE k = 'godwin');
  p50 uuid := (SELECT v FROM ids WHERE k = '50'); p75 uuid := (SELECT v FROM ids WHERE k = '75');
  ret uuid; d jsonb;
BEGIN
  PERFORM public._godwin_30oct_return_open();
  PERFORM public._godwin_30oct_return_open();  -- twice: no double stock
  ret := (SELECT id FROM rep_returns WHERE sales_rep_id = g AND status = 'completed' AND carried_dispatch_id IS NULL);
  PERFORM pg_temp.check(ret IS NOT NULL, 'open for his next posting');
  PERFORM pg_temp.check((SELECT p.current_stock - wh.current_stock FROM products p JOIN wh ON wh.id = p.id WHERE p.id = p50) = 16
                        AND (SELECT p.current_stock - wh.current_stock FROM products p JOIN wh ON wh.id = p.id WHERE p.id = p75) = 4,
                        'returned goods back in the Warehouse once');
  -- The next posting carries it (as the form does): 75cl 10 extra.
  INSERT INTO user_roles(user_id, role, factory_id)
  SELECT '90300000-0000-0000-0000-000000000001', 'super_admin', id FROM factories WHERE code = 'water'
  ON CONFLICT DO NOTHING;
  PERFORM set_config('test.uid', '90300000-0000-0000-0000-000000000001', false);
  d := public.create_stock_dispatch(jsonb_build_object(
         'factory_id', (SELECT id FROM factories WHERE code = 'water'), 'sales_rep_id', g,
         'carry_return_ids', jsonb_build_array(ret),
         'items', jsonb_build_array(jsonb_build_object('product_id', p50, 'quantity', 16),
                                    jsonb_build_object('product_id', p75, 'quantity', 14))));
  PERFORM pg_temp.check((SELECT carried_dispatch_id FROM rep_returns WHERE id = ret) = (d->>'id')::uuid, 'carried');
  PERFORM pg_temp.check((SELECT p.current_stock - wh.current_stock FROM products p JOIN wh ON wh.id = p.id WHERE p.id = p50) = 0
                        AND (SELECT p.current_stock - wh.current_stock FROM products p JOIN wh ON wh.id = p.id WHERE p.id = p75) = -10,
                        'Warehouse: return nets to zero, only the 10 extra 75cl left');
  PERFORM pg_temp.check((SELECT quantity FROM rep_stock WHERE sales_rep_id = g AND product_id = p50) = 116
                        AND (SELECT quantity FROM rep_stock WHERE sales_rep_id = g AND product_id = p75) = 425, 'van');
END $$;
