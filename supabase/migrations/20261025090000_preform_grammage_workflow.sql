-- ============================================================================
-- Preform → blown bottle → PM: sessions, PM-stage rejection, grammage reports
-- ----------------------------------------------------------------------------
-- Builds on 20261020130000_preform_production_workflow.sql and the QC
-- blowing route (20261022100000). Nothing there is replaced; this closes the
-- gaps found against the factory's preform-to-PM brief (2026-10-25):
--
--   1. Several blowing sessions in one shift. The one-record-per-operator /
--      preform / date / shift index refused a second session (e.g. 12 g in
--      the morning, 12 g again after a machine change). It is dropped; a
--      client reference (one per form opened) now stops a retried or
--      double-clicked save from posting twice. Each session keeps its own
--      record, opening / received / available snapshot and ledger lines.
--
--   2. PM-stage bottle rejection. Bottles PM finds defective after receiving
--      them are recorded against the PM receipt (the transfer) with a reason
--      and an optional production batch reference: bottle_rejections. They
--      leave PM's department stock (department_stock_movements 'pm_rejected')
--      and go nowhere else -- never back to good-bottle stock and never into
--      the preform-stage damage, which stays on the blowing record.
--      A manager may reverse a rejection (stock back to PM, original kept).
--      A transfer with posted rejections cannot be reversed until they are.
--
--   3. The PM issue form also records the quantity requested, the shift and
--      the production reference. Sending more than was requested is refused.
--
--   4. Reports (read-only, from the posted records and ledgers):
--      preform_grammage_report   one row per blowing session, per preform
--                                specification (grammage, supplier, brand,
--                                bottle capacity) -- never aggregated
--      bottle_stock_report       per bottle product: opening, good bottles in
--                                from blowing, issued to PM, other movements,
--                                closing, PM-stage rejections
--      bottle_source_breakdown   good bottles in, by bottle product AND the
--                                preform grammage they were blown from
--      preform_record_trace      drill-down: one session's issues, ledger
--                                lines, QC, stocking, exceptions, and the PM
--                                issues of that bottle type from that day
--
-- Calculations (per session, from the snapshot taken at submission):
--   available        = opening + accepted Store issues it took up
--   processed        = good + blowing damage (preforms + bottles) + other
--   closing          = available - processed           (unprocessed preforms)
--   ledger variance  = processed - the session's posted ledger outflow
--                      (0 when the record and the ledger agree)
--   stock variance   = QC-good - stocked - waiting to stock - exceptions
--                      (0 once every good bottle is in bottle stock)
-- ============================================================================

