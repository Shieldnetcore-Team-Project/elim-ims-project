-- ============================================================================
-- Products: only an administrator edits them (Costing -> Product Prices)
-- ----------------------------------------------------------------------------
-- User request (2026-11-01): on Costing every item can be edited -- name,
-- selling price, cost price and the rest -- by the administrator only, and
-- the change shows on every page (they all read the same products row).
--
--   _is_product_admin          Admin (super_admin) or Chairman
--   _products_admin_only_edit  refuses, for anyone else signed in, a change
--                              to a product's name, unit, selling price,
--                              SKU, category or type -- from any page.
--                              Stock and the active flag move as before;
--                              migrations (no user) are not affected.
--   set_product_prices         (Costing -> Save changes) Admin only
--   set_product_cost_price     (the product form's cost price) Admin only.
--                              A costing sheet's approval still sets the
--                              cost price through its own approval step.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._is_product_admin(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_user IS NOT NULL AND (public.has_role(p_user, 'super_admin') OR public.has_role(p_user, 'chairman'));
$$;
REVOKE ALL ON FUNCTION public._is_product_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_product_admin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public._products_admin_only_edit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public._is_product_admin(auth.uid())
     AND (NEW.name IS DISTINCT FROM OLD.name
          OR NEW.unit IS DISTINCT FROM OLD.unit
          OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
          OR NEW.sku IS DISTINCT FROM OLD.sku
          OR NEW.category_id IS DISTINCT FROM OLD.category_id
          OR NEW.product_type IS DISTINCT FROM OLD.product_type) THEN
    RAISE EXCEPTION 'Only an administrator can change a product''s name, unit, price, category or type (Costing -> Product Prices)';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_products_admin_only_edit ON public.products;
CREATE TRIGGER trg_products_admin_only_edit BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._products_admin_only_edit();

CREATE OR REPLACE FUNCTION public.set_product_prices(p_prices jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_row products%ROWTYPE;
  v_price numeric;
  v_changed int := 0;
BEGIN
  IF NOT public._is_product_admin(v_uid) THEN
    RAISE EXCEPTION 'Only an administrator can change product prices';
  END IF;
  IF p_prices IS NULL OR jsonb_typeof(p_prices) <> 'array' THEN RAISE EXCEPTION 'No prices to save'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_prices) LOOP
    v_price := NULLIF(v_item->>'unit_price', '')::numeric;
    IF v_price IS NULL OR v_price < 0 THEN RAISE EXCEPTION 'Every price must be zero or more'; END IF;
    SELECT * INTO v_row FROM products WHERE id = (v_item->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
    IF v_row.unit_price = v_price THEN CONTINUE; END IF;

    UPDATE products SET unit_price = v_price, updated_at = now() WHERE id = v_row.id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_row.factory_id, 'set_product_price', 'products', v_row.id::text,
            jsonb_build_object('name', v_row.name, 'unit_price', v_row.unit_price),
            jsonb_build_object('name', v_row.name, 'unit_price', v_price));
    v_changed := v_changed + 1;
  END LOOP;

  RETURN jsonb_build_object('changed', v_changed);
END;
$$;
REVOKE ALL ON FUNCTION public.set_product_prices(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_product_prices(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_product_cost_price(p_id uuid, p_cost numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row products%ROWTYPE;
BEGIN
  IF NOT public._is_product_admin(v_uid) THEN
    RAISE EXCEPTION 'Only an administrator can change a product cost price';
  END IF;
  IF p_cost IS NULL OR p_cost < 0 THEN RAISE EXCEPTION 'Cost must be zero or more'; END IF;
  SELECT * INTO v_row FROM products WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_row.cost_price IS NOT DISTINCT FROM p_cost THEN RETURN; END IF;

  UPDATE products SET cost_price = p_cost, updated_at = now() WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'set_product_cost', 'products', p_id::text,
          jsonb_build_object('cost_price', v_row.cost_price), jsonb_build_object('cost_price', p_cost));
END; $$;
REVOKE ALL ON FUNCTION public.set_product_cost_price(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_product_cost_price(uuid, numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';
