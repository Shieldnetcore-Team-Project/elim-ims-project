-- ============================================================================
-- Acceptance tests: Costing -> delete a product (20261101120000_delete_product.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. Unused product -> deleted; one with a
-- posting in its history -> taken off the lists, history kept; one still in
-- stock -> refused; a non-admin -> refused.
-- ============================================================================

INSERT INTO factories(id, code, name) VALUES ('f9100000-0000-0000-0000-000000000001', 'dpfac', 'DP Factory');
INSERT INTO auth.users(id, email) VALUES
  ('a9100000-0000-0000-0000-000000000001', 'admin@dp'),
  ('a9100000-0000-0000-0000-000000000002', 'wh@dp');
INSERT INTO roles(slug, label, is_system) VALUES ('dp_wh_test', 'Warehouse (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'dp_wh_test', m::module_key, a::action_key
  FROM unnest(ARRAY['finished-goods', 'distribution']) m, unnest(ARRAY['view', 'create', 'edit', 'delete']) a
ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id IN ('a9100000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000002');
INSERT INTO user_roles(user_id, role, factory_id) VALUES
  ('a9100000-0000-0000-0000-000000000001', 'super_admin', NULL),
  ('a9100000-0000-0000-0000-000000000002', 'dp_wh_test', 'f9100000-0000-0000-0000-000000000001');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b9100000-0000-0000-0000-000000000001', 'f9100000-0000-0000-0000-000000000001', 'DP Unused', 'Pack', 100, 0, 'finished'),
  ('b9100000-0000-0000-0000-000000000002', 'f9100000-0000-0000-0000-000000000001', 'DP Posted', 'Pack', 100, 10, 'finished'),
  ('b9100000-0000-0000-0000-000000000003', 'f9100000-0000-0000-0000-000000000001', 'DP In stock', 'Pack', 100, 7, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c9100000-0000-0000-0000-000000000001', 'f9100000-0000-0000-0000-000000000001', 'DP Rep', 'active', 'rep');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END;
$$;

-- @@ Test 1: a non-admin can't delete
DO $$
DECLARE e text;
BEGIN
  PERFORM set_config('test.uid', 'a9100000-0000-0000-0000-000000000002', false);
  e := pg_temp.err($q$SELECT public.delete_product('b9100000-0000-0000-0000-000000000001')$q$);
  PERFORM pg_temp.check(e LIKE '%Only an administrator%', 'refused: ' || COALESCE(e, 'none'));
END $$;

-- @@ Test 2: unused -> deleted; posted (stock all out with the rep, then back) -> deactivated; in stock -> refused
DO $$
DECLARE r jsonb; e text;
BEGIN
  -- DP Posted: all 10 posted to the rep, then the posting reversed by hand
  -- (stock back to 0 with history left).
  PERFORM set_config('test.uid', 'a9100000-0000-0000-0000-000000000002', false);
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', 'f9100000-0000-0000-0000-000000000001',
    'sales_rep_id', 'c9100000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b9100000-0000-0000-0000-000000000002', 'quantity', 10))));
  UPDATE rep_stock SET quantity = 0 WHERE product_id = 'b9100000-0000-0000-0000-000000000002';

  PERFORM set_config('test.uid', 'a9100000-0000-0000-0000-000000000001', false);
  r := public.delete_product('b9100000-0000-0000-0000-000000000001');
  PERFORM pg_temp.check(r->>'mode' = 'deleted' AND NOT EXISTS (SELECT 1 FROM products WHERE id = 'b9100000-0000-0000-0000-000000000001'),
                        'unused deleted: ' || r::text);
  r := public.delete_product('b9100000-0000-0000-0000-000000000002');
  PERFORM pg_temp.check(r->>'mode' = 'deactivated'
                        AND (SELECT NOT active FROM products WHERE id = 'b9100000-0000-0000-0000-000000000002')
                        AND EXISTS (SELECT 1 FROM stock_dispatch_items WHERE product_id = 'b9100000-0000-0000-0000-000000000002'),
                        'posted deactivated, history kept: ' || r::text);
  e := pg_temp.err($q$SELECT public.delete_product('b9100000-0000-0000-0000-000000000003')$q$);
  PERFORM pg_temp.check(e LIKE '%still has 7%', 'in stock refused: ' || COALESCE(e, 'none'));
END $$;
