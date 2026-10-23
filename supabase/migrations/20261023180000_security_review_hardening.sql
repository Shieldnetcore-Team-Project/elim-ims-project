-- ============================================================================
-- Security review of the Store / Brands / QC work (2026-10-23)
-- ----------------------------------------------------------------------------
-- 1. Stock moves stay inside the user's factory. request_stock_adjustment
--    (raw-material adjustments now post at once, 20261023130000) and
--    issue_raw_material checked the right but not the factory: a user with
--    the right in one factory could move another factory's stock. Both now
--    require a role in the item's factory (or a cross-factory role), as
--    restock_raw_material already does.
-- 2. Notifications: anyone could edit the title/body of any factory-wide
--    notification (20261023140000 let them mark it read). Only the read flag
--    can be changed now, and only for notifications of the user's own
--    factory or their own.
-- 3. Brands belong to a factory: adding, editing and deleting a brand needs a
--    role in its factory; a brand's dealer, and a material's brand, must be
--    of the same factory.
-- 4. A brand in use by materials cannot be deleted (it used to be silently
--    removed from them); remove it from the materials first.
-- 5. QC confirming a Store issue is a second pair of eyes: the person who
--    issued the stock cannot also confirm receiving it.
-- ============================================================================

-- ---------- helper: does the user work in this factory? ----------
CREATE OR REPLACE FUNCTION public._works_in_factory(p_user uuid, p_factory uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM user_roles ur
     WHERE ur.user_id = p_user AND (ur.factory_id IS NULL OR p_factory IS NULL OR ur.factory_id = p_factory));
$$;
REVOKE ALL ON FUNCTION public._works_in_factory(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._works_in_factory(uuid, uuid) TO authenticated;

-- ---------- 1a. issue_raw_material: own factory only ----------
-- As 20261020160000, plus the factory check.
CREATE OR REPLACE FUNCTION public.issue_raw_material(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material_id uuid := (payload->>'material_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_reference text := payload->>'reference';
  v_purpose text := COALESCE(payload->>'purpose', 'production');
  v_dept text := NULLIF(payload->>'issued_to_department', '');
  v_to_user uuid := NULLIF(payload->>'issued_to_user', '')::uuid;
  v_to_label text;
  v_movement_type movement_type;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'write'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_dept IS NOT NULL AND v_dept NOT IN ('production', 'quality_control') THEN
    RAISE EXCEPTION 'Issue to Production or Quality Control';
  END IF;
  IF v_to_user IS NOT NULL THEN
    IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the department the person belongs to'; END IF;
    IF NOT public._issue_department_member(v_to_user, v_dept) THEN
      RAISE EXCEPTION 'That person is not in %', CASE v_dept WHEN 'production' THEN 'Production' ELSE 'Quality Control' END;
    END IF;
  END IF;
  v_movement_type := CASE WHEN v_purpose = 'production' THEN 'used_for_production'::movement_type ELSE 'issued'::movement_type END;

  IF v_dept IS NOT NULL THEN
    v_to_label := 'Issued to ' || CASE v_dept WHEN 'production' THEN 'Production Manager' ELSE 'Quality Control' END
                  || COALESCE(' — ' || (SELECT COALESCE(NULLIF(full_name, ''), email) FROM profiles WHERE id = v_to_user), '');
    v_reason := CASE WHEN v_reason IS NULL THEN v_to_label ELSE v_to_label || ': ' || v_reason END;
  END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_material.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_material.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_material.current_stock, v_qty;
  END IF;
  v_move_cost := public.avg_unit_cost(v_material.current_value, v_material.current_stock, v_material.unit_cost);

  UPDATE raw_materials SET
    current_stock = current_stock - v_qty,
    current_value = current_value - v_qty * v_move_cost,
    updated_at = now()
  WHERE id = v_material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                     quantity_before, quantity_after, issued_to_department, issued_to_user)
  VALUES (v_material.factory_id, v_material_id, v_movement_type, v_qty, v_move_cost, v_reference, v_reason, v_uid,
          v_material.current_stock, v_material.current_stock - v_qty, v_dept, v_to_user);

  RETURN jsonb_build_object('material_id', v_material_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.issue_raw_material(jsonb) TO authenticated;

-- ---------- 1b. request_stock_adjustment: own factory only ----------
-- As 20261023130000, plus the factory check.
CREATE OR REPLACE FUNCTION public.request_stock_adjustment(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_entity_type text := payload->>'entity_type';
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_movement_type text := COALESCE(payload->>'movement_type', 'adjusted');
  v_reason text := btrim(COALESCE(payload->>'reason', ''));
  v_cost numeric := NULLIF(payload->>'unit_cost', '')::numeric;
  v_factory uuid; v_id uuid; v_module public.module_key; v_number text; v_item_name text; v_post jsonb;
BEGIN
  IF v_entity_type NOT IN ('raw_material','finished_good') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'quantity_delta must be non-zero'; END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'A reason is required for a stock adjustment'; END IF;
  IF lower(v_reason) IN ('adjustment','adjust','adjusted','n/a','na','misc','miscellaneous','other','stock adjustment','correction') THEN
    RAISE EXCEPTION 'Reason must be a meaningful explanation, not just "%"', v_reason;
  END IF;
  IF length(v_reason) < 5 THEN RAISE EXCEPTION 'Reason is too short — provide a meaningful explanation'; END IF;
  IF v_cost IS NOT NULL AND v_cost < 0 THEN RAISE EXCEPTION 'Unit cost cannot be negative'; END IF;
  v_module := CASE v_entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;

  IF v_entity_type = 'raw_material' THEN
    IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id, name INTO v_factory, v_item_name FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  ELSE
    IF NOT public.has_permission(v_uid, 'finished-goods'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id, name INTO v_factory, v_item_name FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  END IF;

  -- Only someone who works in this factory (or across all factories).
  IF NOT public._works_in_factory(v_uid, v_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  v_number := 'ADJ-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO stock_adjustment_requests(factory_id, reference_number, entity_type, material_id, product_id, quantity_delta,
                                        movement_type, reason, submitted_by, status, unit_cost)
  VALUES (v_factory, v_number, v_entity_type, v_material_id, v_product_id, v_delta, v_movement_type, v_reason, v_uid,
          'pending_approval', v_cost)
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action(v_module, v_id, 'submit', NULL, 'pending_approval', v_reason);

  IF v_entity_type = 'raw_material' THEN
    v_post := public._post_raw_material_adjustment(v_id, v_uid);
    RETURN jsonb_build_object('id', v_id, 'reference_number', v_number, 'posted', true,
                              'current_stock', v_post->'current_stock');
  END IF;

  INSERT INTO notifications(factory_id, title, body)
  VALUES (v_factory, 'Stock adjustment awaiting approval',
          v_number || ' — ' || COALESCE(v_item_name, 'item') || ' (' || (CASE WHEN v_delta > 0 THEN '+' ELSE '' END) || v_delta || ') — ' || v_reason);

  RETURN jsonb_build_object('id', v_id, 'reference_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_stock_adjustment(jsonb) TO authenticated;

-- ---------- 2. Notifications: only the read flag, only your own factory ----------
REVOKE UPDATE ON public.notifications FROM authenticated;
GRANT UPDATE (read) ON public.notifications TO authenticated;
DROP POLICY IF EXISTS "update own notifications" ON public.notifications;
CREATE POLICY "update own notifications" ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR (user_id IS NULL AND public._works_in_factory(auth.uid(), factory_id)))
  WITH CHECK (user_id = auth.uid() OR (user_id IS NULL AND public._works_in_factory(auth.uid(), factory_id)));

-- ---------- 3. Brands belong to a factory ----------
DROP POLICY IF EXISTS "brands create" ON public.brands;
CREATE POLICY "brands create" ON public.brands FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
              AND public._works_in_factory(auth.uid(), factory_id));
DROP POLICY IF EXISTS "brands edit" ON public.brands;
CREATE POLICY "brands edit" ON public.brands FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key)
         AND public._works_in_factory(auth.uid(), factory_id))
  WITH CHECK (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key)
              AND public._works_in_factory(auth.uid(), factory_id));
DROP POLICY IF EXISTS "brands delete" ON public.brands;
CREATE POLICY "brands delete" ON public.brands FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'delete'::action_key)
         AND public._works_in_factory(auth.uid(), factory_id));

