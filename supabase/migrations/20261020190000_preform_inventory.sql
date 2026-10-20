-- ============================================================================
-- Preform Inventory (Store → Preform Inventory)
-- ----------------------------------------------------------------------------
-- The Store's view of preform stock: register preform specifications, link
-- them to suppliers, receive deliveries in bags + loose pieces, see stock as
-- pieces / full bags / loose pieces, trace receipts, issues, costs and
-- supplier history, count stock and reconcile the ledger.
--
-- Built on what already exists -- no second stock system:
--   raw_materials              the material master; stock in pieces, value at
--                              moving average (20260922180000)
--   raw_material_movements     the store ledger (read-only to the app)
--   goods_receipts             QC records a delivery, the Store confirms it,
--                              only the accepted quantity is posted
--                              (submit_goods_receipt / confirm_goods_receipt)
--   preform_issues             store -> operator, acknowledged by the operator
--                              (issue_preforms, 20261020130000)
--   stock_adjustment_requests  request -> approve -> post, maker-checker
--   raw_material_cost_history  every unit-cost change
--
-- New here:
--   raw_materials: is_preform, material_code, specification,
--                  storage_location, production_department
--   material_suppliers         which suppliers supply which material (many to
--                              many); prices stay on each goods receipt
--   goods_receipts: bags, pieces_per_bag, loose_pieces (the factor used is
--                   kept on the receipt, so a later change never rewrites
--                   it), supplier_invoice, batch_number, delivery_date,
--                   storage_location, rejection_reason, rejected_disposition,
--                   client_ref (a double click submits once)
--   stock_adjustment_requests: system_quantity, counted_quantity,
--                   supporting_reference, unit_cost, adjustment_kind
--                   (physical count / opening balance)
--   save_preform_material, save_material_supplier, request_stock_count
--   preform_inventory_overview, preform_receipts, preform_material_ledger,
--   preform_adjustments, inventory_reconciliation   (read functions)
--
-- Nothing existing is deleted, merged or re-valued. Existing preforms are
-- flagged is_preform and given a code; that is all the backfill does.
--
-- Permissions (existing modules, mapped in the Permission Matrix):
--   view                 raw-materials view, preform-production view or
--                        goods-receiving view (Store, QC, Production,
--                        Accountant, Auditor all reach the read functions)
--   register a preform   raw-materials create / submit
--   change a preform,    raw-materials edit (or the preform manager right,
--   supplier links       preform-production reverse)
--   record a delivery    goods-receiving submit; the Store confirms it
--                        (goods-receiving confirm, a different person)
--   count / opening bal. raw-materials submit; approve + post as any stock
--                        adjustment (raw-materials approve / post, a
--                        different person)
--   issue                preform-production post (issue_preforms)
-- ============================================================================

-- ============ 1. Material master fields ============
ALTER TABLE public.raw_materials
  ADD COLUMN IF NOT EXISTS is_preform boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS material_code text,
  ADD COLUMN IF NOT EXISTS specification text,
  ADD COLUMN IF NOT EXISTS storage_location text,
  ADD COLUMN IF NOT EXISTS production_department text;

CREATE UNIQUE INDEX IF NOT EXISTS raw_materials_factory_code_key
  ON public.raw_materials (factory_id, upper(material_code)) WHERE material_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS raw_materials_preform_idx
  ON public.raw_materials (factory_id) WHERE is_preform;

-- Preforms today are recognised by name or by having a bag size.
UPDATE public.raw_materials SET is_preform = true
 WHERE NOT is_preform AND (name ~* 'preform' OR pieces_per_bag IS NOT NULL);

CREATE OR REPLACE FUNCTION public._pinv_next_code(p_factory uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'PF-' || lpad((COALESCE(MAX(substring(upper(material_code) FROM '^PF-(\d+)$')::int), 0) + 1)::text, 3, '0')
    FROM raw_materials WHERE factory_id = p_factory;
$$;
REVOKE ALL ON FUNCTION public._pinv_next_code(uuid) FROM PUBLIC, anon, authenticated;

-- Codes for the preforms already registered, in name order.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, factory_id FROM public.raw_materials
            WHERE is_preform AND material_code IS NULL ORDER BY factory_id, name, created_at LOOP
    UPDATE public.raw_materials SET material_code = public._pinv_next_code(r.factory_id) WHERE id = r.id;
  END LOOP;
END $$;

-- ============ 2. Helpers ============
CREATE OR REPLACE FUNCTION public._pinv_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'raw-materials'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'preform-production'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key);
$$;
REVOKE ALL ON FUNCTION public._pinv_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pinv_can_view() TO authenticated;

-- Change a registered preform or its supplier links (the same right that
-- changes pieces per bag, 20261020140000).
CREATE OR REPLACE FUNCTION public._pinv_can_configure()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key)
      OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'write'::action_key)
      OR public.has_permission(auth.uid(), 'preform-production'::module_key, 'reverse'::action_key);
$$;
REVOKE ALL ON FUNCTION public._pinv_can_configure() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pinv_can_configure() TO authenticated;

CREATE OR REPLACE FUNCTION public._pinv_norm(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(COALESCE(p, '')), '\s+', ' ', 'g'));
$$;

-- ============ 3. Supplier <-> material links ============
CREATE TABLE IF NOT EXISTS public.material_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
  supplier_item_code text,
  -- This supplier's bag size for this preform, when it differs from the
  -- specification's default (raw_materials.pieces_per_bag): bag size is
  -- packaging, so two suppliers of the same preform may pack differently.
  pieces_per_bag numeric CHECK (pieces_per_bag IS NULL OR (pieces_per_bag > 0 AND pieces_per_bag = trunc(pieces_per_bag))),
  is_preferred boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_id, supplier_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS material_suppliers_one_preferred
  ON public.material_suppliers (material_id) WHERE is_preferred;
CREATE INDEX IF NOT EXISTS material_suppliers_supplier_idx ON public.material_suppliers (supplier_id);

ALTER TABLE public.material_suppliers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "material suppliers read" ON public.material_suppliers;
CREATE POLICY "material suppliers read" ON public.material_suppliers FOR SELECT TO authenticated
  USING (public._pinv_can_view()
         OR public.has_permission(auth.uid(), 'suppliers'::module_key, 'view'::action_key));
REVOKE ALL ON public.material_suppliers FROM anon, authenticated;
GRANT SELECT ON public.material_suppliers TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND tablename = 'material_suppliers') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.material_suppliers;
  END IF;
END $$;

-- Backfill from what is already recorded: each material's current supplier
-- (preferred) and every supplier a delivery was recorded from.
INSERT INTO public.material_suppliers (factory_id, material_id, supplier_id, is_preferred)
SELECT m.factory_id, m.id, m.supplier_id, true
  FROM public.raw_materials m
 WHERE m.supplier_id IS NOT NULL
ON CONFLICT (material_id, supplier_id) DO NOTHING;
INSERT INTO public.material_suppliers (factory_id, material_id, supplier_id)
SELECT DISTINCT g.factory_id, g.material_id, g.supplier_id
  FROM public.goods_receipts g
 WHERE g.supplier_id IS NOT NULL AND g.status NOT IN ('cancelled', 'rejected')
