-- ============================================================================
-- Acceptance tests: Gideon takes Sachet Water from Production to posting
-- (20261109100000_gideon_sachet_end_to_end.sql)
--
-- "Gideon" is assigned dispensers and sachet; "Kemi" bottles; "Joy" has no
-- product rule. All three hold the same rights, so only the rule differs.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES
  ('a4300000-0000-0000-0000-000000000001', 'gideon@gs'),
  ('a4300000-0000-0000-0000-000000000002', 'kemi@gs'),
  ('a4300000-0000-0000-0000-000000000003', 'joy@gs');
INSERT INTO roles(slug, label, is_system) VALUES ('gs_wh_test', 'Warehouse (test)', false) ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role, module, action)
SELECT 'gs_wh_test', m::module_key, a::action_key
  FROM unnest(ARRAY['production', 'finished-goods', 'distribution', 'sales']) m,
       unnest(ARRAY['view', 'create', 'edit', 'submit', 'confirm', 'reject']) a
ON CONFLICT DO NOTHING;
DELETE FROM user_roles WHERE user_id::text LIKE 'a4300000-%';
INSERT INTO user_roles(user_id, role, factory_id)
SELECT u::uuid, 'gs_wh_test', (SELECT id FROM factories WHERE code = 'water')
  FROM unnest(ARRAY['a4300000-0000-0000-0000-000000000001', 'a4300000-0000-0000-0000-000000000002',
                    'a4300000-0000-0000-0000-000000000003']) u;
INSERT INTO user_product_rules(user_id, name_pattern, label) VALUES
  ('a4300000-0000-0000-0000-000000000001', 'dispenser|jug water', 'Dispensers'),
  ('a4300000-0000-0000-0000-000000000001', 'sachet', 'Sachet'),
  ('a4300000-0000-0000-0000-000000000002', 'bottle water', 'Bottle Water');