-- ============ 1. Several sessions per shift, posted once ============
DROP INDEX IF EXISTS public.preform_shift_one_per_shift;
ALTER TABLE public.preform_shift_records ADD COLUMN IF NOT EXISTS client_ref uuid;
CREATE UNIQUE INDEX IF NOT EXISTS preform_shift_records_client_ref
  ON public.preform_shift_records (client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_preform_shift_session
  ON public.preform_shift_records (operator_id, material_id, production_date, shift);
CREATE INDEX IF NOT EXISTS idx_preform_issues_record ON public.preform_issues (shift_record_id);
CREATE INDEX IF NOT EXISTS idx_preform_movements_record ON public.preform_movements (shift_record_id);

-- As 20261020130000, plus client_ref: a save repeated with the same client
-- reference returns the record it already made (duplicate = true) instead of
-- making another; if that record is no longer a draft nothing is changed.
CREATE OR REPLACE FUNCTION public.save_preform_shift(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid := NULLIF(payload->>'id', '')::uuid;
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_operator uuid := COALESCE(NULLIF(payload->>'operator_id', '')::uuid, auth.uid());
  v_material uuid := (payload->>'material_id')::uuid;
  v_date date := (payload->>'production_date')::date;
  v_shift text := payload->>'shift';
  v_good numeric := COALESCE(NULLIF(payload->>'good_bottles', '')::numeric, 0);
  v_dp numeric := COALESCE(NULLIF(payload->>'damaged_preforms', '')::numeric, 0);
  v_db numeric := COALESCE(NULLIF(payload->>'damaged_bottles', '')::numeric, 0);
  v_ol numeric := COALESCE(NULLIF(payload->>'other_losses', '')::numeric, 0);
  v_m raw_materials%ROWTYPE;
  v_row preform_shift_records%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('create') OR public._pf_can('edit')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_operator <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'You can only record your own shifts';
  END IF;

  IF v_client IS NOT NULL THEN
    SELECT * INTO v_row FROM preform_shift_records WHERE client_ref = v_client;
    IF FOUND THEN
      IF v_row.status <> 'draft' THEN
        RETURN jsonb_build_object('id', v_row.id, 'reference', v_row.reference, 'status', v_row.status, 'duplicate', true);
      END IF;
      v_id := v_row.id;
    END IF;
  END IF;

  IF v_shift NOT IN ('day', 'night') THEN RAISE EXCEPTION 'Pick the shift (day or night)'; END IF;
  IF v_date IS NULL OR v_date > public._pf_today() THEN RAISE EXCEPTION 'Pick a production date that is not in the future'; END IF;
  IF least(v_good, v_dp, v_db, v_ol) < 0 THEN RAISE EXCEPTION 'Quantities cannot be negative'; END IF;
  IF v_good <> trunc(v_good) OR v_dp <> trunc(v_dp) OR v_db <> trunc(v_db) OR v_ol <> trunc(v_ol) THEN
    RAISE EXCEPTION 'Quantities are whole pieces';
  END IF;
  IF v_ol > 0 AND NULLIF(btrim(COALESCE(payload->>'other_loss_reason', '')), '') IS NULL THEN
    RAISE EXCEPTION 'Say what the other losses were';
  END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = v_material;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preform material not found'; END IF;

  IF v_id IS NULL THEN
    INSERT INTO preform_shift_records(factory_id, reference, client_ref, operator_id, material_id, output_product_id,
                                      production_date, shift, machine, good_bottles, damaged_preforms, damaged_bottles,
                                      other_losses, other_loss_reason, notes, created_by)
    VALUES (v_m.factory_id, public._pf_ref('PSR'), v_client, v_operator, v_material, v_m.output_product_id, v_date,
            v_shift, NULLIF(btrim(COALESCE(payload->>'machine', '')), ''), v_good, v_dp, v_db, v_ol,
            NULLIF(btrim(COALESCE(payload->>'other_loss_reason', '')), ''),
            NULLIF(btrim(COALESCE(payload->>'notes', '')), ''), auth.uid())
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row FROM preform_shift_records WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shift record not found'; END IF;
    IF v_row.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft can be edited (this record is %)', replace(v_row.status, '_', ' '); END IF;
    IF v_row.operator_id <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
      RAISE EXCEPTION 'You can only edit your own shift records';
    END IF;
    UPDATE preform_shift_records SET
      material_id = v_material, output_product_id = v_m.output_product_id, production_date = v_date, shift = v_shift,
      machine = NULLIF(btrim(COALESCE(payload->>'machine', '')), ''),
      good_bottles = v_good, damaged_preforms = v_dp, damaged_bottles = v_db, other_losses = v_ol,
      other_loss_reason = NULLIF(btrim(COALESCE(payload->>'other_loss_reason', '')), ''),
      notes = NULLIF(btrim(COALESCE(payload->>'notes', '')), ''),
      client_ref = COALESCE(client_ref, v_client), updated_at = now()
     WHERE id = v_id
    RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('id', v_row.id, 'reference', v_row.reference, 'status', v_row.status);
EXCEPTION WHEN unique_violation THEN
  -- Two saves with the same client reference raced: hand back the winner.
  SELECT * INTO v_row FROM preform_shift_records WHERE client_ref = v_client;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_row.id, 'reference', v_row.reference, 'status', v_row.status, 'duplicate', true);
  END IF;
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.save_preform_shift(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_preform_shift(jsonb) TO authenticated;

-- ============ 2. PM issue: requested quantity, shift, production reference ============
ALTER TABLE public.bottle_transfers
  ADD COLUMN IF NOT EXISTS quantity_requested numeric CHECK (quantity_requested IS NULL OR quantity_requested > 0),
  ADD COLUMN IF NOT EXISTS shift text CHECK (shift IS NULL OR shift IN ('day', 'night')),
  ADD COLUMN IF NOT EXISTS production_reference text;

-- As 20261022090000, plus quantity_requested / shift / production_reference.
CREATE OR REPLACE FUNCTION public.dispatch_bottle_transfer(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_product uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_req numeric := NULLIF(payload->>'quantity_requested', '')::numeric;
  v_shift text := NULLIF(payload->>'shift', '');
  v_prod_ref text := NULLIF(btrim(COALESCE(payload->>'production_reference', '')), '');
  v_dept text := NULLIF(btrim(COALESCE(payload->>'to_department', '')), '');
  v_p products%ROWTYPE;
  v_ref text;
  v_id uuid;
  v_existing bottle_transfers%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('post') OR public._pf_can('confirm')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM bottle_transfers WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the receiving department'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole quantity above 0'; END IF;
  IF v_req IS NOT NULL AND (v_req <= 0 OR v_req <> trunc(v_req)) THEN
    RAISE EXCEPTION 'The quantity requested is a whole number above 0';
  END IF;
  IF v_req IS NOT NULL AND v_qty > v_req THEN
    RAISE EXCEPTION 'You are issuing % but only % were requested', v_qty, v_req;
  END IF;
  IF v_shift IS NOT NULL AND v_shift NOT IN ('day', 'night') THEN RAISE EXCEPTION 'Pick the shift (day or night)'; END IF;
  SELECT * INTO v_p FROM products WHERE id = v_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

  v_ref := public._pf_ref('BTR');
  PERFORM public._pf_product_move(v_product, -v_qty, 'transferred', v_ref, 'Transfer to ' || v_dept);
  INSERT INTO bottle_transfers(factory_id, reference, client_ref, product_id, to_department, quantity_sent,
                               quantity_requested, shift, production_reference, notes, sent_by)
  VALUES (v_p.factory_id, v_ref, v_client, v_product, v_dept, v_qty, v_req, v_shift, v_prod_ref,
          NULLIF(btrim(COALESCE(payload->>'notes', '')), ''), auth.uid())
  RETURNING id INTO v_id;
  PERFORM public._pf_audit(v_p.factory_id, 'dispatch_bottle_transfer', 'bottle_transfers', v_id, NULL,
                           jsonb_build_object('reference', v_ref, 'to', v_dept, 'quantity', v_qty,
                                              'requested', v_req, 'shift', v_shift, 'production_reference', v_prod_ref));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_bottle_transfer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_bottle_transfer(jsonb) TO authenticated;

-- ============ 3. PM-stage bottle rejection ============
ALTER TABLE public.department_stock_movements DROP CONSTRAINT IF EXISTS department_stock_movements_movement_type_check;
ALTER TABLE public.department_stock_movements ADD CONSTRAINT department_stock_movements_movement_type_check
  CHECK (movement_type IN ('transfer_in', 'transfer_reversed', 'pm_rejected', 'pm_rejection_reversed'));

CREATE TABLE IF NOT EXISTS public.bottle_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  client_ref uuid UNIQUE,
  transfer_id uuid NOT NULL REFERENCES public.bottle_transfers(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  department text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0 AND quantity = trunc(quantity)),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  production_reference text,
  production_date date NOT NULL,
  shift text CHECK (shift IS NULL OR shift IN ('day', 'night')),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  recorded_by uuid REFERENCES auth.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  reversed_by uuid REFERENCES auth.users(id),
  reversed_at timestamptz,
  reversal_reason text
);
CREATE INDEX IF NOT EXISTS idx_bottle_rejections_transfer ON public.bottle_rejections (transfer_id, status);
CREATE INDEX IF NOT EXISTS idx_bottle_rejections_factory ON public.bottle_rejections (factory_id, production_date DESC);

GRANT SELECT ON public.bottle_rejections TO authenticated;
GRANT ALL ON public.bottle_rejections TO service_role;
ALTER TABLE public.bottle_rejections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "preform read" ON public.bottle_rejections;
CREATE POLICY "preform read" ON public.bottle_rejections FOR SELECT TO authenticated USING (public._pf_can('view'));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                  AND tablename = 'bottle_rejections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bottle_rejections;
  END IF;
END $$;

-- PM records bottles found defective after receiving them. Who: the PM
-- receiving right (preform-production submit), not the person who issued the
-- bottles. At most what that receipt brought in, less what is already
-- rejected on it, and never more than PM still holds.
CREATE OR REPLACE FUNCTION public.record_bottle_rejection(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_transfer uuid := (payload->>'transfer_id')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_prod_ref text := NULLIF(btrim(COALESCE(payload->>'production_reference', '')), '');
  v_date date := COALESCE(NULLIF(payload->>'production_date', '')::date, public._pf_today());
  v_shift text := NULLIF(payload->>'shift', '');
  v_t bottle_transfers%ROWTYPE;
  v_existing bottle_rejections%ROWTYPE;
  v_already numeric;
  v_ref text;
  v_id uuid;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM bottle_rejections WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  SELECT * INTO v_t FROM bottle_transfers WHERE id = v_transfer FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PM receipt not found'; END IF;
  IF NOT public._works_in_factory(auth.uid(), v_t.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_t.status NOT IN ('received', 'discrepancy') THEN
    RAISE EXCEPTION 'Bottles can be rejected only after PM has received them (this issue is %)', v_t.status;
  END IF;
  IF v_t.sent_by = auth.uid() AND NOT public._pf_is_admin() THEN
    RAISE EXCEPTION 'The person who issued the bottles cannot record PM''s rejection of them';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole number of bottles above 0'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why the bottles are rejected'; END IF;
  IF v_shift IS NOT NULL AND v_shift NOT IN ('day', 'night') THEN RAISE EXCEPTION 'Pick the shift (day or night)'; END IF;
  IF v_date > public._pf_today() THEN RAISE EXCEPTION 'The date cannot be in the future'; END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO v_already FROM bottle_rejections WHERE transfer_id = v_transfer AND status = 'posted';
  IF v_qty > COALESCE(v_t.quantity_received, 0) - v_already THEN
    RAISE EXCEPTION 'PM received % on %; % already rejected, so at most % more can be rejected',
      COALESCE(v_t.quantity_received, 0), v_t.reference, v_already, COALESCE(v_t.quantity_received, 0) - v_already;
  END IF;

  v_ref := public._pf_ref('BRJ');
  PERFORM public._pf_dept_move(v_t.factory_id, v_t.to_department, v_t.product_id, -v_qty, 'pm_rejected', v_ref, v_transfer);
  INSERT INTO bottle_rejections(factory_id, reference, client_ref, transfer_id, product_id, department, quantity, reason,
                                production_reference, production_date, shift, recorded_by)
  VALUES (v_t.factory_id, v_ref, v_client, v_transfer, v_t.product_id, v_t.to_department, v_qty, v_reason, v_prod_ref,
          v_date, v_shift, auth.uid())
  RETURNING id INTO v_id;
  PERFORM public._pf_audit(v_t.factory_id, 'record_bottle_rejection', 'bottle_rejections', v_id, NULL,
    jsonb_build_object('reference', v_ref, 'transfer', v_t.reference, 'quantity', v_qty, 'reason', v_reason,
                       'production_reference', v_prod_ref));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref, 'quantity', v_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.record_bottle_rejection(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_bottle_rejection(jsonb) TO authenticated;

-- A manager corrects a rejection recorded in error: the bottles return to
-- PM's stock; the rejection stays on record as reversed, with the reason.
CREATE OR REPLACE FUNCTION public.reverse_bottle_rejection(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r bottle_rejections%ROWTYPE;
BEGIN
  IF NOT public._pf_can('reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_r FROM bottle_rejections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rejection not found'; END IF;
  IF v_r.status <> 'posted' THEN RAISE EXCEPTION 'This rejection has already been reversed'; END IF;
  PERFORM public._pf_dept_move(v_r.factory_id, v_r.department, v_r.product_id, v_r.quantity, 'pm_rejection_reversed',
                               v_r.reference, v_r.transfer_id);
  UPDATE bottle_rejections SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._pf_audit(v_r.factory_id, 'reverse_bottle_rejection', 'bottle_rejections', p_id, NULL,
                           jsonb_build_object('reason', p_reason, 'quantity', v_r.quantity));
  RETURN jsonb_build_object('id', p_id, 'status', 'reversed');
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_bottle_rejection(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_bottle_rejection(uuid, text) TO authenticated;

-- As 20261020130000, but a transfer PM has rejected bottles from must have
-- those rejections reversed first (otherwise reversing would take other
-- bottles out of PM's stock in their place).
CREATE OR REPLACE FUNCTION public.reverse_bottle_transfer(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_t bottle_transfers%ROWTYPE;
BEGIN
  IF NOT public._pf_can('reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_t FROM bottle_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_t.status NOT IN ('received', 'discrepancy') THEN RAISE EXCEPTION 'Only a received transfer can be reversed'; END IF;
  IF EXISTS (SELECT 1 FROM preform_exceptions WHERE transfer_id = p_id AND status = 'resolved') THEN
    RAISE EXCEPTION 'The shortfall on this transfer has already been resolved; it can no longer be reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM bottle_rejections WHERE transfer_id = p_id AND status = 'posted') THEN
    RAISE EXCEPTION 'PM has rejected bottles from this transfer. Reverse those rejections first.';
  END IF;
  IF COALESCE(v_t.quantity_received, 0) > 0 THEN
    PERFORM public._pf_dept_move(v_t.factory_id, v_t.to_department, v_t.product_id, -v_t.quantity_received,
                                 'transfer_reversed', v_t.reference, p_id);
  END IF;
  PERFORM public._pf_product_move(v_t.product_id, v_t.quantity_sent, 'returned', v_t.reference, 'Transfer reversed: ' || p_reason);
  UPDATE preform_exceptions SET status = 'voided', resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = 'Transfer reversed: ' || p_reason
   WHERE transfer_id = p_id AND status = 'open';
  UPDATE bottle_transfers SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._pf_audit(v_t.factory_id, 'reverse_bottle_transfer', 'bottle_transfers', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'reversed');
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_bottle_transfer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_bottle_transfer(uuid, text) TO authenticated;

-- ============ 4. Specification helpers ============
-- Bottle capacity from a bottle product's name: "50cl Bottle Water" → 50cl,
-- "Empty Bottle (1.5L)" → 1.5L, "500ml" → 500ml. NULL when the name has none.
CREATE OR REPLACE FUNCTION public._pf_capacity(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN m IS NULL THEN NULL
           WHEN m[2] = 'cl' THEN m[1] || 'cl'
           WHEN m[2] = 'ml' THEN m[1] || 'ml'
           ELSE m[1] || 'L'
         END
    FROM (SELECT regexp_match(lower(COALESCE(p_name, '')), '(\d+(?:\.\d+)?)\s*(cl|ml|ltr|litres?|liters?|l)\M') AS m) x;
$$;
GRANT EXECUTE ON FUNCTION public._pf_capacity(text) TO authenticated;

-- A preform's grammage as written on its brand ("16.5g"), else its weight
-- per piece ("16.5 g"), else NULL.
CREATE OR REPLACE FUNCTION public._pf_grammage(p_material uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(btrim(b.grammage), ''), trim_scale(m.grams_per_piece)::text || ' g')
    FROM raw_materials m LEFT JOIN brands b ON b.id = m.brand_id
   WHERE m.id = p_material;
$$;
REVOKE ALL ON FUNCTION public._pf_grammage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pf_grammage(uuid) TO authenticated;

-- ============ 5. Individual grammage report (one row per blowing session) ============
-- Drafts are not posted and are left out unless asked for (p_status = 'draft').
-- Reversed sessions are returned with their status so the audit trail shows;
-- summaries leave them out.
CREATE OR REPLACE FUNCTION public.preform_grammage_report(
  p_factory uuid, p_from date, p_to date,
  p_shift text DEFAULT NULL, p_material uuid DEFAULT NULL, p_operator uuid DEFAULT NULL,
  p_status text DEFAULT NULL, p_grammage text DEFAULT NULL, p_supplier uuid DEFAULT NULL,
  p_capacity text DEFAULT NULL
) RETURNS TABLE(
  id uuid, reference text, production_date date, shift text, operator_id uuid, operator text,
  material_id uuid, material text, brand text, grammage text, supplier_id uuid, supplier text,
  pieces_per_bag numeric, bottle_product_id uuid, bottle text, capacity text,
  opening_qty numeric, received_bags numeric, received_loose numeric, received_pieces numeric, issue_refs text,
  available_qty numeric, processed numeric, damaged_preforms numeric, damaged_bottles numeric, other_losses numeric,
  good_bottles numeric, qc_rejected numeric, closing_qty numeric, stocked numeric, pending_stock numeric,
  exception_qty numeric, ledger_variance numeric, stock_variance numeric, status text, submitted_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Pick at most a year'; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT r.*, m.name AS m_name, m.pieces_per_bag AS m_ppb, b.name AS b_name,
           public._pf_grammage(m.id) AS gram,
           COALESCE(m.supplier_id, b.supplier_id) AS sup_id,
           p.name AS p_name, public._pf_capacity(p.name) AS cap
      FROM preform_shift_records r
      JOIN raw_materials m ON m.id = r.material_id
      LEFT JOIN brands b ON b.id = m.brand_id
      LEFT JOIN products p ON p.id = r.output_product_id
     WHERE r.factory_id = p_factory AND r.production_date BETWEEN p_from AND p_to
       AND (p_status IS NULL AND r.status <> 'draft' OR r.status = p_status)
       AND (p_shift IS NULL OR r.shift = p_shift)
       AND (p_material IS NULL OR r.material_id = p_material)
       AND (p_operator IS NULL OR r.operator_id = p_operator)
  )
  SELECT x.id, x.reference, x.production_date, x.shift, x.operator_id, public._pf_name(x.operator_id),
         x.material_id, x.m_name, x.b_name, x.gram, x.sup_id, s.name, x.m_ppb, x.output_product_id, x.p_name, x.cap,
         x.opening_qty, COALESCE(iss.bags, 0), COALESCE(iss.loose, 0), x.issued_qty, iss.refs,
         x.available_qty, x.usage_qty, x.damaged_preforms, x.damaged_bottles, x.other_losses,
         x.good_bottles, COALESCE(x.qc_rejected, 0), x.expected_remaining,
         COALESCE(st.accepted, 0), COALESCE(st.pending, 0), COALESCE(ex.qty, 0),
         CASE WHEN x.usage_qty IS NULL OR x.status = 'reversed' THEN NULL ELSE x.usage_qty - COALESCE(mv.out_qty, 0) END,
         CASE WHEN x.qc_good IS NULL OR x.status = 'reversed' THEN NULL
              ELSE x.qc_good - COALESCE(st.accepted, 0) - COALESCE(st.pending, 0) - COALESCE(ex.qty, 0) END,
         x.status, x.submitted_at
    FROM base x
    LEFT JOIN suppliers s ON s.id = x.sup_id
    LEFT JOIN LATERAL (SELECT SUM(i.bags) AS bags, SUM(i.loose_pieces) AS loose,
                              string_agg(i.reference, ', ' ORDER BY i.issued_at) AS refs
                         FROM preform_issues i WHERE i.shift_record_id = x.id) iss ON true
    LEFT JOIN LATERAL (SELECT -SUM(mv.quantity) AS out_qty FROM preform_movements mv
                        WHERE mv.shift_record_id = x.id
                          AND mv.movement_type IN ('good_bottles', 'damaged_preforms', 'damaged_bottles', 'other_losses')) mv ON true
    LEFT JOIN LATERAL (SELECT SUM(st.accepted_qty) FILTER (WHERE st.status = 'accepted') AS accepted,
                              SUM(st.counted_qty) FILTER (WHERE st.status = 'sent') AS pending
                         FROM preform_stockings st WHERE st.shift_record_id = x.id) st ON true
    LEFT JOIN LATERAL (SELECT SUM(e.difference_qty) FILTER (WHERE e.status IN ('open', 'resolved')) AS qty
                         FROM preform_exceptions e WHERE e.shift_record_id = x.id) ex ON true
   WHERE (p_grammage IS NULL OR lower(regexp_replace(COALESCE(x.gram, ''), '\s', '', 'g')) = lower(regexp_replace(p_grammage, '\s', '', 'g')))
     AND (p_supplier IS NULL OR x.sup_id = p_supplier)
     AND (p_capacity IS NULL OR lower(x.cap) = lower(p_capacity))
   ORDER BY x.production_date DESC, x.shift, x.m_name, x.gram, x.submitted_at;
END;
$$;
REVOKE ALL ON FUNCTION public.preform_grammage_report(uuid, date, date, text, uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_grammage_report(uuid, date, date, text, uuid, uuid, text, text, uuid, text) TO authenticated;

-- ============ 6. Bottle inventory report ============
-- Per bottle product, from its stock ledger (inventory_movements), worked
-- back from the current stock so it always agrees with it:
--   from_blowing   good bottles stocked from blowing (net of reversals)
--   issued_to_pm   bottles issued to PM / departments (net of cancellations
--                  and reversals)
--   other          every other posted movement (counts, adjustments, ...)
--   closing        = opening + from_blowing - issued_to_pm + other
-- pm_rejected is PM-stage rejection in the period: it is out of PM's stock,
-- not this one, and is shown for the record only.
CREATE OR REPLACE FUNCTION public.bottle_stock_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(
  product_id uuid, product text, capacity text, opening numeric, from_blowing numeric, issued_to_pm numeric,
  other numeric, closing numeric, current_stock numeric, pm_received numeric, pm_rejected numeric, in_transit numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  RETURN QUERY
  WITH prods AS (
    SELECT p.id, p.name, p.current_stock FROM products p
     WHERE p.factory_id = p_factory
       AND (p.product_type = 'semi_finished'
            OR EXISTS (SELECT 1 FROM preform_stockings s WHERE s.product_id = p.id)
            OR EXISTS (SELECT 1 FROM bottle_transfers t WHERE t.product_id = p.id))
  ), mv AS (
    SELECT im.product_id, (im.created_at AT TIME ZONE 'Africa/Lagos')::date AS d,
           COALESCE(im.quantity_after - im.quantity_before,
                    CASE WHEN im.movement_type::text IN ('received', 'produced', 'returned', 'return_from_rep', 'opening_balance',
                                                         'return_from_production')
                         THEN abs(im.quantity)
                         WHEN im.movement_type::text IN ('adjusted', 'correction') THEN im.quantity
                         ELSE -abs(im.quantity) END) AS q,
           CASE WHEN EXISTS (SELECT 1 FROM preform_stockings s WHERE s.reference = im.reference) THEN 'blow'
                WHEN EXISTS (SELECT 1 FROM bottle_transfers t WHERE t.reference = im.reference) THEN 'pm'
                ELSE 'other' END AS kind
      FROM inventory_movements im JOIN prods ON prods.id = im.product_id
  ), agg AS (
    SELECT prods.id,
           COALESCE(SUM(mv.q) FILTER (WHERE mv.d >= p_from), 0) AS since_from,
           COALESCE(SUM(mv.q) FILTER (WHERE mv.d > p_to), 0) AS after_to,
           COALESCE(SUM(mv.q) FILTER (WHERE mv.d BETWEEN p_from AND p_to AND mv.kind = 'blow'), 0) AS blow,
           COALESCE(-SUM(mv.q) FILTER (WHERE mv.d BETWEEN p_from AND p_to AND mv.kind = 'pm'), 0) AS pm,
           COALESCE(SUM(mv.q) FILTER (WHERE mv.d BETWEEN p_from AND p_to AND mv.kind = 'other'), 0) AS oth
      FROM prods LEFT JOIN mv ON mv.product_id = prods.id
     GROUP BY prods.id
  )
  SELECT p.id, p.name, public._pf_capacity(p.name),
         p.current_stock - a.since_from, a.blow, a.pm, a.oth, p.current_stock - a.after_to, p.current_stock,
         COALESCE((SELECT SUM(t.quantity_received) FROM bottle_transfers t
                    WHERE t.product_id = p.id AND t.status IN ('received', 'discrepancy')
                      AND (t.received_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to), 0),
         COALESCE((SELECT SUM(r.quantity) FROM bottle_rejections r
                    WHERE r.product_id = p.id AND r.status = 'posted' AND r.production_date BETWEEN p_from AND p_to), 0),
         COALESCE((SELECT SUM(t.quantity_sent) FROM bottle_transfers t WHERE t.product_id = p.id AND t.status = 'dispatched'), 0)
    FROM prods p JOIN agg a ON a.id = p.id
   ORDER BY p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.bottle_stock_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bottle_stock_report(uuid, date, date) TO authenticated;

-- Good bottles stocked from blowing, by bottle product and the preform
-- specification they were blown from (accepted stockings, by the day they
-- were stocked). A combined 50cl total never hides the 12 g / 12.5 g / 13 g
-- rows under it.
CREATE OR REPLACE FUNCTION public.bottle_source_breakdown(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(
  product_id uuid, product text, capacity text, material_id uuid, material text, brand text, grammage text,
  supplier text, sessions bigint, good_in_period numeric, good_all_time numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  RETURN QUERY
  SELECT p.id, p.name, public._pf_capacity(p.name), m.id, m.name, b.name, public._pf_grammage(m.id), su.name,
         COUNT(DISTINCT r.id) FILTER (WHERE (COALESCE(s.received_at, s.sent_at) AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to),
         COALESCE(SUM(s.accepted_qty) FILTER (WHERE (COALESCE(s.received_at, s.sent_at) AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to), 0),
         COALESCE(SUM(s.accepted_qty), 0)
    FROM preform_stockings s
    JOIN preform_shift_records r ON r.id = s.shift_record_id
    JOIN products p ON p.id = s.product_id
    JOIN raw_materials m ON m.id = r.material_id
    LEFT JOIN brands b ON b.id = m.brand_id
    LEFT JOIN suppliers su ON su.id = COALESCE(m.supplier_id, b.supplier_id)
   WHERE s.factory_id = p_factory AND s.status = 'accepted'
     AND (COALESCE(s.received_at, s.sent_at) AT TIME ZONE 'Africa/Lagos')::date <= p_to
   GROUP BY p.id, p.name, m.id, m.name, b.name, su.name
   ORDER BY p.name, m.name, 7;
END;
$$;
REVOKE ALL ON FUNCTION public.bottle_source_breakdown(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bottle_source_breakdown(uuid, date, date) TO authenticated;

-- ============ 7. Drill-down ============
-- Everything behind one session: the Store issues it took up, its preform
-- ledger lines (processed and damage), QC, the good-bottle stockings, any
-- exceptions, and -- since bottles of one type are pooled once stocked --
-- the PM issues of that bottle type from its production date on (max 20).
CREATE OR REPLACE FUNCTION public.preform_record_trace(p_record uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r preform_shift_records%ROWTYPE;
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_record;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blowing record not found'; END IF;
  RETURN jsonb_build_object(
    'record', to_jsonb(v_r) || jsonb_build_object(
       'operator', public._pf_name(v_r.operator_id),
       'material', (SELECT name FROM raw_materials WHERE id = v_r.material_id),
       'grammage', public._pf_grammage(v_r.material_id),
       'bottle', (SELECT name FROM products WHERE id = v_r.output_product_id),
       'capacity', (SELECT public._pf_capacity(name) FROM products WHERE id = v_r.output_product_id)),
    'issues', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'reference', i.reference, 'issue_date', i.issue_date, 'bags', i.bags, 'pieces_per_bag', i.pieces_per_bag,
        'loose_pieces', i.loose_pieces, 'pieces', i.pieces, 'status', i.status,
        'issued_by', public._pf_name(i.issued_by), 'received_by', public._pf_name(i.responded_by),
        'responded_at', i.responded_at) ORDER BY i.issued_at)
      FROM preform_issues i WHERE i.shift_record_id = p_record), '[]'::jsonb),
    'movements', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'type', mv.movement_type, 'quantity', mv.quantity, 'before', mv.quantity_before, 'after', mv.quantity_after,
        'reason', mv.reason, 'at', mv.created_at, 'by', public._pf_name(mv.user_id)) ORDER BY mv.created_at)
      FROM preform_movements mv WHERE mv.shift_record_id = p_record), '[]'::jsonb),
    'inspections', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'decision', q.decision, 'good', q.good_qty, 'rejected', q.rejected_qty, 'reason', q.reason, 'notes', q.notes,
        'by', public._pf_name(q.inspector_id), 'at', q.inspected_at) ORDER BY q.inspected_at)
      FROM preform_qc_inspections q WHERE q.shift_record_id = p_record), '[]'::jsonb),
    'stockings', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'reference', s.reference, 'product', p.name, 'counted', s.counted_qty, 'accepted', s.accepted_qty,
        'status', s.status, 'received_by', public._pf_name(s.received_by), 'received_at', s.received_at,
        'reversal_reason', s.reversal_reason) ORDER BY s.sent_at)
      FROM preform_stockings s JOIN products p ON p.id = s.product_id WHERE s.shift_record_id = p_record), '[]'::jsonb),
    'exceptions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'reference', e.reference, 'kind', e.kind, 'difference', e.difference_qty, 'status', e.status,
        'note', e.note, 'resolution_note', e.resolution_note) ORDER BY e.raised_at)
      FROM preform_exceptions e WHERE e.shift_record_id = p_record), '[]'::jsonb),
    'pm_issues', COALESCE((SELECT jsonb_agg(z.pm ORDER BY z.sent_at) FROM (
        SELECT t.sent_at, jsonb_build_object(
          'reference', t.reference, 'to', t.to_department, 'sent', t.quantity_sent, 'received', t.quantity_received,
          'status', t.status, 'sent_at', t.sent_at, 'production_reference', t.production_reference,
          'rejected', (SELECT COALESCE(SUM(r.quantity), 0) FROM bottle_rejections r WHERE r.transfer_id = t.id AND r.status = 'posted')) AS pm
          FROM bottle_transfers t
         WHERE t.product_id = v_r.output_product_id
           AND (t.sent_at AT TIME ZONE 'Africa/Lagos')::date >= v_r.production_date
         ORDER BY t.sent_at LIMIT 20) z), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.preform_record_trace(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_record_trace(uuid) TO authenticated;
