-- ============================================================================
-- QUICK-ADD PRODUCT — quick_add_product()
-- ----------------------------------------------------------------------------
-- The "+ Add new product" entry in the Sales / Sales Returns / Production /
-- Distribution / Procurement dropdowns inserted straight into public.products.
-- The products RLS write policy needs finished-goods:write, so anyone working
-- in those screens without Finished Goods write access got
--   new row violates row-level security policy for table "products".
-- Raw materials already avoid this via request_new_material(); this is the
-- same pattern for products: a SECURITY DEFINER RPC that checks the caller
-- holds write/submit on Finished Goods or on the screen they are working in.
-- The RLS policy on the table itself is left unchanged.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.quick_add_product(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_name text := btrim(COALESCE(payload->>'name', ''));
  v_unit text := btrim(COALESCE(payload->>'unit', ''));
  v_type text := COALESCE(NULLIF(payload->>'product_type', ''), 'finished');
  v_category uuid := NULLIF(payload->>'category_id', '')::uuid;
  v_price numeric := COALESCE((payload->>'unit_price')::numeric, 0);
  v_cost numeric := COALESCE((payload->>'cost_price')::numeric, 0);
  v_opening numeric := COALESCE((payload->>'current_stock')::numeric, 0);
  v_id uuid;
  v_ok boolean := false;
  v_mod text;
  v_act text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  FOREACH v_mod IN ARRAY ARRAY['finished-goods','sales','sales-returns','production','distribution','purchase-orders'] LOOP
    FOREACH v_act IN ARRAY ARRAY['write','submit'] LOOP
      IF public.has_permission(v_uid, v_mod::module_key, v_act::action_key) THEN v_ok := true; END IF;
    END LOOP;
  END LOOP;
  IF NOT v_ok THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Product name is required'; END IF;
  IF v_unit = '' THEN RAISE EXCEPTION 'Unit is required'; END IF;
  IF v_type NOT IN ('finished', 'semi_finished') THEN RAISE EXCEPTION 'Invalid product type'; END IF;
  IF v_price < 0 OR v_cost < 0 OR v_opening < 0 THEN RAISE EXCEPTION 'Price, cost and stock must be zero or more'; END IF;

  INSERT INTO products(factory_id, category_id, name, unit, unit_price, cost_price, current_stock, active, product_type)
  VALUES (v_factory, v_category, v_name, v_unit, v_price, v_cost, v_opening, true, v_type)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create_new_product', 'products', v_id::text, payload);

  RETURN jsonb_build_object('id', v_id);
END; $$;
REVOKE ALL ON FUNCTION public.quick_add_product(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quick_add_product(jsonb) TO authenticated;