INSERT INTO products(id, factory_id, name, unit, unit_price, current_stock, product_type) VALUES
  ('b4300000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'GS Sachet Water', 'Bag', 100, 0, 'finished'),
  ('b4300000-0000-0000-0000-000000000002', (SELECT id FROM factories WHERE code = 'water'), 'GS Dispenser Water', 'Piece', 100, 0, 'finished'),
  ('b4300000-0000-0000-0000-000000000003', (SELECT id FROM factories WHERE code = 'water'), 'GS 50cl Bottle Water', 'Pack', 100, 0, 'finished');
INSERT INTO sales_reps(id, factory_id, full_name, status, kind) VALUES
  ('c4300000-0000-0000-0000-000000000001', (SELECT id FROM factories WHERE code = 'water'), 'GS Marketer', 'active', 'rep');

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.act(p_user text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('test.uid', 'a4300000-0000-0000-0000-00000000000' || p_user, false); END;
$$;
-- Records a batch and releases it all, as that person; returns the release.
CREATE OR REPLACE FUNCTION pg_temp.make(p_user text, p_product text, p_qty int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v jsonb; prod uuid := ('b4300000-0000-0000-0000-00000000000' || p_product)::uuid;
BEGIN
  PERFORM pg_temp.act(p_user);
  PERFORM public.create_production(jsonb_build_object('factory_id', (SELECT id FROM factories WHERE code = 'water'),
    'product_id', prod, 'quantity_produced', p_qty, 'unit', 'Bag', 'shift', 'day'));
  v := public.release_to_warehouse(jsonb_build_object('factory_id', (SELECT id FROM factories WHERE code = 'water'),
    'product_id', prod, 'quantity', p_qty));
  RETURN (v->>'id')::uuid;
END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.accept(p_user text, p_id uuid, p_qty int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.act(p_user);
  PERFORM public.accept_production_release(p_id, p_qty);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END;
$$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p_product text) RETURNS numeric LANGUAGE sql AS $$
  SELECT current_stock FROM products WHERE id = ('b4300000-0000-0000-0000-00000000000' || p_product)::uuid;
$$;

-- @@ Test 1: Gideon records, releases and accepts his own sachet
DO $$
DECLARE r uuid; e text;
BEGIN
  r := pg_temp.make('1', '1', 50);
  e := pg_temp.accept('1', r, 50);
  PERFORM pg_temp.check(e IS NULL, 'accepts own sachet: ' || COALESCE(e, ''));
  PERFORM pg_temp.check(pg_temp.stock('1') = 50, 'stock 50 after accept');
  PERFORM pg_temp.check((SELECT accepted_by FROM production_releases WHERE id = r) = 'a4300000-0000-0000-0000-000000000001',
                        'recorded as accepted by Gideon');
  PERFORM pg_temp.check((SELECT (new_value->>'accepted_own_release')::boolean FROM audit_logs
                          WHERE action = 'accept_production_release' AND entity_id = r::text) IS TRUE,
                        'self-acceptance flagged in the audit log');
END $$;

-- @@ Test 2: then posts it to a marketer
DO $$
BEGIN
  PERFORM pg_temp.act('1');
  PERFORM public.create_stock_dispatch(jsonb_build_object('factory_id', (SELECT id FROM factories WHERE code = 'water'),
    'sales_rep_id', 'c4300000-0000-0000-0000-000000000001',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'b4300000-0000-0000-0000-000000000001', 'quantity', 20))));
  PERFORM pg_temp.check(pg_temp.stock('1') = 30, 'posting takes 20 out of stock');
END $$;

-- @@ Test 3: not his dispensers -- a second person still accepts those
DO $$
DECLARE r uuid; e text;
BEGIN
  r := pg_temp.make('1', '2', 10);
  e := pg_temp.accept('1', r, 10);
  PERFORM pg_temp.check(e LIKE '%someone other than who released%', 'own dispenser refused: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check(pg_temp.stock('2') = 0, 'no dispenser stock added');
  e := pg_temp.accept('3', r, 10);
  PERFORM pg_temp.check(e IS NULL, 'someone else accepts: ' || COALESCE(e, ''));
  PERFORM pg_temp.check(pg_temp.stock('2') = 10, 'dispenser stock 10');
END $$;

-- @@ Test 4: sachet by someone not assigned to it still needs a second person
DO $$
DECLARE r uuid; e text;
BEGIN
  r := pg_temp.make('3', '1', 5);   -- Joy: no product rule at all
  e := pg_temp.accept('3', r, 5);
  PERFORM pg_temp.check(e LIKE '%someone other than who released%', 'no-rule officer refused: ' || COALESCE(e, 'no error'));
  e := pg_temp.accept('1', r, 5);   -- Gideon accepts Joy's, as before
  PERFORM pg_temp.check(e IS NULL, 'Gideon accepts another person''s sachet: ' || COALESCE(e, ''));

  r := pg_temp.make('2', '1', 5);   -- Kemi: bottles only
  e := pg_temp.accept('2', r, 5);
  PERFORM pg_temp.check(e LIKE '%someone other than who released%', 'bottle officer refused: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 5: a bottle officer's own bottles still need a second person
DO $$
DECLARE r uuid; e text;
BEGIN
  r := pg_temp.make('2', '3', 8);
  e := pg_temp.accept('2', r, 8);
  PERFORM pg_temp.check(e LIKE '%someone other than who released%', 'own bottles refused: ' || COALESCE(e, 'no error'));
END $$;

-- @@ Test 6: isolation -- each officer accepts and refuses only their own products
DO $$
DECLARE sachet uuid; bottles uuid; e text;
BEGIN
  sachet := pg_temp.make('3', '1', 7);
  e := pg_temp.accept('2', sachet, 7);
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Kemi cannot accept sachet: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.act('2');  -- the failed accept above undid the switch to Kemi
  BEGIN
    PERFORM public.reject_production_release(sachet, 'no');
    e := NULL;
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Kemi cannot refuse sachet: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.check((SELECT status FROM production_releases WHERE id = sachet) = 'pending', 'sachet still waiting');
  e := pg_temp.accept('1', sachet, 7);
  PERFORM pg_temp.check(e IS NULL, 'Gideon accepts it: ' || COALESCE(e, ''));

  bottles := pg_temp.make('3', '3', 9);
  e := pg_temp.accept('1', bottles, 9);
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Gideon cannot accept bottles: ' || COALESCE(e, 'no error'));
  e := pg_temp.accept('2', bottles, 9);
  PERFORM pg_temp.check(e IS NULL, 'Kemi accepts bottles: ' || COALESCE(e, ''));
END $$;

-- @@ Test 7: only someone handling sachet can restock it
DO $$
DECLARE e text; before numeric := pg_temp.stock('1');
BEGIN
  PERFORM pg_temp.act('2');
  BEGIN
    PERFORM public.warehouse_restock(jsonb_build_object('factory_id', (SELECT id FROM factories WHERE code = 'water'),
      'product_id', 'b4300000-0000-0000-0000-000000000001', 'quantity', 5));
    e := NULL;
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  PERFORM pg_temp.check(e LIKE '%not one of your products%', 'Kemi cannot restock sachet: ' || COALESCE(e, 'no error'));
  PERFORM pg_temp.act('1');
  PERFORM public.warehouse_restock(jsonb_build_object('factory_id', (SELECT id FROM factories WHERE code = 'water'),
    'product_id', 'b4300000-0000-0000-0000-000000000001', 'quantity', 5));
  PERFORM pg_temp.check(pg_temp.stock('1') = before + 5, 'Gideon restocks sachet');
END $$;
