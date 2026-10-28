-- ============================================================================
-- Product Prices: save selling prices from the Costing page
-- ----------------------------------------------------------------------------
-- Costing → Product Prices lists every finished product with its selling
-- price (products.unit_price, what Sales & POS and postings fill in). The
-- user edits the prices and clicks Save changes; set_product_prices saves
-- them all in one go:
--   p_prices: [{ "id": <product uuid>, "unit_price": <number> }, ...]
-- Allowed for whoever edits costing or writes finished goods (the Costing
-- page and the Warehouse's product editors). A price can't be negative.
-- Each change is audited. Unchanged prices are skipped.
--
-- And, as the user asked (2026-10-28): 75cl Bottle Water sells at 1,700 per
-- pack in the Water Factory.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_product_prices(p_prices jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_row products%ROWTYPE;
  v_price numeric;
  v_changed int := 0;
BEGIN
  IF NOT (public.has_permission(v_uid, 'costing'::module_key, 'edit'::action_key)
          OR public.has_permission(v_uid, 'finished-goods'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
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

-- 75cl Bottle Water: 1,700 per pack.
DO $$
DECLARE v_row products%ROWTYPE;
BEGIN
  SELECT p.* INTO v_row FROM products p JOIN factories f ON f.id = p.factory_id
   WHERE f.code = 'water' AND lower(btrim(p.name)) = '75cl bottle water';
  IF NOT FOUND THEN
    RAISE NOTICE '75cl Bottle Water not found -- price not set';
  ELSIF v_row.unit_price <> 1700 THEN
    UPDATE products SET unit_price = 1700, updated_at = now() WHERE id = v_row.id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (auth.uid(), v_row.factory_id, 'set_product_price', 'products', v_row.id::text,
            jsonb_build_object('name', v_row.name, 'unit_price', v_row.unit_price),
            jsonb_build_object('name', v_row.name, 'unit_price', 1700,
                               'reason', '75cl Bottle Water sells at 1,700 per pack (2026-10-28)'));
  END IF;
END $$;