ON CONFLICT (material_id, supplier_id) DO NOTHING;

-- p_pieces_per_bag: NULL keeps this supplier's bag size as it is, 0 clears it
-- (deliveries then use the specification's default), a whole number sets it.
-- Past receipts keep the bag size they were recorded with.
CREATE OR REPLACE FUNCTION public.save_material_supplier(
  p_material uuid, p_supplier uuid, p_preferred boolean DEFAULT false, p_active boolean DEFAULT true,
  p_item_code text DEFAULT NULL, p_notes text DEFAULT NULL, p_pieces_per_bag numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m raw_materials%ROWTYPE;
  v_s suppliers%ROWTYPE;
  v_old material_suppliers%ROWTYPE;
  v_id uuid;
BEGIN
  IF NOT (public._pinv_can_configure()
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  SELECT * INTO v_s FROM suppliers WHERE id = p_supplier;
  IF NOT FOUND OR v_s.factory_id <> v_m.factory_id THEN RAISE EXCEPTION 'Supplier not found for this factory'; END IF;
  IF COALESCE(p_preferred, false) AND NOT COALESCE(p_active, true) THEN
    RAISE EXCEPTION 'An inactive supplier cannot be the preferred supplier';
  END IF;
  IF p_pieces_per_bag IS NOT NULL AND (p_pieces_per_bag < 0 OR p_pieces_per_bag <> trunc(p_pieces_per_bag)) THEN
    RAISE EXCEPTION 'Pieces per bag must be a whole number above 0';
  END IF;

  SELECT * INTO v_old FROM material_suppliers WHERE material_id = p_material AND supplier_id = p_supplier;
  IF COALESCE(p_preferred, false) THEN
    UPDATE material_suppliers SET is_preferred = false, updated_at = now()
     WHERE material_id = p_material AND supplier_id <> p_supplier AND is_preferred;
  END IF;
  INSERT INTO material_suppliers (factory_id, material_id, supplier_id, supplier_item_code, pieces_per_bag,
                                  is_preferred, active, notes, created_by)
  VALUES (v_m.factory_id, p_material, p_supplier, NULLIF(btrim(COALESCE(p_item_code, '')), ''),
          NULLIF(p_pieces_per_bag, 0),
          COALESCE(p_preferred, false), COALESCE(p_active, true), NULLIF(btrim(COALESCE(p_notes, '')), ''), auth.uid())
  ON CONFLICT (material_id, supplier_id) DO UPDATE SET
    supplier_item_code = EXCLUDED.supplier_item_code, is_preferred = EXCLUDED.is_preferred,
    pieces_per_bag = CASE WHEN p_pieces_per_bag IS NULL THEN material_suppliers.pieces_per_bag
                          ELSE EXCLUDED.pieces_per_bag END,
    active = EXCLUDED.active, notes = EXCLUDED.notes, updated_at = now()
  RETURNING id INTO v_id;

  -- raw_materials.supplier_id is the "main supplier" the rest of the ERP
  -- (reorder requests, POs) reads; keep it on the preferred one.
  IF COALESCE(p_preferred, false) THEN
    UPDATE raw_materials SET supplier_id = p_supplier WHERE id = p_material AND supplier_id IS DISTINCT FROM p_supplier;
  ELSIF v_old.is_preferred THEN
    UPDATE raw_materials SET supplier_id = NULL WHERE id = p_material AND supplier_id = p_supplier;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_m.factory_id, 'save_material_supplier', 'material_suppliers', v_id::text,
          CASE WHEN v_old.id IS NULL THEN NULL ELSE to_jsonb(v_old) END,
          jsonb_build_object('material_id', p_material, 'supplier', v_s.name, 'preferred', COALESCE(p_preferred, false),
                             'active', COALESCE(p_active, true), 'item_code', p_item_code,
                             'pieces_per_bag', (SELECT pieces_per_bag FROM material_suppliers WHERE id = v_id)));
  RETURN jsonb_build_object('id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.save_material_supplier(uuid, uuid, boolean, boolean, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_material_supplier(uuid, uuid, boolean, boolean, text, text, numeric) TO authenticated;

-- The bag size a delivery from this supplier is counted in: the supplier's
-- own for this preform if set, otherwise the specification's.
CREATE OR REPLACE FUNCTION public.receipt_pieces_per_bag(p_material uuid, p_supplier uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT ms.pieces_per_bag FROM material_suppliers ms
      WHERE ms.material_id = p_material AND ms.supplier_id = p_supplier AND ms.active),
    (SELECT m.pieces_per_bag FROM raw_materials m WHERE m.id = p_material));
$$;
REVOKE ALL ON FUNCTION public.receipt_pieces_per_bag(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_pieces_per_bag(uuid, uuid) TO authenticated;

-- Every supplier a delivery is recorded from becomes a linked supplier.
CREATE OR REPLACE FUNCTION public._pinv_link_receipt_supplier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.supplier_id IS NOT NULL THEN
    INSERT INTO material_suppliers (factory_id, material_id, supplier_id, created_by)
    VALUES (NEW.factory_id, NEW.material_id, NEW.supplier_id, NEW.submitted_by)
    ON CONFLICT (material_id, supplier_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._pinv_link_receipt_supplier() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS goods_receipts_link_supplier ON public.goods_receipts;
CREATE TRIGGER goods_receipts_link_supplier AFTER INSERT ON public.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public._pinv_link_receipt_supplier();

-- ============ 4. Register / edit a preform specification ============
-- New: raw-materials create or submit; goes through request_new_material
-- (the one place materials are created) with no stock -- opening stock is
-- entered as an approved opening balance (request_stock_count), never typed
-- into the master record. Edit: _pinv_can_configure(). The unit is fixed at
-- registration. A pieces-per-bag change goes through
-- set_material_pieces_per_bag (reason required, audited); stock is in pieces,
-- so it changes no quantity, and receipts / issues keep the factor they used.
CREATE OR REPLACE FUNCTION public.save_preform_material(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := NULLIF(payload->>'id', '')::uuid;
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_name text := NULLIF(regexp_replace(btrim(COALESCE(payload->>'name', '')), '\s+', ' ', 'g'), '');
  v_code text := NULLIF(upper(btrim(COALESCE(payload->>'material_code', ''))), '');
  v_spec text := NULLIF(btrim(COALESCE(payload->>'specification', '')), '');
  v_unit text := COALESCE(NULLIF(btrim(COALESCE(payload->>'unit', '')), ''), 'Piece');
  v_ppb numeric := NULLIF(payload->>'pieces_per_bag', '')::numeric;
  v_ppb_reason text := NULLIF(btrim(COALESCE(payload->>'pieces_per_bag_reason', '')), '');
  v_location text := NULLIF(btrim(COALESCE(payload->>'storage_location', '')), '');
  v_department text := NULLIF(btrim(COALESCE(payload->>'production_department', '')), '');
  v_reorder numeric := COALESCE(NULLIF(payload->>'reorder_level', '')::numeric, 0);
  v_active boolean := COALESCE(NULLIF(payload->>'active', '')::boolean, true);
  v_remarks text := NULLIF(btrim(COALESCE(payload->>'remarks', '')), '');
  v_category uuid := NULLIF(payload->>'category_id', '')::uuid;
  v_supplier uuid := NULLIF(payload->>'preferred_supplier_id', '')::uuid;
  v_m raw_materials%ROWTYPE;
  v_res jsonb;
BEGIN
  IF v_name IS NULL THEN RAISE EXCEPTION 'Preform name is required'; END IF;
  IF v_ppb IS NOT NULL AND (v_ppb <= 0 OR v_ppb <> trunc(v_ppb)) THEN
    RAISE EXCEPTION 'Pieces per bag must be a whole number above 0';
  END IF;
  IF v_reorder < 0 THEN RAISE EXCEPTION 'Reorder level cannot be negative'; END IF;

  IF v_id IS NULL THEN
    IF NOT (public.has_permission(v_uid, 'raw-materials'::module_key, 'create'::action_key)
            OR public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key)) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
    IF EXISTS (SELECT 1 FROM raw_materials WHERE factory_id = v_factory
                 AND public._pinv_norm(name) = public._pinv_norm(v_name)
                 AND COALESCE(approval_status, 'approved') <> 'rejected') THEN
      RAISE EXCEPTION 'A material named "%" already exists -- open it instead of registering it again', v_name;
    END IF;
    IF v_code IS NOT NULL AND EXISTS (SELECT 1 FROM raw_materials WHERE factory_id = v_factory AND upper(material_code) = v_code) THEN
      RAISE EXCEPTION 'Material code % is already in use', v_code;
    END IF;
    IF v_supplier IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id = v_supplier AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Supplier not found for this factory';
    END IF;

    v_res := public.request_new_material(jsonb_build_object(
      'factory_id', v_factory, 'name', v_name, 'unit', v_unit, 'category_id', v_category,
      'opening_stock', 0, 'unit_cost', 0, 'supplier_id', v_supplier,
      'reorder_level', v_reorder, 'remarks', v_remarks));
    v_id := (v_res->>'id')::uuid;

    UPDATE raw_materials SET
      is_preform = true,
      material_code = COALESCE(v_code, public._pinv_next_code(v_factory)),
      specification = v_spec, storage_location = v_location, production_department = v_department,
      pieces_per_bag = v_ppb, active = v_active
    WHERE id = v_id
    RETURNING * INTO v_m;
    IF v_supplier IS NOT NULL THEN
      INSERT INTO material_suppliers (factory_id, material_id, supplier_id, is_preferred, created_by)
      VALUES (v_factory, v_id, v_supplier, true, v_uid)
      ON CONFLICT (material_id, supplier_id) DO UPDATE SET is_preferred = true, updated_at = now();
    END IF;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (v_uid, v_factory, 'register_preform', 'raw_materials', v_id::text, payload);
    RETURN jsonb_build_object('id', v_id, 'material_code', v_m.material_code, 'created', true);
  END IF;

  IF NOT public._pinv_can_configure() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF EXISTS (SELECT 1 FROM raw_materials WHERE factory_id = v_m.factory_id AND id <> v_id
               AND public._pinv_norm(name) = public._pinv_norm(v_name)
               AND COALESCE(approval_status, 'approved') <> 'rejected') THEN
    RAISE EXCEPTION 'Another material is already named "%"', v_name;
  END IF;
  v_code := COALESCE(v_code, v_m.material_code, public._pinv_next_code(v_m.factory_id));
  IF EXISTS (SELECT 1 FROM raw_materials WHERE factory_id = v_m.factory_id AND id <> v_id AND upper(material_code) = v_code) THEN
    RAISE EXCEPTION 'Material code % is already in use', v_code;
  END IF;
  IF v_ppb IS NOT NULL AND v_ppb IS DISTINCT FROM v_m.pieces_per_bag THEN
    PERFORM public.set_material_pieces_per_bag(v_id, v_ppb, v_ppb_reason);
  END IF;

  UPDATE raw_materials SET
    name = v_name, is_preform = true, material_code = v_code, specification = v_spec,
    storage_location = v_location, production_department = v_department,
    reorder_level = v_reorder, active = v_active, remarks = v_remarks,
    category_id = COALESCE(v_category, category_id)
  WHERE id = v_id;
  IF v_supplier IS NOT NULL THEN
    -- Keep the link's item code, notes and bag size; only make it preferred.
    PERFORM public.save_material_supplier(v_id, v_supplier, true, true,
      (SELECT supplier_item_code FROM material_suppliers WHERE material_id = v_id AND supplier_id = v_supplier),
      (SELECT notes FROM material_suppliers WHERE material_id = v_id AND supplier_id = v_supplier),
      NULL);
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_m.factory_id, 'update_preform', 'raw_materials', v_id::text,
          jsonb_build_object('name', v_m.name, 'material_code', v_m.material_code, 'specification', v_m.specification,
                             'storage_location', v_m.storage_location, 'production_department', v_m.production_department,
                             'reorder_level', v_m.reorder_level, 'active', v_m.active, 'pieces_per_bag', v_m.pieces_per_bag),
          payload);
  RETURN jsonb_build_object('id', v_id, 'material_code', v_code, 'created', false);
END;
$$;
REVOKE ALL ON FUNCTION public.save_preform_material(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_preform_material(jsonb) TO authenticated;

-- ============ 5. Deliveries in bags ============
ALTER TABLE public.goods_receipts
  ADD COLUMN IF NOT EXISTS bags numeric,
  ADD COLUMN IF NOT EXISTS pieces_per_bag numeric,
  ADD COLUMN IF NOT EXISTS loose_pieces numeric,
  ADD COLUMN IF NOT EXISTS supplier_invoice text,
  ADD COLUMN IF NOT EXISTS batch_number text,
  ADD COLUMN IF NOT EXISTS delivery_date date,
  ADD COLUMN IF NOT EXISTS storage_location text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_disposition text,
  ADD COLUMN IF NOT EXISTS client_ref uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goods_receipts_bags_check') THEN
    ALTER TABLE public.goods_receipts ADD CONSTRAINT goods_receipts_bags_check CHECK (
      (bags IS NULL AND pieces_per_bag IS NULL AND loose_pieces IS NULL)
      OR (bags IS NOT NULL AND pieces_per_bag IS NOT NULL AND bags >= 0 AND bags = trunc(bags)
          AND pieces_per_bag > 0 AND COALESCE(loose_pieces, 0) >= 0
          AND quantity = bags * pieces_per_bag + COALESCE(loose_pieces, 0)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goods_receipts_rejected_disposition_check') THEN
    ALTER TABLE public.goods_receipts ADD CONSTRAINT goods_receipts_rejected_disposition_check CHECK (
      rejected_disposition IS NULL OR rejected_disposition IN ('write_off', 'return_to_supplier', 'held_for_review'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS goods_receipts_client_ref_key ON public.goods_receipts (client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS goods_receipts_material_idx ON public.goods_receipts (material_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS raw_material_movements_material_idx ON public.raw_material_movements (material_id, created_at);

-- As 20260816098000 / 20260825090000, plus: bags + loose pieces (the server
-- works out the pieces from the material's current bag size and keeps that
-- size on the receipt), supplier invoice, batch, delivery date, storage
-- location, why anything was rejected and what happens to it, and
-- client_ref so a repeated submit returns the first receipt. Without bags,
-- quantity is taken as entered (pieces for a preform) -- never converted again.
CREATE OR REPLACE FUNCTION public.submit_goods_receipt(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_purchase_order_id uuid := NULLIF(payload->>'purchase_order_id','')::uuid;
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity','')::numeric;
  v_damaged numeric := COALESCE(NULLIF(payload->>'damaged_quantity','')::numeric, 0);
  v_unit_cost numeric := NULLIF(payload->>'unit_cost','')::numeric;
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_purchase_request_id uuid := NULLIF(payload->>'purchase_request_id','')::uuid;
  v_delivery_reference text := payload->>'delivery_reference';
  v_remarks text := payload->>'remarks';
  v_bags numeric := NULLIF(payload->>'bags','')::numeric;
  v_loose numeric := NULLIF(payload->>'loose_pieces','')::numeric;
  v_sent_ppb numeric := NULLIF(payload->>'pieces_per_bag','')::numeric;
  v_ppb numeric;
  v_invoice text := NULLIF(btrim(COALESCE(payload->>'supplier_invoice','')), '');
  v_batch text := NULLIF(btrim(COALESCE(payload->>'batch_number','')), '');
  v_delivery_date date := NULLIF(payload->>'delivery_date','')::date;
  v_location text := NULLIF(btrim(COALESCE(payload->>'storage_location','')), '');
  v_reject_reason text := NULLIF(btrim(COALESCE(payload->>'rejection_reason','')), '');
  v_disposition text := NULLIF(payload->>'rejected_disposition','');
  v_client uuid := NULLIF(payload->>'client_ref','')::uuid;
  v_existing goods_receipts%ROWTYPE;
  v_material raw_materials%ROWTYPE;
  v_po purchase_orders%ROWTYPE;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM goods_receipts WHERE client_ref = v_client;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_existing.id, 'receipt_number', v_existing.receipt_number, 'duplicate', true);
    END IF;
  END IF;

  IF v_purchase_order_id IS NOT NULL THEN
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_purchase_order_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
    v_material_id := v_po.material_id;
    v_supplier_id := COALESCE(v_supplier_id, v_po.supplier_id);
  END IF;
  SELECT * INTO v_material FROM raw_materials WHERE id = v_material_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;

  IF v_bags IS NOT NULL OR v_loose IS NOT NULL THEN
    v_bags := COALESCE(v_bags, 0);
    v_loose := COALESCE(v_loose, 0);
    -- This supplier's bag size for the preform, else the specification's.
    v_ppb := public.receipt_pieces_per_bag(v_material_id, v_supplier_id);
    IF v_ppb IS NULL THEN RAISE EXCEPTION 'Set pieces per bag for % before receiving it in bags', v_material.name; END IF;
    IF v_sent_ppb IS NOT NULL AND v_sent_ppb <> v_ppb THEN
      RAISE EXCEPTION 'Pieces per bag for % from this supplier is % (the form used %) -- reopen the form', v_material.name, v_ppb, v_sent_ppb;
    END IF;
    IF v_bags < 0 OR v_loose < 0 OR v_bags <> trunc(v_bags) OR v_loose <> trunc(v_loose) THEN
      RAISE EXCEPTION 'Bags and loose pieces must be whole numbers';
    END IF;
    IF v_qty IS NOT NULL AND v_qty <> v_bags * v_ppb + v_loose THEN
      RAISE EXCEPTION 'Quantity % does not match % bags x % + % loose pieces', v_qty, v_bags, v_ppb, v_loose;
    END IF;
    v_qty := v_bags * v_ppb + v_loose;
  ELSE
    v_bags := NULL; v_loose := NULL; v_ppb := NULL;
  END IF;

  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_damaged < 0 OR v_damaged > v_qty THEN RAISE EXCEPTION 'Damaged quantity must be between 0 and the received quantity'; END IF;
  IF v_disposition IS NOT NULL AND v_disposition NOT IN ('write_off', 'return_to_supplier', 'held_for_review') THEN
    RAISE EXCEPTION 'Unknown rejected-stock disposition %', v_disposition;
  END IF;
  IF v_delivery_date IS NOT NULL AND v_delivery_date > (now() AT TIME ZONE 'Africa/Lagos')::date THEN
    RAISE EXCEPTION 'The delivery date cannot be in the future';
  END IF;

  IF v_purchase_order_id IS NOT NULL THEN
    IF v_po.status NOT IN ('issued','partially_received') THEN RAISE EXCEPTION 'Purchase order is %, not open for receiving', v_po.status; END IF;
    IF v_qty > (v_po.quantity_ordered - v_po.quantity_received) THEN
      RAISE EXCEPTION 'Quantity exceeds the % still outstanding on this purchase order', (v_po.quantity_ordered - v_po.quantity_received);
    END IF;
    v_supplier_id := COALESCE(v_supplier_id, v_po.supplier_id);
    v_purchase_request_id := v_po.purchase_request_id;
    v_unit_cost := COALESCE(v_unit_cost, v_po.unit_cost);
  END IF;

  IF v_purchase_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM production_requests WHERE id = v_purchase_request_id AND factory_id = v_material.factory_id) THEN
      RAISE EXCEPTION 'Purchase request not found for this factory';
    END IF;
  END IF;

  v_number := 'GR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO goods_receipts(factory_id, receipt_number, material_id, quantity, damaged_quantity, unit, unit_cost, supplier_id,
                              purchase_request_id, purchase_order_id, delivery_reference, remarks, submitted_by,
                              bags, pieces_per_bag, loose_pieces, supplier_invoice, batch_number, delivery_date,
                              storage_location, rejection_reason, rejected_disposition, client_ref)
  VALUES (v_material.factory_id, v_number, v_material_id, v_qty, v_damaged, v_material.unit, v_unit_cost, v_supplier_id,
          v_purchase_request_id, v_purchase_order_id, v_delivery_reference, v_remarks, v_uid,
          v_bags, v_ppb, CASE WHEN v_bags IS NULL THEN NULL ELSE v_loose END, v_invoice, v_batch, v_delivery_date,
          COALESCE(v_location, v_material.storage_location), CASE WHEN v_damaged > 0 THEN v_reject_reason END,
          CASE WHEN v_damaged > 0 THEN v_disposition END, v_client)
  RETURNING id INTO v_id;

  PERFORM public.record_workflow_action('goods-receiving', v_id, 'submit', NULL, 'pending_confirmation', v_remarks);
  RETURN jsonb_build_object('id', v_id, 'receipt_number', v_number, 'quantity', v_qty);
END; $function$;

-- ============ 6. Physical counts and opening balances ============
ALTER TABLE public.stock_adjustment_requests
  ADD COLUMN IF NOT EXISTS system_quantity numeric,
  ADD COLUMN IF NOT EXISTS counted_quantity numeric,
  ADD COLUMN IF NOT EXISTS supporting_reference text,
  ADD COLUMN IF NOT EXISTS unit_cost numeric,
  ADD COLUMN IF NOT EXISTS adjustment_kind text,
  -- A count entered in bags keeps the bags, loose pieces and bag size used.
  ADD COLUMN IF NOT EXISTS counted_bags numeric,
  ADD COLUMN IF NOT EXISTS counted_loose numeric,
  ADD COLUMN IF NOT EXISTS counted_pieces_per_bag numeric;

ALTER TABLE public.stock_adjustment_requests DROP CONSTRAINT IF EXISTS stock_adjustment_requests_movement_type_check;
ALTER TABLE public.stock_adjustment_requests ADD CONSTRAINT stock_adjustment_requests_movement_type_check
  CHECK (movement_type IN ('adjusted', 'damaged', 'opening_balance'));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_adjustment_requests_kind_check') THEN
    ALTER TABLE public.stock_adjustment_requests ADD CONSTRAINT stock_adjustment_requests_kind_check CHECK (
      adjustment_kind IS NULL
      OR (adjustment_kind IN ('count', 'opening_balance') AND counted_quantity IS NOT NULL
          AND system_quantity IS NOT NULL AND counted_quantity >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_adjustment_requests_unit_cost_check') THEN
    ALTER TABLE public.stock_adjustment_requests ADD CONSTRAINT stock_adjustment_requests_unit_cost_check
      CHECK (unit_cost IS NULL OR unit_cost >= 0);
  END IF;
END $$;

-- The Store records what it physically counted; the system works out the
-- variance against the stock it holds and raises an ordinary stock
-- adjustment request for it (approve + post by someone else). Nobody types a
-- new balance. An opening balance is the same, once per material, and may
-- carry the unit cost it is valued at. A count that matches is audited, and
-- no request is raised.
CREATE OR REPLACE FUNCTION public.request_stock_count(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material uuid := NULLIF(payload->>'material_id', '')::uuid;
  v_kind text := COALESCE(NULLIF(payload->>'kind', ''), 'count');
  v_counted numeric := NULLIF(payload->>'counted_quantity', '')::numeric;
  v_bags numeric := NULLIF(payload->>'counted_bags', '')::numeric;
  v_loose numeric := NULLIF(payload->>'counted_loose', '')::numeric;
  v_ref text := NULLIF(btrim(COALESCE(payload->>'supporting_reference', '')), '');
  v_reason text := btrim(COALESCE(payload->>'reason', ''));
  v_cost numeric := NULLIF(payload->>'unit_cost', '')::numeric;
  v_ppb numeric := NULLIF(payload->>'counted_pieces_per_bag', '')::numeric;
  v_m raw_materials%ROWTYPE;
  v_pending text;
  v_delta numeric;
  v_res jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_kind NOT IN ('count', 'opening_balance') THEN RAISE EXCEPTION 'Unknown count type %', v_kind; END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = v_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;

  IF v_bags IS NOT NULL OR v_loose IS NOT NULL THEN
    -- Bags of another size (e.g. a second supplier's) can be counted with
    -- their own size; otherwise the specification's.
    v_ppb := COALESCE(v_ppb, v_m.pieces_per_bag);
    IF v_ppb IS NULL THEN RAISE EXCEPTION 'Set pieces per bag for % first', v_m.name; END IF;
    IF v_ppb <= 0 OR v_ppb <> trunc(v_ppb) THEN RAISE EXCEPTION 'Pieces per bag must be a whole number above 0'; END IF;
    v_bags := COALESCE(v_bags, 0);
    v_loose := COALESCE(v_loose, 0);
    IF COALESCE(v_bags, 0) < 0 OR COALESCE(v_loose, 0) < 0
       OR COALESCE(v_bags, 0) <> trunc(COALESCE(v_bags, 0)) OR COALESCE(v_loose, 0) <> trunc(COALESCE(v_loose, 0)) THEN
      RAISE EXCEPTION 'Bags and loose pieces must be whole numbers';
    END IF;
    v_counted := v_bags * v_ppb + v_loose;
  ELSE
    v_ppb := NULL;
  END IF;
  IF v_counted IS NULL OR v_counted < 0 THEN RAISE EXCEPTION 'Enter the quantity physically counted'; END IF;
  IF v_m.is_preform AND v_counted <> trunc(v_counted) THEN RAISE EXCEPTION 'Preforms are counted in whole pieces'; END IF;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Give the count sheet or other supporting reference'; END IF;
  IF v_cost IS NOT NULL AND v_cost < 0 THEN RAISE EXCEPTION 'Unit cost cannot be negative'; END IF;
  IF v_kind = 'count' THEN v_cost := NULL; END IF;

  SELECT reference_number INTO v_pending FROM stock_adjustment_requests
   WHERE material_id = v_material AND adjustment_kind IS NOT NULL AND status IN ('pending_approval', 'approved')
   LIMIT 1;
  IF v_pending IS NOT NULL THEN
    RAISE EXCEPTION 'Count % for % is still awaiting approval -- finish or cancel it first', v_pending, v_m.name;
  END IF;
  IF v_kind = 'opening_balance' AND (
       EXISTS (SELECT 1 FROM raw_material_movements WHERE material_id = v_material AND movement_type = 'opening_balance')
       OR EXISTS (SELECT 1 FROM stock_adjustment_requests WHERE material_id = v_material
                    AND adjustment_kind = 'opening_balance' AND status = 'posted')) THEN
    RAISE EXCEPTION '% already has an opening balance -- record a physical count instead', v_m.name;
  END IF;

  v_delta := v_counted - v_m.current_stock;
  IF v_delta = 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (v_uid, v_m.factory_id, 'stock_count_matched', 'raw_materials', v_material::text,
            jsonb_build_object('counted', v_counted, 'system', v_m.current_stock, 'kind', v_kind, 'counted_bags', v_bags, 'counted_loose', v_loose, 'pieces_per_bag', v_ppb,
                               'supporting_reference', v_ref, 'reason', NULLIF(v_reason, '')));
    RETURN jsonb_build_object('variance', 0, 'request', false, 'system_quantity', v_m.current_stock);
  END IF;

  v_res := public.request_stock_adjustment(jsonb_build_object(
    'entity_type', 'raw_material', 'material_id', v_material, 'quantity_delta', v_delta,
    'movement_type', CASE v_kind WHEN 'opening_balance' THEN 'opening_balance' ELSE 'adjusted' END,
    'reason', v_reason));
  UPDATE stock_adjustment_requests SET
    system_quantity = v_m.current_stock, counted_quantity = v_counted, supporting_reference = v_ref,
    unit_cost = v_cost, adjustment_kind = v_kind,
    counted_bags = v_bags, counted_loose = v_loose, counted_pieces_per_bag = v_ppb
  WHERE id = (v_res->>'id')::uuid;
  RETURN v_res || jsonb_build_object('variance', v_delta, 'request', true, 'system_quantity', v_m.current_stock);
END;
$$;
REVOKE ALL ON FUNCTION public.request_stock_count(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_stock_count(jsonb) TO authenticated;

-- As 20260923190000, plus: a count is posted only if the stock has not moved
-- since it was counted (otherwise the variance is stale -- recount); an
-- opening balance is valued at the cost it was entered with; and the ledger
-- line carries the request's reference instead of the generic
-- 'Posted write-off', so every adjustment traces back to its request.
CREATE OR REPLACE FUNCTION public.post_stock_adjustment(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_before_value numeric; v_unit_cost numeric; v_unit text; v_move_cost numeric;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'posted');

  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, current_value, unit_cost, unit INTO v_before, v_before_value, v_unit_cost, v_unit FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    IF v_req.counted_quantity IS NOT NULL AND v_before <> v_req.system_quantity THEN
      RAISE EXCEPTION 'Stock has moved since this count (% then, % now) -- cancel % and count again',
        v_req.system_quantity, v_before, v_req.reference_number;
    END IF;
    IF v_req.quantity_delta >= 0 THEN
      v_move_cost := COALESCE(v_req.unit_cost, v_unit_cost);
    ELSE
      v_move_cost := public.avg_unit_cost(v_before_value, v_before, v_unit_cost);
    END IF;
    UPDATE raw_materials SET
      current_stock = current_stock + v_req.quantity_delta,
      current_value = v_before_value + v_req.quantity_delta * v_move_cost,
      updated_at = now()
    WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_move_cost,
            COALESCE(v_req.reference_number, 'Posted write-off'),
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  ELSE
    SELECT current_stock, cost_price, unit INTO v_before, v_unit_cost, v_unit FROM products WHERE id = v_req.product_id FOR UPDATE;
    v_move_cost := v_unit_cost;
    UPDATE products SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, v_req.movement_type::movement_type, v_req.quantity_delta,
            COALESCE(v_req.reference_number, 'Posted write-off'),
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  END IF;

  IF v_req.movement_type = 'damaged' THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, material_id, quantity, unit, unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            CASE WHEN v_req.entity_type = 'finished_good' THEN 'STORE' ELSE 'INVENTORY' END,
            p_id::text, v_req.product_id, v_req.material_id, abs(v_req.quantity_delta), v_unit, v_move_cost,
            v_req.reason, v_req.submitted_by, v_uid, 'posted');
  END IF;

  UPDATE stock_adjustment_requests SET status = 'posted', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action(v_module, p_id, 'post', v_req.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'post_stock_adjustment', v_req.entity_type, COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity_delta));
  RETURN jsonb_build_object('posted', true);
END; $function$;

-- ============ 7. Read functions for the page and its reports ============
-- One row per registered preform: stock in pieces, value, and what is
-- pending, held by production and issued since p_since.
CREATE OR REPLACE FUNCTION public.preform_inventory_overview(p_factory uuid, p_since date DEFAULT NULL)
RETURNS TABLE (
  id uuid, material_code text, name text, specification text, unit text, pieces_per_bag numeric,
  current_stock numeric, current_value numeric, avg_unit_cost numeric, last_purchase_cost numeric,
  reorder_level numeric, active boolean, approval_status text, storage_location text,
  production_department text, remarks text, category_id uuid,
  pending_receipt_qty numeric, pending_receipt_count int, awaiting_ack_qty numeric,
  production_held_qty numeric, issued_since_qty numeric, suppliers jsonb,
  last_movement_at timestamptz, last_movement_type text, updated_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._pinv_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT m.id, m.material_code, m.name, m.specification, m.unit, m.pieces_per_bag,
         m.current_stock, m.current_value,
         public.avg_unit_cost(m.current_value, m.current_stock, m.unit_cost),
         (SELECT g.unit_cost FROM goods_receipts g WHERE g.material_id = m.id AND g.status = 'posted'
            AND g.unit_cost IS NOT NULL ORDER BY g.confirmed_at DESC NULLS LAST, g.submitted_at DESC LIMIT 1),
         m.reorder_level, m.active, m.approval_status, m.storage_location, m.production_department, m.remarks,
         m.category_id,
         COALESCE((SELECT SUM(g.accepted_quantity) FROM goods_receipts g
                    WHERE g.material_id = m.id AND g.status = 'pending_confirmation'), 0),
         (SELECT COUNT(*)::int FROM goods_receipts g WHERE g.material_id = m.id AND g.status = 'pending_confirmation'),
         COALESCE((SELECT SUM(i.pieces) FROM preform_issues i WHERE i.material_id = m.id AND i.status = 'issued'), 0),
         COALESCE((SELECT SUM(h.quantity) FROM preform_holdings h WHERE h.material_id = m.id), 0),
         COALESCE((SELECT SUM(i.pieces) FROM preform_issues i WHERE i.material_id = m.id
                     AND i.status IN ('issued', 'accepted')
                     AND (p_since IS NULL OR i.issue_date >= p_since)), 0),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'preferred', ms.is_preferred,
                                                       'active', ms.active, 'pieces_per_bag', ms.pieces_per_bag)
                                       ORDER BY ms.is_preferred DESC, s.name)
                     FROM material_suppliers ms JOIN suppliers s ON s.id = ms.supplier_id
                    WHERE ms.material_id = m.id), '[]'::jsonb),
         lm.created_at, lm.movement_type::text, m.updated_at
    FROM raw_materials m
    LEFT JOIN LATERAL (SELECT mv.created_at, mv.movement_type FROM raw_material_movements mv
                        WHERE mv.material_id = m.id ORDER BY mv.created_at DESC, mv.id DESC LIMIT 1) lm ON true
   WHERE m.factory_id = p_factory AND m.is_preform
   ORDER BY m.name;
END;
$$;
REVOKE ALL ON FUNCTION public.preform_inventory_overview(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_inventory_overview(uuid, date) TO authenticated;

-- Deliveries of preforms, newest first, with supplier, PO, bags and prices.
CREATE OR REPLACE FUNCTION public.preform_receipts(
  p_factory uuid, p_material uuid DEFAULT NULL, p_supplier uuid DEFAULT NULL,
  p_from date DEFAULT NULL, p_to date DEFAULT NULL
) RETURNS TABLE (
  id uuid, receipt_number text, material_id uuid, material_name text, material_code text,
  supplier_id uuid, supplier_name text, po_number text, delivery_reference text, supplier_invoice text,
  batch_number text, delivery_date date, submitted_at timestamptz, confirmed_at timestamptz,
  bags numeric, pieces_per_bag numeric, loose_pieces numeric, quantity numeric, accepted_quantity numeric,
  damaged_quantity numeric, rejection_reason text, rejected_disposition text, unit_cost numeric,
  accepted_value numeric, status text, storage_location text, remarks text,
  submitted_by_name text, confirmed_by_name text, submitted_by uuid
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._pinv_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT g.id, g.receipt_number, g.material_id, m.name, m.material_code, g.supplier_id, s.name, po.po_number,
         g.delivery_reference, g.supplier_invoice, g.batch_number,
         COALESCE(g.delivery_date, (g.submitted_at AT TIME ZONE 'Africa/Lagos')::date), g.submitted_at, g.confirmed_at,
         g.bags, g.pieces_per_bag, g.loose_pieces, g.quantity, g.accepted_quantity, g.damaged_quantity,
         g.rejection_reason, g.rejected_disposition, g.unit_cost, g.accepted_quantity * COALESCE(g.unit_cost, 0),
         g.status::text, g.storage_location, g.remarks, ps.full_name, pc.full_name, g.submitted_by
    FROM goods_receipts g
    JOIN raw_materials m ON m.id = g.material_id AND m.is_preform
    LEFT JOIN suppliers s ON s.id = g.supplier_id
    LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id
    LEFT JOIN profiles ps ON ps.id = g.submitted_by
    LEFT JOIN profiles pc ON pc.id = g.confirmed_by
   WHERE g.factory_id = p_factory
     AND (p_material IS NULL OR g.material_id = p_material)
     AND (p_supplier IS NULL OR g.supplier_id = p_supplier)
     AND (p_from IS NULL OR COALESCE(g.delivery_date, (g.submitted_at AT TIME ZONE 'Africa/Lagos')::date) >= p_from)
     AND (p_to IS NULL OR COALESCE(g.delivery_date, (g.submitted_at AT TIME ZONE 'Africa/Lagos')::date) <= p_to)
   ORDER BY g.submitted_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.preform_receipts(uuid, uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_receipts(uuid, uuid, uuid, date, date) TO authenticated;

-- A preform's store ledger: every posted movement with who and, for
-- receipts, which supplier. Quantities are signed (+ in, - out).
CREATE OR REPLACE FUNCTION public.preform_material_ledger(p_material uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
  id uuid, created_at timestamptz, movement_type text, quantity numeric, quantity_before numeric,
  quantity_after numeric, unit_cost numeric, reference text, reason text, user_name text, supplier_name text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._pinv_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT mv.id, mv.created_at, mv.movement_type::text,
         CASE WHEN mv.quantity_before IS NOT NULL AND mv.quantity_after IS NOT NULL
              THEN mv.quantity_after - mv.quantity_before ELSE mv.quantity END,
         mv.quantity_before, mv.quantity_after, mv.unit_cost, mv.reference, mv.reason, p.full_name, s.name
    FROM raw_material_movements mv
    LEFT JOIN profiles p ON p.id = mv.user_id
    LEFT JOIN goods_receipts g ON g.receipt_number = mv.reference AND g.material_id = mv.material_id
    LEFT JOIN suppliers s ON s.id = g.supplier_id
   WHERE mv.material_id = p_material
     AND (p_from IS NULL OR (mv.created_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
     AND (p_to IS NULL OR (mv.created_at AT TIME ZONE 'Africa/Lagos')::date <= p_to)
   ORDER BY mv.created_at DESC, mv.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.preform_material_ledger(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_material_ledger(uuid, date, date) TO authenticated;

-- Counts, opening balances and other adjustments of preforms, any status.
CREATE OR REPLACE FUNCTION public.preform_adjustments(p_factory uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
  id uuid, reference_number text, material_id uuid, material_name text, adjustment_kind text,
  movement_type text, system_quantity numeric, counted_quantity numeric, quantity_delta numeric,
  unit_cost numeric, reason text, supporting_reference text, status text,
  submitted_at timestamptz, submitted_by_name text, reviewed_at timestamptz, reviewed_by_name text,
  submitted_by uuid, counted_bags numeric, counted_loose numeric, counted_pieces_per_bag numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._pinv_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT a.id, a.reference_number, a.material_id, m.name, a.adjustment_kind, a.movement_type,
         a.system_quantity, a.counted_quantity, a.quantity_delta, a.unit_cost, a.reason, a.supporting_reference,
         a.status::text, a.submitted_at, ps.full_name, a.reviewed_at, pr.full_name, a.submitted_by,
         a.counted_bags, a.counted_loose, a.counted_pieces_per_bag
    FROM stock_adjustment_requests a
    JOIN raw_materials m ON m.id = a.material_id AND m.is_preform
    LEFT JOIN profiles ps ON ps.id = a.submitted_by
    LEFT JOIN profiles pr ON pr.id = a.reviewed_by
   WHERE a.factory_id = p_factory
     AND (p_from IS NULL OR (a.submitted_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
     AND (p_to IS NULL OR (a.submitted_at AT TIME ZONE 'Africa/Lagos')::date <= p_to)
   ORDER BY a.submitted_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.preform_adjustments(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_adjustments(uuid, date, date) TO authenticated;

-- ============ 8. Reconciliation ============
-- Finds what needs a person to look at it. Never changes anything: a
-- difference is fixed by a physical count (request_stock_count), a
-- reversal, or a reviewed migration -- not by this function.
--   negative_balance          stock or a ledger line below zero
--   ledger_mismatch           last ledger balance <> stock held
--   ledger_gap                a line's "before" <> the previous line's "after"
--   ambiguous_movement        a line without before/after quantities
--   missing_reference         a line with no reference
--   duplicate_receipt_posting the same receipt posted more than once
--   receipt_without_movement  a posted receipt with no ledger line
--   issue_without_movement    a preform issue with no store ledger line
--   duplicate_material        two materials with the same name
--   missing_bag_factor        a preform with no pieces per bag
--   factor_changed            receipts / issues made with another bag size
--   unit_not_pieces           a preform whose unit is not pieces
--   supplier_looks_like_material  a supplier named like a material
--   stale_pending_receipt     a delivery awaiting the Store for 3+ days
CREATE OR REPLACE FUNCTION public.inventory_reconciliation(p_factory uuid, p_preforms_only boolean DEFAULT true)
RETURNS TABLE (
  check_code text, severity text, material_id uuid, material_name text,
  reference text, detail text, expected numeric, actual numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._pinv_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH mats AS (
    SELECT m.* FROM raw_materials m
     WHERE m.factory_id = p_factory AND (NOT p_preforms_only OR m.is_preform)
  ), mv AS (
    -- Lines posted in one transaction share created_at, so their order is
    -- unknown: the checks below accept any order among tied lines.
    SELECT x.*, max(x.created_at) OVER (PARTITION BY x.material_id) AS last_at
      FROM raw_material_movements x JOIN mats ON mats.id = x.material_id
  ), latest AS (
    SELECT mv.material_id, bool_or(mv.quantity_after = m.current_stock) AS any_match,
           max(mv.quantity_after) AS last_after, min(mv.reference) AS ref
      FROM mv JOIN mats m ON m.id = mv.material_id
     WHERE mv.created_at = mv.last_at AND mv.quantity_after IS NOT NULL
     GROUP BY mv.material_id
  ), gaps AS (
    SELECT l.*, m.opening_stock,
           EXISTS (SELECT 1 FROM mv e WHERE e.material_id = l.material_id AND e.id <> l.id
                     AND e.created_at <= l.created_at) AS has_earlier,
           EXISTS (SELECT 1 FROM mv e WHERE e.material_id = l.material_id AND e.id <> l.id
                     AND e.created_at <= l.created_at AND e.quantity_after = l.quantity_before) AS continues
      FROM mv l JOIN mats m ON m.id = l.material_id
     WHERE l.quantity_before IS NOT NULL
  )
  SELECT 'negative_balance', 'error', m.id, m.name, NULL::text,
         'Stock is below zero', 0::numeric, m.current_stock
    FROM mats m WHERE m.current_stock < 0
  UNION ALL
  SELECT 'negative_balance', 'error', mv.material_id, m.name, mv.reference,
         'Ledger line left a negative balance (' || mv.movement_type || ')', 0::numeric, mv.quantity_after
    FROM mv JOIN mats m ON m.id = mv.material_id WHERE mv.quantity_after < 0
  UNION ALL
  SELECT 'ledger_mismatch', 'error', m.id, m.name, lt.ref,
         'Stock held differs from the last ledger balance', lt.last_after, m.current_stock
    FROM mats m JOIN latest lt ON lt.material_id = m.id
   WHERE NOT lt.any_match
  UNION ALL
  SELECT 'ledger_mismatch', 'error', m.id, m.name, NULL,
         'Stock held but no ledger lines (differs from opening stock)', m.opening_stock, m.current_stock
    FROM mats m
   WHERE NOT EXISTS (SELECT 1 FROM raw_material_movements x WHERE x.material_id = m.id)
     AND m.current_stock <> m.opening_stock
  UNION ALL
  SELECT 'ledger_gap', 'warning', g.material_id, m.name, g.reference,
         CASE WHEN g.has_earlier THEN 'Line starts from a balance no earlier line ended at'
              ELSE 'First ledger line does not start from zero or the opening stock' END,
         NULL::numeric, g.quantity_before
    FROM gaps g JOIN mats m ON m.id = g.material_id
   WHERE (g.has_earlier AND NOT g.continues)
      OR (NOT g.has_earlier AND g.quantity_before NOT IN (0, g.opening_stock))
  UNION ALL
  SELECT 'ambiguous_movement', 'warning', mv.material_id, m.name, mv.reference,
         'Ledger line has no before/after balance (' || mv.movement_type || ', ' || mv.quantity || ')', NULL::numeric, mv.quantity
    FROM mv JOIN mats m ON m.id = mv.material_id
   WHERE mv.quantity_before IS NULL OR mv.quantity_after IS NULL
  UNION ALL
  SELECT 'missing_reference', 'warning', mv.material_id, m.name, NULL,
         'Ledger line with no reference (' || mv.movement_type || ' on ' || to_char(mv.created_at, 'YYYY-MM-DD') || ')',
         NULL::numeric, mv.quantity
    FROM mv JOIN mats m ON m.id = mv.material_id
   WHERE NULLIF(btrim(COALESCE(mv.reference, '')), '') IS NULL
  UNION ALL
  SELECT 'duplicate_receipt_posting', 'error', d.material_id, m.name, d.reference,
         'Receipt posted ' || d.n || ' times', 1::numeric, d.n::numeric
    FROM (SELECT x.material_id, x.reference, COUNT(*) AS n FROM mv x
           WHERE x.movement_type = 'received' AND x.reference IS NOT NULL
           GROUP BY 1, 2 HAVING COUNT(*) > 1) d
    JOIN mats m ON m.id = d.material_id
  UNION ALL
  SELECT 'receipt_without_movement', 'error', g.material_id, m.name, g.receipt_number,
         'Posted receipt has no ledger line', g.accepted_quantity, 0::numeric
    FROM goods_receipts g JOIN mats m ON m.id = g.material_id
   WHERE g.status = 'posted' AND g.accepted_quantity > 0
     AND NOT EXISTS (SELECT 1 FROM raw_material_movements x
                      WHERE x.material_id = g.material_id AND x.reference = g.receipt_number)
  UNION ALL
  SELECT 'issue_without_movement', 'error', i.material_id, m.name, i.reference,
         'Preform issue has no store ledger line', i.pieces, 0::numeric
    FROM preform_issues i JOIN mats m ON m.id = i.material_id
   WHERE NOT EXISTS (SELECT 1 FROM raw_material_movements x
                      WHERE x.material_id = i.material_id AND x.reference = i.reference)
  UNION ALL
  SELECT 'duplicate_material', 'warning', m.id, m.name, NULL,
         'Same name as ' || o.name || COALESCE(' (' || o.material_code || ')', '') || ' -- review before merging',
         NULL::numeric, NULL::numeric
    FROM mats m JOIN raw_materials o
      ON o.factory_id = m.factory_id AND o.id <> m.id
     AND public._pinv_norm(o.name) = public._pinv_norm(m.name)
     AND COALESCE(o.approval_status, 'approved') <> 'rejected'
   WHERE COALESCE(m.approval_status, 'approved') <> 'rejected'
  UNION ALL
  SELECT 'missing_bag_factor', 'warning', m.id, m.name, NULL,
         'No pieces per bag set -- cannot be received or issued in bags', NULL::numeric, NULL::numeric
    FROM mats m WHERE m.is_preform AND m.pieces_per_bag IS NULL
  UNION ALL
  -- Compared with what a delivery from the same supplier would use now.
  SELECT 'factor_changed', 'info', g.material_id, m.name, g.receipt_number,
         'Received at ' || g.pieces_per_bag || ' pieces per bag; a delivery from this supplier now uses '
           || public.receipt_pieces_per_bag(g.material_id, g.supplier_id),
         public.receipt_pieces_per_bag(g.material_id, g.supplier_id), g.pieces_per_bag
    FROM goods_receipts g JOIN mats m ON m.id = g.material_id
   WHERE g.pieces_per_bag IS NOT NULL
     AND g.pieces_per_bag <> public.receipt_pieces_per_bag(g.material_id, g.supplier_id)
     AND g.status NOT IN ('cancelled', 'rejected')
  UNION ALL
  SELECT 'factor_changed', 'info', i.material_id, m.name, i.reference,
         'Issued at ' || i.pieces_per_bag || ' pieces per bag; the material now uses ' || m.pieces_per_bag,
         m.pieces_per_bag, i.pieces_per_bag
    FROM preform_issues i JOIN mats m ON m.id = i.material_id
   WHERE m.pieces_per_bag IS NOT NULL AND i.pieces_per_bag <> m.pieces_per_bag
  UNION ALL
  SELECT 'unit_not_pieces', 'warning', m.id, m.name, NULL,
         'Preform unit is "' || m.unit || '" -- preform stock should be kept in pieces', NULL::numeric, NULL::numeric
    FROM mats m WHERE m.is_preform AND m.unit !~* '^\s*(piece|pieces|pcs|pc)\s*$'
  UNION ALL
  SELECT 'supplier_looks_like_material', 'warning', NULL::uuid, NULL::text, s.name,
         'Supplier "' || s.name || '" is named like a material -- check whether it is a supplier or a material specification',
         NULL::numeric, NULL::numeric
    FROM suppliers s
   WHERE s.factory_id = p_factory
     AND (s.name ~* '(preform|nylon|film|\mcaps?\M|\d+\s*mm)'
          OR EXISTS (SELECT 1 FROM raw_materials r WHERE r.factory_id = p_factory
                       AND public._pinv_norm(r.name) = public._pinv_norm(s.name)))
  UNION ALL
  SELECT 'stale_pending_receipt', 'info', g.material_id, m.name, g.receipt_number,
         'Delivery awaiting Store confirmation since ' || to_char(g.submitted_at, 'YYYY-MM-DD'),
         NULL::numeric, g.accepted_quantity
    FROM goods_receipts g JOIN mats m ON m.id = g.material_id
   WHERE g.status = 'pending_confirmation' AND g.submitted_at < now() - interval '3 days';
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_reconciliation(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_reconciliation(uuid, boolean) TO authenticated;
