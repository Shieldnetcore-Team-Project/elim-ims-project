-- ============================================================================
-- Acceptance tests: 20261117130000_qc_post_jugs_to_warehouse.sql
--   QC posts empty jugs to the PM or the Warehouse; the Warehouse's Empty Jug
--   officer accepts a Warehouse posting into Empty Jug stock; the PM can't
--   confirm it and the bottles officer can't accept it.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f7700000-0000-0000-0000-000000000001', 'qwhtest', 'QWH Test Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a7700000-0000-0000-0000-000000000001', 'qc@qwh'),
  ('a7700000-0000-0000-0000-000000000002', 'kemi@qwh'),
  ('a7700000-0000-0000-0000-000000000003', 'gideon@qwh'),
  ('a7700000-0000-0000-0000-000000000004', 'pm@qwh');
INSERT INTO roles(slug, label, is_system) VALUES
  ('qwh_wh_test', 'Warehouse (test)', false),
  ('qwh_pm_test', 'PM (test)', false)
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'qwh_wh_test', m::module_key, a::action_key
  FROM unnest(ARRAY['finished-goods']) m, unnest(ARRAY['view', 'create']) a
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'qwh_pm_test', 'production'::module_key, a::action_key
  FROM unnest(ARRAY['view', 'create', 'submit']) a
ON CONFLICT DO NOTHING;
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a7700000-0000-0000-0000-000000000001', 'super_admin', 'f7700000-0000-0000-0000-000000000001'),
  ('a7700000-0000-0000-0000-000000000002', 'qwh_wh_test', 'f7700000-0000-0000-0000-000000000001'),
  ('a7700000-0000-0000-0000-000000000003', 'qwh_wh_test', 'f7700000-0000-0000-0000-000000000001'),
  ('a7700000-0000-0000-0000-000000000004', 'qwh_pm_test', 'f7700000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;
INSERT INTO user_product_rules(user_id, name_pattern) VALUES
  ('a7700000-0000-0000-0000-000000000002', 'bottle'),
  ('a7700000-0000-0000-0000-000000000003', 'dispenser|jug water'),
  ('a7700000-0000-0000-0000-000000000003', 'empty jug|jug \+ water'),
  ('a7700000-0000-0000-0000-000000000004', 'dispenser|jug water');
INSERT INTO container_types(id, factory_id, name) VALUES
  ('e7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'Old Dispenser Jug');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('d7700000-0000-0000-0000-000000000001', 'f7700000-0000-0000-0000-000000000001', 'Empty Jug', 'Piece', 3000, 5, 'finished');
-- Two returns with QC (already at QC on the ledger).
INSERT INTO qc_jug_batches(factory_id, reference, jug_kind, status, quantity_sent, sent_by, sent_at,
                           quantity_accepted, accepted_by, accepted_at, collected)
VALUES ('f7700000-0000-0000-0000-000000000001', 'QWH-T-1', 'old', 'accepted', 30,
        'a7700000-0000-0000-0000-000000000001', now(), 30, 'a7700000-0000-0000-0000-000000000001', now(), true),
       ('f7700000-0000-0000-0000-000000000001', 'QWH-T-2', 'old', 'accepted', 20,
        'a7700000-0000-0000-0000-000000000001', now(), 20, 'a7700000-0000-0000-0000-000000000001', now(), true);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.act(p_user text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('test.uid', 'a7700000-0000-0000-0000-00000000000' || p_user, false); END;
$$;
CREATE TEMP TABLE t_ref(dest text, ref text);

-- @@ Test 1: QC posts 30 to the Warehouse (2 damaged) and 20 to the PM
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.act('1');
  PERFORM pg_temp.check(pg_temp.err($q$SELECT public.qc_post_jugs_to_pm('f7700000-0000-0000-0000-000000000001',
                          0, NULL, 5, NULL, NULL, 'shop')$q$) LIKE '%PM or to the Warehouse%', 'unknown place refused');
  r := public.qc_post_jugs_to_pm('f7700000-0000-0000-0000-000000000001', 2, 'cracked', 28, NULL, NULL, 'warehouse');
  PERFORM pg_temp.check(r->>'reference' LIKE 'QWH-%', 'warehouse posting numbered QWH');
  PERFORM pg_temp.check((r->>'good')::numeric = 28 AND (r->>'kept')::numeric = 20, 'good 28, 20 kept at QC');
  INSERT INTO t_ref VALUES ('warehouse', r->>'reference');
  r := public.qc_post_jugs_to_pm('f7700000-0000-0000-0000-000000000001', 0, NULL, NULL, NULL, NULL);
  PERFORM pg_temp.check(r->>'reference' LIKE 'QPM-%' AND (r->>'good')::numeric = 20, 'the rest to the PM by default');
  INSERT INTO t_ref VALUES ('pm', r->>'reference');
  PERFORM pg_temp.check((SELECT destination FROM public.qc_pm_jug_postings('f7700000-0000-0000-0000-000000000001',
                           current_date - 1, current_date + 1) WHERE posting = (SELECT ref FROM t_ref WHERE dest = 'warehouse'))
                        = 'warehouse', 'postings list says warehouse');
END $$;

-- @@ Test 2: the PM can't confirm a Warehouse posting; the bottles officer can't accept it
DO $$
BEGIN
  PERFORM pg_temp.act('4');
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.receive_qc_jug_posting('f7700000-0000-0000-0000-000000000001', %L)$q$,
                          (SELECT ref FROM t_ref WHERE dest = 'warehouse'))) LIKE '%not waiting for the Production Manager%',
                        'PM refused');
  PERFORM pg_temp.act('2');
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.receive_qc_jugs_at_warehouse('f7700000-0000-0000-0000-000000000001', %L)$q$,
                          (SELECT ref FROM t_ref WHERE dest = 'warehouse'))) LIKE '%not one of your products%',
                        'bottles officer refused');
  PERFORM pg_temp.act('3');
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.receive_qc_jugs_at_warehouse('f7700000-0000-0000-0000-000000000001', %L)$q$,
                          (SELECT ref FROM t_ref WHERE dest = 'pm'))) LIKE '%not waiting for the Warehouse%',
                        'a PM posting is not the Warehouse''s');
