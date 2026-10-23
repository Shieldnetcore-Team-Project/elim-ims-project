-- ============================================================================
-- Quality Control's own store: confirm what the Store issues, record use
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-23): stock the Store issues to Quality Control
-- (Store → Issue Stock → Quality Control) only counts as QC's stock once QC
-- confirms receiving it. QC then records what it uses (out). Quality Control
-- → Received from Store shows what is awaiting confirmation, received, out
-- and available, per material.
--
--   qc_store_receipts  one row per Store issue to Quality Control, made by a
--                      trigger on raw_material_movements; pending until QC
--                      confirms it (qc_confirm_store_receipt).
--   qc_store_usage     what QC used (qc_record_store_usage); never more than
--                      QC has available of that material.
--   available          = confirmed received - used, per material.
--
-- Who: confirming and recording use take goods-receiving submit (the QC
-- officer) in the material's factory; reading takes goods-receiving or
-- raw-materials read. Issues made before this are listed as awaiting
-- confirmation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.qc_store_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  movement_id uuid NOT NULL UNIQUE REFERENCES public.raw_material_movements(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,
  quantity numeric NOT NULL CHECK (quantity > 0),
  issued_to_user uuid REFERENCES auth.users(id),
  issued_by uuid REFERENCES auth.users(id),
  issued_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz
);
CREATE INDEX IF NOT EXISTS qc_store_receipts_factory_idx ON public.qc_store_receipts (factory_id, status, issued_at);
CREATE INDEX IF NOT EXISTS qc_store_receipts_material_idx ON public.qc_store_receipts (material_id);

CREATE TABLE IF NOT EXISTS public.qc_store_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.raw_materials(id) ON DELETE CASCADE,
  quantity numeric NOT NULL CHECK (quantity > 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  used_by uuid REFERENCES auth.users(id),
  used_at timestamptz NOT NULL DEFAULT now(),
  client_ref uuid UNIQUE
);
CREATE INDEX IF NOT EXISTS qc_store_usage_factory_idx ON public.qc_store_usage (factory_id, used_at);
CREATE INDEX IF NOT EXISTS qc_store_usage_material_idx ON public.qc_store_usage (material_id);

-- Read only; every change goes through the functions below.
ALTER TABLE public.qc_store_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qc_store_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qc store receipts read" ON public.qc_store_receipts;
CREATE POLICY "qc store receipts read" ON public.qc_store_receipts FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'read'::action_key)
         OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'read'::action_key));
DROP POLICY IF EXISTS "qc store usage read" ON public.qc_store_usage;
CREATE POLICY "qc store usage read" ON public.qc_store_usage FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'read'::action_key)
         OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'read'::action_key));
REVOKE ALL ON public.qc_store_receipts, public.qc_store_usage FROM anon, authenticated;
GRANT SELECT ON public.qc_store_receipts, public.qc_store_usage TO authenticated;
GRANT ALL ON public.qc_store_receipts, public.qc_store_usage TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND tablename = 'qc_store_receipts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.qc_store_receipts;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND tablename = 'qc_store_usage') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.qc_store_usage;
  END IF;
END $$;

-- ---------- Every Store issue to Quality Control awaits QC's confirmation ----------
CREATE OR REPLACE FUNCTION public._qc_store_receipt_from_issue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.issued_to_department = 'quality_control' THEN
    INSERT INTO qc_store_receipts(factory_id, movement_id, material_id, quantity, issued_to_user, issued_by, issued_at)
    VALUES (NEW.factory_id, NEW.id, NEW.material_id, abs(NEW.quantity), NEW.issued_to_user, NEW.user_id, NEW.created_at)
    ON CONFLICT (movement_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS raw_material_movements_qc_store ON public.raw_material_movements;
CREATE TRIGGER raw_material_movements_qc_store AFTER INSERT ON public.raw_material_movements
  FOR EACH ROW EXECUTE FUNCTION public._qc_store_receipt_from_issue();

-- Issues made before this: awaiting confirmation like any new one.
INSERT INTO public.qc_store_receipts(factory_id, movement_id, material_id, quantity, issued_to_user, issued_by, issued_at)
SELECT mv.factory_id, mv.id, mv.material_id, abs(mv.quantity), mv.issued_to_user, mv.user_id, mv.created_at
  FROM public.raw_material_movements mv
 WHERE mv.issued_to_department = 'quality_control' AND mv.quantity <> 0
ON CONFLICT (movement_id) DO NOTHING;

-- ---------- QC confirms receiving an issue ----------
CREATE OR REPLACE FUNCTION public.qc_confirm_store_receipt(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_r qc_store_receipts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_r FROM qc_store_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles ur
                  WHERE ur.user_id = v_uid AND (ur.factory_id IS NULL OR ur.factory_id = v_r.factory_id)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_r.status = 'confirmed' THEN
    RETURN jsonb_build_object('id', p_id, 'confirmed', true, 'already', true);
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

-- ---------- QC records what it used ----------
-- payload: material_id, quantity (pieces), reason, client_ref (a double
-- click records once).
CREATE OR REPLACE FUNCTION public.qc_record_store_usage(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material uuid := NULLIF(payload->>'material_id', '')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_reason text := btrim(COALESCE(payload->>'reason', ''));
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_m raw_materials%ROWTYPE;
  v_available numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_client IS NOT NULL THEN
    SELECT id INTO v_id FROM qc_store_usage WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_id, 'duplicate', true); END IF;
  END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = v_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles ur
                  WHERE ur.user_id = v_uid AND (ur.factory_id IS NULL OR ur.factory_id = v_m.factory_id)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'Say what it was used for'; END IF;

  v_available := COALESCE((SELECT SUM(quantity) FROM qc_store_receipts
                            WHERE material_id = v_material AND status = 'confirmed'), 0)
               - COALESCE((SELECT SUM(quantity) FROM qc_store_usage WHERE material_id = v_material), 0);
  IF v_qty > v_available THEN
    RAISE EXCEPTION 'Only % % of % available in Quality Control', v_available, v_m.unit, v_m.name;
  END IF;

  INSERT INTO qc_store_usage(factory_id, material_id, quantity, reason, used_by, client_ref)
  VALUES (v_m.factory_id, v_material, v_qty, v_reason, v_uid, v_client)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_m.factory_id, 'qc_record_store_usage', 'qc_store_usage', v_id::text,
          jsonb_build_object('material_id', v_material, 'quantity', v_qty, 'reason', v_reason,
                             'available_after', v_available - v_qty));
  RETURN jsonb_build_object('id', v_id, 'available', v_available - v_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_record_store_usage(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_record_store_usage(jsonb) TO authenticated;
