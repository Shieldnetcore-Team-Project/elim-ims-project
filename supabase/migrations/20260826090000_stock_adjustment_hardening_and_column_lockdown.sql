-- ============================================================================
-- STOCK ADJUSTMENT HARDENING + CURRENT_STOCK COLUMN LOCKDOWN
-- ----------------------------------------------------------------------------
-- Closes four gaps found while auditing sections 26/28/29/30/31/32 of the
-- inventory spec against the actual schema:
--
-- 1. stock_adjustment_requests had no human-readable reference number (every
--    other workflow document in this app -- goods receipts, production,
--    sales returns, purchase orders, damage records -- has one).
-- 2. No "ADMIN NOTIFICATION" step existed for a submitted adjustment; the
--    notifications table + bell-icon UI (top-bar.tsx) already exist and are
--    wired up, they just had nothing inserting into them for this flow.
-- 3. Materials' opening_stock was never represented as a ledger transaction
--    -- the 'opening_balance' movement_type value existed but nothing ever
--    inserted one, so the ledger didn't reconcile back to current_stock for
--    any material's starting quantity, and Inventory History had no
--    "Opening balance" line to show.
-- 4. products.current_stock / raw_materials.current_stock were updatable by
--    any authenticated user holding the module's general write permission
--    (store_officer / inventory_officer), completely bypassing
--    confirm_production_batch/confirm_goods_receipt/post_stock_adjustment
--    and leaving no damage_records/audit trail. Fixed with a column-level
--    privilege lockdown: only the SECURITY DEFINER RPCs (which run as the
--    function owner, not the caller) can still touch that one column.
-- ============================================================================

-- ============ 1. reference_number on stock_adjustment_requests ============
ALTER TABLE public.stock_adjustment_requests ADD COLUMN IF NOT EXISTS reference_number text;

-- Deterministic backfill for existing rows (id-derived, so no collision risk
-- across a single UPDATE statement -- the random-suffix generator below is
-- only used going forward, for new submissions one at a time).
UPDATE public.stock_adjustment_requests
SET reference_number = 'ADJ-' || to_char(submitted_at, 'YYYYMMDD') || '-' || upper(substr(id::text, 1, 8))
WHERE reference_number IS NULL;

ALTER TABLE public.stock_adjustment_requests ALTER COLUMN reference_number SET NOT NULL;
ALTER TABLE public.stock_adjustment_requests ADD CONSTRAINT stock_adjustment_requests_reference_number_key UNIQUE (reference_number);

-- ============ 2. request_stock_adjustment(): reference number + notification ============
-- Same validation body as 20260825091000_stock_adjustment_reason_required.sql
-- (the live definition) -- only the reference-number generation, item-name
-- lookup, and notifications insert are new.
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
  v_factory uuid; v_id uuid; v_module public.module_key; v_number text; v_item_name text;
BEGIN
  IF v_entity_type NOT IN ('raw_material','finished_good') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'quantity_delta must be non-zero'; END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'A reason is required for a stock adjustment'; END IF;
  IF lower(v_reason) IN ('adjustment','adjust','adjusted','n/a','na','misc','miscellaneous','other','stock adjustment','correction') THEN
    RAISE EXCEPTION 'Reason must be a meaningful explanation, not just "%"', v_reason;
  END IF;
  IF length(v_reason) < 5 THEN RAISE EXCEPTION 'Reason is too short — provide a meaningful explanation'; END IF;
  v_module := CASE v_entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;

  IF v_entity_type = 'raw_material' THEN
    IF NOT public.has_permission(v_uid, 'raw-materials', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id, name INTO v_factory, v_item_name FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  ELSE
    IF NOT public.has_permission(v_uid, 'finished-goods', 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id, name INTO v_factory, v_item_name FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  END IF;

  v_number := 'ADJ-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO stock_adjustment_requests(factory_id, reference_number, entity_type, material_id, product_id, quantity_delta, movement_type, reason, submitted_by, status)
  VALUES (v_factory, v_number, v_entity_type, v_material_id, v_product_id, v_delta, v_movement_type, v_reason, v_uid, 'pending_approval')
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action(v_module, v_id, 'submit', NULL, 'pending_approval', v_reason);

  INSERT INTO notifications(factory_id, title, body)
  VALUES (v_factory, 'Stock adjustment awaiting approval',
          v_number || ' — ' || COALESCE(v_item_name, 'item') || ' (' || (CASE WHEN v_delta > 0 THEN '+' ELSE '' END) || v_delta || ') — ' || v_reason);

  RETURN jsonb_build_object('id', v_id, 'reference_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_stock_adjustment(jsonb) TO authenticated;

-- ============ 3. approve_new_material(): log the opening balance as a real transaction ============
CREATE OR REPLACE FUNCTION public.approve_new_material(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row raw_materials%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM raw_materials WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot approve a material you added yourself';
  END IF;
  IF v_row.approval_status <> 'pending_approval' THEN RAISE EXCEPTION 'Material is already %', v_row.approval_status; END IF;

  UPDATE raw_materials SET approval_status = 'approved', active = true WHERE id = p_id;

  IF v_row.opening_stock > 0 THEN
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.id, 'opening_balance', v_row.opening_stock, v_row.unit_cost, v_row.name, 'Opening balance', v_uid, 0, v_row.opening_stock);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_new_material', 'raw_materials', p_id::text, jsonb_build_object('comment', p_comment));
  RETURN jsonb_build_object('approved', true);
END; $$;
GRANT EXECUTE ON FUNCTION public.approve_new_material(uuid, text) TO authenticated;

-- Backfill: every already-active material with a nonzero opening_stock and no
-- existing opening_balance row yet gets one, dated to when the material was
-- created so it sorts correctly ahead of every later movement. This does not
-- touch current_stock at all -- it only adds the missing historical entry.
INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after, created_at)
SELECT rm.factory_id, rm.id, 'opening_balance', rm.opening_stock, rm.unit_cost, rm.name, 'Opening balance (backfilled)', rm.created_by, 0, rm.opening_stock, rm.created_at
FROM raw_materials rm
WHERE rm.opening_stock > 0
  AND NOT EXISTS (
    SELECT 1 FROM raw_material_movements mv WHERE mv.material_id = rm.id AND mv.movement_type = 'opening_balance'
  );

-- ============ 4. current_stock column lockdown ============
-- Table-level UPDATE was granted wholesale back in the original schema
-- migration and never narrowed -- RLS controls *which rows*, not *which
-- columns*, so has_permission(...,'write') was enough to let a direct
-- .update({current_stock}) call through the Supabase client, bypassing every
-- confirm/post RPC above. Revoke the blanket grant and re-grant UPDATE on
-- every column except current_stock; the RPCs still work because
-- SECURITY DEFINER functions run as their owner, not the calling role.
REVOKE UPDATE ON public.products FROM authenticated;
GRANT UPDATE (active, barcode, category_id, cost_price, factory_id, name, product_type, reorder_level, sku, unit, unit_price, updated_at)
  ON public.products TO authenticated;

REVOKE UPDATE ON public.raw_materials FROM authenticated;
GRANT UPDATE (active, approval_status, category, category_id, created_by, factory_id, minimum_stock, name, opening_stock, remarks, reorder_level, supplier_id, unit, unit_cost, updated_at)
  ON public.raw_materials TO authenticated;