END $$;

-- @@ Test 3: the Empty Jug officer accepts it into stock; ledger QC -> Warehouse
DO $$
DECLARE r jsonb; v_ref text := (SELECT ref FROM t_ref WHERE dest = 'warehouse');
BEGIN
  PERFORM pg_temp.act('3');
  r := public.receive_qc_jugs_at_warehouse('f7700000-0000-0000-0000-000000000001', v_ref);
  PERFORM pg_temp.check((r->>'good')::numeric = 28, 'accepted 28');
  PERFORM pg_temp.check((SELECT current_stock FROM products WHERE id = 'd7700000-0000-0000-0000-000000000001') = 33,
                        'Empty Jug 5 + 28 = 33');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM inventory_movements WHERE reference = v_ref AND movement_type = 'received'
                                   AND quantity = 28), 'stock movement written');
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM container_movements WHERE reference LIKE 'QWH-T-%'
                           AND source = 'qc_to_warehouse' AND from_type = 'qc' AND to_type = 'warehouse') = 28,
                        'ledger QC -> Warehouse 28');
  PERFORM pg_temp.check(pg_temp.err(format($q$SELECT public.receive_qc_jugs_at_warehouse('f7700000-0000-0000-0000-000000000001', %L)$q$,
                          v_ref)) LIKE '%not waiting for the Warehouse%', 'cannot accept twice');
  -- The PM still confirms its own posting.
  PERFORM pg_temp.act('4');
  PERFORM public.receive_qc_jug_posting('f7700000-0000-0000-0000-000000000001', (SELECT ref FROM t_ref WHERE dest = 'pm'));
  PERFORM pg_temp.check((SELECT SUM(quantity) FROM container_movements WHERE reference LIKE 'QWH-T-%'
                           AND source = 'qc_to_production') = 20, 'PM posting goes to Production');
END $$;
