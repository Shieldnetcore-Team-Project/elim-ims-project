-- ============================================================================
-- Acceptance tests: marketers' empty jugs -- Warehouse records, QC counts,
-- the account balances (20261101100000_marketer_jugs_qc_count.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Jug + water N4,200, jug N3,000. Marketer
-- "MJ Ada" is posted 10 dispensers (N42,000), sells 6 water-only (empties
-- come back), brings 2 unsold full ones back; the Warehouse records 6
-- empties, QC counts 5 (one missing). She remits N7,200 (6 x N1,200).
-- Owed: 42,000 - 8,400 (2 full back) - 15,000 (5 jugs) - 7,200 = 11,400 --
-- the 4 dispensers still on her van (none: 10-6-2 = 2 left = 8,400) plus the
-- missing jug (3,000).
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f3800000-0000-0000-0000-000000000001', 'mjfac', 'MJ Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a3800000-0000-0000-0000-000000000001', 'wh@mj'),
  ('a3800000-0000-0000-0000-000000000002', 'qc@mj');
INSERT INTO roles(slug, label, is_system) VALUES
  ('mj_wh_test', 'Warehouse (test)', false), ('mj_qc_test', 'QC (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action) VALUES
  ('mj_wh_test', 'distribution', 'view'), ('mj_wh_test', 'distribution', 'create'),
  ('mj_wh_test', 'distribution', 'submit'), ('mj_wh_test', 'distribution', 'confirm'),
  ('mj_wh_test', 'finished-goods', 'view'),
  ('mj_qc_test', 'goods-receiving', 'view'), ('mj_qc_test', 'goods-receiving', 'submit')
ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id IN ('a3800000-0000-0000-0000-000000000001', 'a3800000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a3800000-0000-0000-0000-000000000001', 'mj_wh_test', 'f3800000-0000-0000-0000-000000000001'),
  ('a3800000-0000-0000-0000-000000000002', 'mj_qc_test', 'f3800000-0000-0000-0000-000000000001');
INSERT INTO container_types(id, factory_id, name, jar_price, with_jar_price) VALUES
  ('e3800000-0000-0000-0000-000000000001', 'f3800000-0000-0000-0000-000000000001', 'MJ New Jug', 3000, 4200);
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b3800000-0000-0000-0000-000000000001', 'f3800000-0000-0000-0000-000000000001', 'MJ Dispenser Water', 'Piece', 1200, 100, 'finished');
INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role) VALUES
  ('b3800000-0000-0000-0000-000000000001', 'e3800000-0000-0000-0000-000000000001', 1, 'refill');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c3800000-0000-0000-0000-000000000001', 'f3800000-0000-0000-0000-000000000001', 'MJ Ada', 'active', 'rep');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.acct() RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.rep_account_summary('c3800000-0000-0000-0000-000000000001', NULL, NULL)
$$;

-- @@ Test 1: posted at N4,200 a dispenser
DO $$
DECLARE v jsonb;
  f uuid := 'f3800000-0000-0000-0000-000000000001'; r uuid := 'c3800000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', 'a3800000-0000-0000-0000-000000000001', false);
  v := public.create_stock_dispatch(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3800000-0000-0000-0000-000000000001', 'quantity', 10))));
  PERFORM pg_temp.check((SELECT unit_price FROM stock_dispatch_items WHERE dispatch_id = (v->>'id')::uuid) = 4200, 'line at 4200');
  PERFORM pg_temp.check((SELECT total_value FROM stock_dispatches WHERE id = (v->>'id')::uuid) = 42000, 'total 42000');
  PERFORM pg_temp.check((pg_temp.acct()->>'goods_out_value')::numeric = 42000, 'account goods out');
END $$;

-- @@ Test 2: 6 sold water-only, 2 unsold back at the posted price; 6 empties recorded, the Warehouse can't count them
DO $$
DECLARE v jsonb; ok boolean := false;
  f uuid := 'f3800000-0000-0000-0000-000000000001'; r uuid := 'c3800000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', 'a3800000-0000-0000-0000-000000000001', false);
  -- 6 sold as refills (swaps): off her van, the jugs stay with her.
  UPDATE rep_stock SET quantity = quantity - 6 WHERE sales_rep_id = r;
  PERFORM public.create_rep_return(jsonb_build_object('factory_id', f, 'sales_rep_id', r,
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b3800000-0000-0000-0000-000000000001', 'quantity_returned', 2))));
  PERFORM pg_temp.check((SELECT i.unit_price FROM rep_return_items i JOIN rep_returns rr ON rr.id = i.rep_return_id
                          WHERE rr.sales_rep_id = r LIMIT 1) = 4200, 'unsold back at 4200');
  v := public.record_jug_return(jsonb_build_object('sales_rep_id', r,
    'container_type_id', 'e3800000-0000-0000-0000-000000000001', 'quantity', 6));
  BEGIN
    PERFORM public.verify_jug_return((v->>'id')::uuid, 6, NULL);
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%Only Quality Control%';
  END;
  PERFORM pg_temp.check(ok, 'Warehouse cannot count');
END $$;

-- @@ Test 3: QC counts 5 of 6 -> 5 credited at N3,000, an accepted QC consignment, the missing jug stays owed
DO $$
DECLARE j uuid; a jsonb; b record; ok boolean := false;
  r uuid := 'c3800000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('test.uid', 'a3800000-0000-0000-0000-000000000002', false);
  j := (SELECT id FROM public.qc_pending_jug_returns('f3800000-0000-0000-0000-000000000001') LIMIT 1);
  PERFORM pg_temp.check(j IS NOT NULL, 'QC sees the pending return');
  BEGIN
    PERFORM public.verify_jug_return(j, 7, 'too many');
  EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%the Warehouse recorded%';
  END;
  PERFORM pg_temp.check(ok, 'cannot count more than recorded');
  PERFORM public.verify_jug_return(j, 5, 'one missing');
  SELECT * INTO b FROM qc_jug_batches WHERE jug_return_id = j;
  PERFORM pg_temp.check(b.status = 'accepted' AND b.quantity_sent = 6 AND b.quantity_accepted = 5
                        AND b.sent_by = 'a3800000-0000-0000-0000-000000000001', 'QC consignment: ' || row_to_json(b)::text);
  PERFORM set_config('test.uid', 'a3800000-0000-0000-0000-000000000001', false);
  -- Finance records the remittance (its own page); here directly.
  INSERT INTO rep_remittances(factory_id, remittance_number, sales_rep_id, amount, payment_method, remittance_date)
  VALUES ('f3800000-0000-0000-0000-000000000001', 'MJ-REM-1', r, 7200, 'cash', CURRENT_DATE);
  a := pg_temp.acct();
  PERFORM pg_temp.check((a->>'empty_jugs_returned')::numeric = 5 AND (a->>'empty_jugs_value')::numeric = 15000,
                        'jug credit: ' || a::text);
  PERFORM pg_temp.check((a->>'net_balance_owed')::numeric = 42000 - 8400 - 15000 - 7200,
                        'owed 11400 (2 on the van + 1 missing jug): ' || (a->>'net_balance_owed'));
END $$;

-- @@ Test 4: QC then verifies the consignment and posts the good ones to the PM as usual
DO $$
DECLARE b uuid := (SELECT q.id FROM qc_jug_batches q JOIN jug_returns j ON j.id = q.jug_return_id
                       WHERE j.sales_rep_id = 'c3800000-0000-0000-0000-000000000001' LIMIT 1);
BEGIN
  PERFORM set_config('test.uid', 'a3800000-0000-0000-0000-000000000002', false);
  PERFORM public.verify_qc_jugs(b, 4, 1, 'cracked');
  PERFORM pg_temp.check((SELECT status FROM qc_jug_batches WHERE id = b) = 'verified', 'verified');
END $$;
