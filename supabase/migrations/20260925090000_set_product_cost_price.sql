-- ============================================================================
-- MANUAL PRODUCT COST — set_product_cost_price()
-- ----------------------------------------------------------------------------
-- products.cost_price is column-locked for direct client UPDATEs (only an
-- approved Costing sheet wrote it). Users now also need to type a cost when
-- they add a product and change it by hand later, and have it stay until
-- changed again. Creating a product with a cost already works (INSERT is not
-- locked). This RPC is the audited path for changing it afterwards, gated on
-- the same finished-goods write permission that lets someone edit the product.
-- The column lock itself is left in place.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_product_cost_price(p_id uuid, p_cost numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row products%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
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