-- A brand's dealer, and a material's brand, are of the same factory.
CREATE OR REPLACE FUNCTION public._brand_same_factory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'brands' THEN
    IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM suppliers WHERE id = NEW.supplier_id AND factory_id = NEW.factory_id) THEN
      RAISE EXCEPTION 'The dealer must be a supplier of the same factory';
    END IF;
  ELSIF NEW.brand_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM brands WHERE id = NEW.brand_id AND factory_id = NEW.factory_id) THEN
    RAISE EXCEPTION 'The brand must be of the same factory as the material';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._brand_same_factory() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS brands_same_factory ON public.brands;
CREATE TRIGGER brands_same_factory BEFORE INSERT OR UPDATE OF supplier_id, factory_id ON public.brands
  FOR EACH ROW EXECUTE FUNCTION public._brand_same_factory();
DROP TRIGGER IF EXISTS raw_materials_brand_same_factory ON public.raw_materials;
CREATE TRIGGER raw_materials_brand_same_factory BEFORE INSERT OR UPDATE OF brand_id, factory_id ON public.raw_materials
  FOR EACH ROW EXECUTE FUNCTION public._brand_same_factory();

-- ---------- 4. A brand in use cannot be deleted ----------
ALTER TABLE public.raw_materials DROP CONSTRAINT IF EXISTS raw_materials_brand_id_fkey;
ALTER TABLE public.raw_materials
  ADD CONSTRAINT raw_materials_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE RESTRICT;

-- ---------- 5. QC confirmation is a second person ----------
-- As 20261023160000, plus: not the person who issued it.
CREATE OR REPLACE FUNCTION public.qc_confirm_store_receipt(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_r qc_store_receipts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_r FROM qc_store_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_r.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_r.status = 'confirmed' THEN
    RETURN jsonb_build_object('id', p_id, 'confirmed', true, 'already', true);
  END IF;
  IF v_r.issued_by = v_uid THEN
    RAISE EXCEPTION 'You issued this stock -- someone in Quality Control confirms receiving it';
  END IF;
  UPDATE qc_store_receipts SET status = 'confirmed', confirmed_by = v_uid, confirmed_at = now() WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_r.factory_id, 'qc_confirm_store_receipt', 'qc_store_receipts', p_id::text,
          jsonb_build_object('material_id', v_r.material_id, 'quantity', v_r.quantity));
  RETURN jsonb_build_object('id', p_id, 'confirmed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_confirm_store_receipt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_confirm_store_receipt(uuid) TO authenticated;

-- The trigger function is only for the trigger.
REVOKE ALL ON FUNCTION public._qc_store_receipt_from_issue() FROM PUBLIC, anon, authenticated;
