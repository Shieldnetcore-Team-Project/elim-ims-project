-- ============================================================================
-- Acceptance tests: no minimum sale quantity
-- (20261029270000_no_minimum_sale_quantity.sql)
--
-- Runs against a database with every migration applied and Supabase's auth
-- stubbed so auth.uid() reads the 'test.uid' setting -- see
-- supabase/tests/pglite/README.md. A "minimum 5 packs" rule is planted the
-- way it could have been added to the live database (a CHECK and a trigger);
-- _drop_sale_minimums() removes both, keeps the normal checks, and then the
-- Warehouse posts 1 pack to a distributor and the Retail Shop sells 1 pack.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('be300000-0000-0000-0000-000000000001', 'wh@nomin');
DELETE FROM user_roles WHERE user_id = 'be300000-0000-0000-0000-000000000001';
INSERT INTO user_roles(user_id, role) VALUES ('be300000-0000-0000-0000-000000000001', 'super_admin');
INSERT INTO products(id, factory_id, name, unit, product_type, active, current_stock, unit_price)
SELECT 'bf300000-0000-0000-0000-000000000001', id, 'NOM 35cl Bottle Water', 'Pack', 'finished', true, 100, 2550
  FROM factories WHERE code = 'water';
INSERT INTO customers(id, factory_id, name, registered)
SELECT 'bf300000-0000-0000-0000-000000000011', id, 'NOM Distributor', true FROM factories WHERE code = 'water';
INSERT INTO sales_reps(id, factory_id, full_name, status, kind)
SELECT 'bf300000-0000-0000-0000-000000000021', id, 'NOM Shop', 'active', 'outlet' FROM factories WHERE code = 'water';
INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
SELECT 'bf300000-0000-0000-0000-000000000021', 'bf300000-0000-0000-0000-000000000001', id, 10 FROM factories WHERE code = 'water';

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: with the migrations alone there is nothing to remove, and the normal checks stay
DO $$
BEGIN
  PERFORM pg_temp.check(public._drop_sale_minimums() = '[]'::jsonb, 'nothing dropped from a clean database');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sale_items'::regclass
                                   AND contype = 'c' AND pg_get_constraintdef(oid) ~* 'quantity > '),
                        'quantity > 0 check kept');
END $$;

-- @@ Test 2: a planted minimum of 5 (constraint + trigger) is removed; 1 pack then posts for Warehouse and Retail
DO $$
DECLARE r jsonb; f uuid := (SELECT id FROM factories WHERE code = 'water');
BEGIN
  ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_min_five CHECK (quantity >= 5);
  CREATE FUNCTION public._planted_min_five() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN
    IF NEW.quantity < 5 THEN RAISE EXCEPTION 'minimum per product is 5 to post'; END IF;
    RETURN NEW;
  END $f$;
  CREATE TRIGGER trg_planted_min_five BEFORE INSERT ON public.sale_items
    FOR EACH ROW EXECUTE FUNCTION public._planted_min_five();

  r := public._drop_sale_minimums();
  PERFORM pg_temp.check(jsonb_array_length(r) = 2, 'both removed: ' || r::text);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sale_items'::regclass
                                   AND contype = 'c' AND pg_get_constraintdef(oid) ~* 'quantity > '),
                        'quantity > 0 check still kept');

  PERFORM set_config('test.uid', 'be300000-0000-0000-0000-000000000001', false);
  r := public.create_sale(jsonb_build_object('factory_id', f,
    'customer_id', 'bf300000-0000-0000-0000-000000000011', 'customer_name', 'NOM Distributor',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'bf300000-0000-0000-0000-000000000001', 'quantity', 1)),
    'payments', '[]'::jsonb));
  PERFORM pg_temp.check(r->>'status' = 'posted', 'warehouse 1 pack posted: ' || r::text);
  r := public.create_sale(jsonb_build_object('factory_id', f, 'customer_name', 'Walk-in',
    'sales_rep_id', 'bf300000-0000-0000-0000-000000000021',
    'items', jsonb_build_array(jsonb_build_object('product_id', 'bf300000-0000-0000-0000-000000000001', 'quantity', 1)),
    'payments', jsonb_build_array(jsonb_build_object('amount', 2550, 'method', 'cash'))));
  PERFORM pg_temp.check(r->>'status' = 'posted', 'retail 1 pack posted: ' || r::text);
END $$;
