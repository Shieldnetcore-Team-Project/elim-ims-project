-- ============================================================================
-- Warehouse staff handle only their own products
-- ----------------------------------------------------------------------------
-- User decision (2026-11-01): both work the Warehouse, on different
-- products, and neither should post the other's by mistake:
--   Kemi   (arogundadeoluwakemi613@gmail.com)  Bottle Water -- every size
--   Gideon (gideonsunday24@gmail.com)          Dispenser / Jug Water and
--                                              Sachet Water
--
-- user_product_rules   per person, the products they handle, as patterns on
--                      the product name (so a new bottle size or dispenser
--                      is covered). Someone with no rule -- everyone else,
--                      and Admin / Chairman always -- is not limited.
-- _user_may_handle_product  the check.
-- Enforced when the person:
--   posts to a marketer or the shop      (stock_dispatch_items)
--   records unsold goods brought back    (rep_return_items)
--   posts from Warehouse stock to a distributor / customer (sale_items of a
--                                        sale with no marketer or shop)
-- my_product_rules     the signed-in person's patterns, so the product
--                      lists show only their products.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_product_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES authusers(id) ON DELETE CASCADE,
  name_pattern text NOT NULL CHECK (btrim(name_pattern) <> ''),
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name_pattern)
);
GRANT SELECT ON public.user_product_rules TO authenticated;
GRANT ALL ON public.user_product_rules TO service_role;
ALTER TABLE public.user_product_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own product rules read" ON public.user_product_rules;
CREATE POLICY "own product rules read" ON public.user_product_rules FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
-- No write policy: set here or by an administrator in the SQL Editor.

CREATE OR REPLACE FUNCTION public._user_may_handle_product(p_user uuid, p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_user IS NULL
      OR public.has_role(p_user, 'super_admin') OR public.has_role(p_user, 'chairman')
      OR NOT EXISTS (SELECT 1 FROM user_product_rules WHERE user_id = p_user)
      OR EXISTS (SELECT 1 FROM user_product_rules r JOIN products p ON p.id = p_product
                  WHERE r.user_id = p_user AND p.name ~* r.name_pattern);
$$;
REVOKE ALL ON FUNCTION public._user_may_handle_product(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._enforce_user_products()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text;
BEGIN
  -- A posting from Warehouse stock only (a marketer's or the shop's own sale
  -- is not the Warehouse's).
  -- (Nested: NEW.sale_id exists on sale_items only.)
  IF TG_TABLE_NAME = 'sale_items' THEN
    IF (SELECT s.sales_rep_id FROM sales s WHERE s.id = NEW.sale_id) IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT public._user_may_handle_product(auth.uid(), NEW.product_id) THEN
    v_name := (SELECT name FROM products WHERE id = NEW.product_id);
    RAISE EXCEPTION '% is not one of your products -- it is handled by another Warehouse officer', COALESCE(v_name, 'This product');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_user_products_dispatch ON public.stock_dispatch_items;
CREATE TRIGGER trg_user_products_dispatch BEFORE INSERT ON public.stock_dispatch_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_user_products();
DROP TRIGGER IF EXISTS trg_user_products_return ON public.rep_return_items;
CREATE TRIGGER trg_user_products_return BEFORE INSERT ON public.rep_return_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_user_products();
DROP TRIGGER IF EXISTS trg_user_products_sale ON public.sale_items;
CREATE TRIGGER trg_user_products_sale BEFORE INSERT ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_user_products();

CREATE OR REPLACE FUNCTION public.my_product_rules()
RETURNS TABLE(name_pattern text, label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.name_pattern, r.label FROM user_product_rules r
   WHERE r.user_id = auth.uid()
     AND NOT (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));
$$;
REVOKE ALL ON FUNCTION public.my_product_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_product_rules() TO authenticated;

-- Kemi: bottles; Gideon: dispensers and sachet. Each only when exactly one
-- account has that email; otherwise a notice says why.
DO $$
DECLARE
  v_t record;
  v_n int;
  v_user uuid;
BEGIN
  FOR v_t IN
    SELECT * FROM (VALUES
      ('arogundadeoluwakemi613@gmail.com', 'Kemi', ARRAY['bottle water'], ARRAY['Bottle Water (all sizes)']),
      ('gideonsunday24@gmail.com', 'Gideon', ARRAY['dispenser|jug water', 'sachet'],
       ARRAY['Dispenser / Jug Water', 'Sachet Water'])
    ) AS t(email, who, patterns, labels)
  LOOP
    v_n := (SELECT count(*) FROM profiles WHERE lower(btrim(email)) = v_t.email);
    IF v_n <> 1 THEN
      RAISE NOTICE '%: % accounts have % -- not set', v_t.who, v_n, v_t.email;
      CONTINUE;
    END IF;
    v_user := (SELECT id FROM profiles WHERE lower(btrim(email)) = v_t.email);
    DELETE FROM user_product_rules WHERE user_id = v_user;
    INSERT INTO user_product_rules(user_id, name_pattern, label)
    SELECT v_user, p, l FROM unnest(v_t.patterns, v_t.labels) AS x(p, l);
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), NULL, 'set_product_rules', 'user_product_rules', v_user::text,
            jsonb_build_object('who', v_t.who, 'products', to_jsonb(v_t.labels)));
    RAISE NOTICE '%: handles only %', v_t.who, array_to_string(v_t.labels, ', ');
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
