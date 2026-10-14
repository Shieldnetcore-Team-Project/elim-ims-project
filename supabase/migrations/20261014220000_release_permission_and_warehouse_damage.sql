-- ============================================================================
-- Releasing to the Warehouse: whoever records production can release it
-- ----------------------------------------------------------------------------
-- release_to_warehouse() required production:create. Some production staff
-- (e.g. a production manager role set up with submit/edit rather than create)
-- could record or post batches but never release them. Releasing now accepts
-- any of production:create, production:submit or production:edit -- the same
-- people who put stock into the production hall can move it out.
--
-- Damage: production no longer records damaged quantity when it records a
-- batch -- the Warehouse records damage when it accepts a release
-- (accept_production_release), which is where it is actually counted. Batches
-- recorded earlier keep whatever damage they already carry.
-- Body otherwise identical to 20261014190000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_to_warehouse(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_request uuid := NULLIF(payload->>'production_request_id', '')::uuid;
  v_notes text := NULLIF(btrim(payload->>'notes'), '');
  v_name text := NULLIF(btrim(payload->>'released_by_name'), '');
  v_unit text;
  v_available numeric;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'production'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'production'::module_key, 'submit'::action_key)
          OR public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL OR v_product IS NULL THEN RAISE EXCEPTION 'factory_id and product_id are required'; END IF;
  IF NOT public.has_production_scope_access(v_uid, v_factory) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity to release must be > 0'; END IF;

  SELECT unit INTO v_unit FROM products WHERE id = v_product AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found in this factory'; END IF;
  IF v_request IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM production_requests WHERE id = v_request AND factory_id = v_factory
  ) THEN
    RAISE EXCEPTION 'Request not found in this factory';
  END IF;

  -- One release per product at a time, so two people can't both release the
  -- same hall stock.
  PERFORM pg_advisory_xact_lock(hashtext('production_hall:' || v_factory::text || ':' || v_product::text));
  v_available := public._production_hall_available(v_factory, v_product);
  IF v_qty > v_available THEN
    RAISE EXCEPTION 'Only % % of this product is in the production hall', v_available, COALESCE(v_unit, '');
  END IF;

  v_number := 'REL-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  INSERT INTO production_releases (factory_id, release_number, product_id, quantity, unit,
                                   production_request_id, notes, released_by, released_by_name)
  VALUES (v_factory, v_number, v_product, v_qty, v_unit, v_request, v_notes, v_uid,
          COALESCE(v_name, (SELECT full_name FROM profiles WHERE id = v_uid)))
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'release_to_warehouse', 'production_releases', v_id::text,
          jsonb_build_object('release_number', v_number, 'product_id', v_product, 'quantity', v_qty));

  RETURN jsonb_build_object('id', v_id, 'release_number', v_number, 'in_hall_after', v_available - v_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.release_to_warehouse(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_to_warehouse(jsonb) TO authenticated;
