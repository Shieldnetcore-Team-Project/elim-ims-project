-- ============================================================================
-- Add a supplier from the Store / QC forms
-- ----------------------------------------------------------------------------
-- The Store records a supplier delivery (Add Material → goods receipt, or a
-- new material) and QC inspects one, each picking the supplier from a
-- dropdown. When the supplier was not on the list they had to leave, go to
-- the Suppliers page -- which Store and QC staff usually cannot write to
-- (suppliers insert needs suppliers:write) -- and come back.
--
-- quick_add_supplier() adds it from the form itself, to the same suppliers
-- table the Suppliers page and every supplier dropdown read. Allowed for
-- anyone who can record or inspect material (raw-materials create / edit /
-- submit, goods-receiving submit) as well as suppliers:write. A supplier of
-- the same name in the factory (ignoring case and spacing) is reused, never
-- duplicated. Audited; the full supplier record can be completed later on
-- the Suppliers page.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.quick_add_supplier(p_factory uuid, p_name text, p_phone text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := regexp_replace(btrim(COALESCE(p_name, '')), '\s+', ' ', 'g');
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'suppliers'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'raw-materials'::module_key, 'create'::action_key)
       OR public.has_permission(v_uid, 'raw-materials'::module_key, 'edit'::action_key)
       OR public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key)
       OR public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_factory IS NULL THEN RAISE EXCEPTION 'factory required'; END IF;
  IF length(v_name) < 2 THEN RAISE EXCEPTION 'Enter the supplier name'; END IF;

  SELECT id INTO v_id FROM suppliers
   WHERE factory_id = p_factory AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(v_name)
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_id, 'name', v_name, 'existing', true);
  END IF;

  INSERT INTO suppliers(factory_id, name, phone)
  VALUES (p_factory, v_name, NULLIF(btrim(COALESCE(p_phone, '')), ''))
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, p_factory, 'quick_add_supplier', 'suppliers', v_id::text,
          jsonb_build_object('name', v_name, 'phone', p_phone));
  RETURN jsonb_build_object('id', v_id, 'name', v_name, 'existing', false);
END;
$$;
REVOKE ALL ON FUNCTION public.quick_add_supplier(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quick_add_supplier(uuid, text, text) TO authenticated;
