-- ============================================================================
-- The jug's price comes from Costing > Product Prices
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "the name showing in the retail page should be the name
-- and cost in the Costing page". Costing lists Dispenser Water (N1,200) and
-- Dispenser Empty (N3,000) -- the empty jug. Until now the jug's price lived
-- on the jug type (container_types.jar_price / with_jar_price), set from the
-- old Jug+Water product, so a price changed on Costing never reached the
-- sale screen.
--
-- Now:
--   * the empty-jug product (Dispenser Empty) is linked to its jug type as
--     the 'empty' product;
--   * _product_jug prices from the products themselves: the jug alone = the
--     empty-jug product's price; water + jug = the water product's price +
--     the jug. With no empty-jug product the jug type's own prices are used,
--     as before. create_sale prices a Permanent line through it, so the sale
--     screen and the database always agree with Costing;
--   * jug_products also gives the empty-jug product's name, for the sale
--     screen's labels ("Dispenser Water + Dispenser Empty");
--   * the jug type's stored prices follow any price change on Costing
--     (trigger), so the jug reports show the same figures.
-- ============================================================================

-- 1. Dispenser Empty is the empty jug of the factory's dispenser jug.
CREATE OR REPLACE FUNCTION public._link_empty_jug_products()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  INSERT INTO product_containers(product_id, container_type_id, quantity_per_unit, jug_role)
  SELECT DISTINCT ON (e.id, pc.container_type_id) e.id, pc.container_type_id, 1, 'empty'
    FROM products e
    JOIN products w ON w.factory_id = e.factory_id AND w.active AND lower(btrim(w.name)) = 'dispenser water'
    JOIN product_containers pc ON pc.product_id = w.id
    JOIN container_types ct ON ct.id = pc.container_type_id AND ct.name ~* 'jug'
   WHERE e.name ~* '\mempty\M' AND e.name ~* '(dispenser|jug|jar)'
  ON CONFLICT (product_id, container_type_id) DO UPDATE SET jug_role = 'empty', quantity_per_unit = 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public._link_empty_jug_products() FROM PUBLIC, anon, authenticated;
SELECT public._link_empty_jug_products();

-- 2. Prices from the products.
CREATE OR REPLACE FUNCTION public._jug_empty_product(p_type uuid, p_factory uuid)
RETURNS TABLE(id uuid, name text, unit_price numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ep.id, ep.name, ep.unit_price
    FROM product_containers epc JOIN products ep ON ep.id = epc.product_id
   WHERE epc.container_type_id = p_type AND epc.jug_role = 'empty' AND ep.factory_id = p_factory
   ORDER BY ep.active DESC, ep.created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._jug_empty_product(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._product_jug(p_product uuid)
RETURNS TABLE(container_type_id uuid, name text, per_unit numeric, jar_price numeric, with_jar_price numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ct.id, ct.name, pc.quantity_per_unit,
         COALESCE(e.unit_price, ct.jar_price),
         CASE WHEN e.unit_price IS NULL THEN ct.with_jar_price
              ELSE p.unit_price / NULLIF(pc.quantity_per_unit, 0) + e.unit_price END
    FROM product_containers pc
    JOIN products p ON p.id = pc.product_id
    JOIN container_types ct ON ct.id = pc.container_type_id AND ct.active
    LEFT JOIN LATERAL public._jug_empty_product(ct.id, p.factory_id) e ON true
   WHERE pc.product_id = p_product AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
     AND ct.name ~* 'jug'
   ORDER BY ct.name LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._product_jug(uuid) FROM PUBLIC, anon, authenticated;

-- 3. The sale screen's list, with the empty jug's name.
DROP FUNCTION IF EXISTS public.jug_products(uuid);
CREATE FUNCTION public.jug_products(p_factory uuid)
RETURNS TABLE(product_id uuid, container_type_id uuid, container_name text, per_unit numeric,
              jar_price numeric, with_jar_price numeric, jar_product_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, j.container_type_id, j.name, j.per_unit, j.jar_price, j.with_jar_price,
         (SELECT e.name FROM public._jug_empty_product(j.container_type_id, p.factory_id) e)
    FROM products p, LATERAL public._product_jug(p.id) j
   WHERE p.factory_id = p_factory AND p.active;
$$;
REVOKE ALL ON FUNCTION public.jug_products(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_products(uuid) TO authenticated;

-- 4. The jug type's stored prices follow Costing.
CREATE OR REPLACE FUNCTION public._sync_jug_prices(p_type uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_jar numeric; v_with numeric;
BEGIN
  SELECT j.jar_price, j.with_jar_price INTO v_jar, v_with
    FROM product_containers pc
    JOIN products p ON p.id = pc.product_id AND p.active
    CROSS JOIN LATERAL public._product_jug(p.id) j
   WHERE pc.container_type_id = p_type AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
     AND j.container_type_id = p_type
   ORDER BY p.created_at LIMIT 1;
  IF v_jar IS NOT NULL THEN
    UPDATE container_types SET jar_price = v_jar, with_jar_price = v_with
     WHERE id = p_type AND (jar_price IS DISTINCT FROM v_jar OR with_jar_price IS DISTINCT FROM v_with);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._sync_jug_prices(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._products_sync_jug_prices()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_type uuid;
BEGIN
  IF NEW.unit_price IS DISTINCT FROM OLD.unit_price THEN
    FOR v_type IN SELECT container_type_id FROM product_containers WHERE product_id = NEW.id LOOP
      PERFORM public._sync_jug_prices(v_type);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_products_sync_jug_prices ON public.products;
CREATE TRIGGER trg_products_sync_jug_prices AFTER UPDATE OF unit_price ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._products_sync_jug_prices();

-- Now, once.
SELECT public._sync_jug_prices(id) FROM public.container_types WHERE name ~* 'jug';

NOTIFY pgrst, 'reload schema';
