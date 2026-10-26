-- ============================================================================
-- Clear the test data from QC's lists and from "Received from Store"
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-26), following
-- 20261026110000_clear_test_preform_activity.sql:
--
-- 1. The rows that clean-up reversed (preform issues, blowing records,
--    stockings, issues to PM, PM rejections, exceptions -- reason "Test data
--    cleared: …") still showed as "Reversed" in the lists. They are flagged
--    test_cleared and every list and report leaves them out. They are not
--    deleted: the database and the audit log keep them.
--
-- 2. The preforms the Store issued to Quality Control's general store
--    (Quality Control → Received from Store) before 27 Oct 2026 were test
--    data too (preforms: flagged so, or "preform" in the material or brand
--    name). They are reversed back into the Store -- but only what never
--    went through Preforms: the lines that were moved to Preforms (by
--    20261023230000 or Move to Preforms) were already returned to the Store
--    when those preform issues were reversed, and are not returned twice.
--    Per preform:
--        back to the Store = issued to QC (confirmed or awaiting)
--                            - moved to Preforms on a now-cleared issue
--    at the cost they were issued at. Their receipts become 'cleared' (no
--    longer QC's stock or awaiting her), and those lines plus QC's use / issue-
--    to-Production lines for them are flagged test_cleared, so the page is
--    empty and nothing counts in QC's available stock. Safe to run again.
--
-- 3. Move to Preforms also accepts a preform known by its brand ("Sentric",
--    brand "Preform · 27gr"). QC's availability (Record use, Issue to Production, Move to Preforms)
--    and the blowing reports ignore cleared lines from now on.
-- ============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['preform_issues', 'preform_shift_records', 'preform_stockings', 'bottle_transfers',
                           'bottle_rejections', 'preform_exceptions', 'qc_store_receipts', 'qc_store_usage'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS test_cleared boolean NOT NULL DEFAULT false', t);
  END LOOP;
END $$;

ALTER TABLE public.qc_store_receipts DROP CONSTRAINT IF EXISTS qc_store_receipts_status_check;
ALTER TABLE public.qc_store_receipts ADD CONSTRAINT qc_store_receipts_status_check
  CHECK (status IN ('pending', 'confirmed', 'rejected', 'moved', 'cleared'));

-- ---------- 1. Flag what the first clean-up reversed ----------
UPDATE public.preform_issues SET test_cleared = true WHERE reversal_reason LIKE 'Test data cleared:%';
UPDATE public.preform_shift_records SET test_cleared = true WHERE reversal_reason LIKE 'Test data cleared:%';
UPDATE public.preform_stockings SET test_cleared = true WHERE reversal_reason LIKE 'Test data cleared:%';
UPDATE public.bottle_transfers SET test_cleared = true WHERE reversal_reason LIKE 'Test data cleared:%';
UPDATE public.bottle_rejections SET test_cleared = true WHERE reversal_reason LIKE 'Test data cleared:%';
UPDATE public.preform_exceptions SET test_cleared = true WHERE resolution_note LIKE 'Test data cleared:%';

-- ---------- 2. Received from Store ----------
CREATE OR REPLACE FUNCTION public._clear_qc_store_preforms(p_before timestamptz, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_why text := 'Test data cleared: ' || p_reason;
  v_moved numeric;
  v_back numeric;
  v_cost numeric;
  v_lines int := 0;
  v_total numeric := 0;
  v_note text := '';
BEGIN
  FOR r IN
    SELECT q.material_id, m.name, SUM(q.quantity) AS issued
      FROM qc_store_receipts q JOIN raw_materials m ON m.id = q.material_id
      LEFT JOIN brands b ON b.id = m.brand_id
     WHERE q.status IN ('confirmed', 'pending') AND q.issued_at < p_before
       AND (m.is_preform OR m.name ILIKE '%preform%' OR b.name ILIKE '%preform%')
     GROUP BY q.material_id, m.name
  LOOP
    -- Moved to Preforms on an issue the first clean-up already took back.
    SELECT COALESCE(SUM(u.quantity), 0) INTO v_moved
      FROM qc_store_usage u
     WHERE u.material_id = r.material_id AND NOT u.test_cleared
       AND EXISTS (SELECT 1 FROM preform_issues pi
                    WHERE pi.material_id = r.material_id AND pi.test_cleared
                      AND u.reason LIKE '%(' || pi.reference || ')');
    v_back := GREATEST(r.issued - v_moved, 0);
    SELECT COALESCE(SUM(mv.unit_cost * q.quantity) / NULLIF(SUM(q.quantity), 0), 0) INTO v_cost
      FROM qc_store_receipts q JOIN raw_material_movements mv ON mv.id = q.movement_id
     WHERE q.material_id = r.material_id AND q.status IN ('confirmed', 'pending') AND q.issued_at < p_before;
    IF v_back > 0 THEN
      PERFORM public._pf_store_back(r.material_id, v_back, v_cost, 'QC store cleared', v_why);
    END IF;
    UPDATE qc_store_receipts SET status = 'cleared', test_cleared = true
     WHERE material_id = r.material_id AND status IN ('confirmed', 'pending') AND issued_at < p_before;
    UPDATE qc_store_usage SET test_cleared = true WHERE material_id = r.material_id AND used_at < p_before;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    SELECT auth.uid(), m.factory_id, 'clear_qc_store_preform', 'raw_materials', m.id::text,
           jsonb_build_object('reason', v_why, 'issued_to_qc', r.issued, 'already_back_via_preforms', v_moved,
                              'returned_to_store', v_back)
      FROM raw_materials m WHERE m.id = r.material_id;
    v_lines := v_lines + 1;
    v_total := v_total + v_back;
    v_note := v_note || format(' %s: %s back;', r.name, trim_scale(v_back));
  END LOOP;

  -- Lines already moved or rejected: hidden too.
  UPDATE qc_store_receipts q SET test_cleared = true
    FROM raw_materials m LEFT JOIN brands b ON b.id = m.brand_id
   WHERE m.id = q.material_id AND q.status IN ('moved', 'rejected') AND q.issued_at < p_before
     AND (m.is_preform OR m.name ILIKE '%preform%' OR b.name ILIKE '%preform%') AND NOT q.test_cleared;

  RETURN format('Received from Store cleared: %s preform(s), %s pieces back in the Store.%s', v_lines, trim_scale(v_total), v_note);
END;
$$;
REVOKE ALL ON FUNCTION public._clear_qc_store_preforms(timestamptz, text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._clear_qc_store_preforms('2026-10-27 00:00:00+01', 'QC store test entries (factory decision 2026-10-26)');
END $$;

-- ---------- 4. Cleared rows no longer count or show ----------
-- As before, but cleared lines are left out (only the filter is new).
CREATE OR REPLACE FUNCTION public.preform_shift_report(
  p_factory uuid, p_from date, p_to date, p_operator uuid DEFAULT NULL, p_material uuid DEFAULT NULL,
  p_shift text DEFAULT NULL, p_status text DEFAULT NULL
) RETURNS TABLE(
  id uuid, reference text, production_date date, shift text, operator_id uuid, operator text, material text,
  machine text, status text, opening_qty numeric, issued_qty numeric, available_qty numeric, good_bottles numeric,
  damaged_preforms numeric, damaged_bottles numeric, other_losses numeric, usage_qty numeric,
  expected_remaining numeric, qc_good numeric, qc_rejected numeric, stocked numeric, pending_stock numeric,
  exception_qty numeric, variance numeric, open_exceptions bigint, submitted_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT r.id, r.reference, r.production_date, r.shift, r.operator_id, public._pf_name(r.operator_id), m.name,
         r.machine, r.status, r.opening_qty, r.issued_qty, r.available_qty, r.good_bottles, r.damaged_preforms,
         r.damaged_bottles, r.other_losses, r.usage_qty, r.expected_remaining, r.qc_good, r.qc_rejected,
         COALESCE(st.accepted, 0), COALESCE(st.pending, 0), COALESCE(ex.qty, 0),
         CASE WHEN r.qc_good IS NULL THEN NULL ELSE r.qc_good - COALESCE(st.accepted, 0) END,
         COALESCE(ex.open, 0), r.submitted_at
    FROM preform_shift_records r
    JOIN raw_materials m ON m.id = r.material_id
    LEFT JOIN LATERAL (SELECT SUM(s.accepted_qty) FILTER (WHERE s.status = 'accepted') AS accepted,
                              SUM(s.counted_qty) FILTER (WHERE s.status = 'sent') AS pending
                         FROM preform_stockings s WHERE s.shift_record_id = r.id) st ON true
    LEFT JOIN LATERAL (SELECT SUM(e.difference_qty) FILTER (WHERE e.status IN ('open', 'resolved')) AS qty,
                              COUNT(*) FILTER (WHERE e.status = 'open') AS open
                         FROM preform_exceptions e WHERE e.shift_record_id = r.id) ex ON true
   WHERE r.factory_id = p_factory AND r.production_date BETWEEN p_from AND p_to AND NOT r.test_cleared
     AND (p_operator IS NULL OR r.operator_id = p_operator)
     AND (p_material IS NULL OR r.material_id = p_material)
     AND (p_shift IS NULL OR r.shift = p_shift)
     AND (p_status IS NULL OR r.status = p_status)
   ORDER BY r.production_date DESC, r.shift, public._pf_name(r.operator_id);
END;
$$;
REVOKE ALL ON FUNCTION public.preform_shift_report(uuid, date, date, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_shift_report(uuid, date, date, uuid, uuid, text, text) TO authenticated;

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
     WHERE r.factory_id = p_factory AND r.production_date BETWEEN p_from AND p_to AND NOT r.test_cleared
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

CREATE OR REPLACE FUNCTION public.qc_record_store_usage(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material uuid := NULLIF(payload->>'material_id', '')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_reason text := btrim(COALESCE(payload->>'reason', ''));
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_dept text := NULLIF(payload->>'issued_to_department', '');
  v_to_user uuid := NULLIF(payload->>'issued_to_user', '')::uuid;
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

  IF v_dept IS NOT NULL AND v_dept <> 'production' THEN RAISE EXCEPTION 'Quality Control issues to Production only'; END IF;
  IF v_to_user IS NOT NULL THEN
    IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the department the person belongs to'; END IF;
    IF NOT public._issue_department_member(v_to_user, v_dept) THEN RAISE EXCEPTION 'That person is not in Production'; END IF;
  END IF;
  IF v_dept IS NOT NULL THEN
    v_reason := 'Issued to Production'
                || COALESCE(' — ' || (SELECT COALESCE(NULLIF(full_name, ''), email) FROM profiles WHERE id = v_to_user), '')
                || CASE WHEN v_reason = '' THEN '' ELSE ': ' || v_reason END;
  END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'Say what it was used for'; END IF;

  v_available := COALESCE((SELECT SUM(quantity) FROM qc_store_receipts
                            WHERE material_id = v_material AND status = 'confirmed'), 0)
               - COALESCE((SELECT SUM(quantity) FROM qc_store_usage WHERE material_id = v_material AND NOT test_cleared), 0);
  IF v_qty > v_available THEN
    RAISE EXCEPTION 'Only % % of % available in Quality Control', v_available, v_m.unit, v_m.name;
  END IF;

  INSERT INTO qc_store_usage(factory_id, material_id, quantity, reason, used_by, client_ref, issued_to_department, issued_to_user)
  VALUES (v_m.factory_id, v_material, v_qty, v_reason, v_uid, v_client, v_dept, v_to_user)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_m.factory_id, CASE WHEN v_dept IS NULL THEN 'qc_record_store_usage' ELSE 'qc_issue_to_production' END,
          'qc_store_usage', v_id::text,
          jsonb_build_object('material_id', v_material, 'quantity', v_qty, 'reason', v_reason,
                             'issued_to_department', v_dept, 'issued_to_user', v_to_user,
                             'available_after', v_available - v_qty));
  RETURN jsonb_build_object('id', v_id, 'available', v_available - v_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_record_store_usage(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_record_store_usage(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.qc_move_preforms_to_blowing(p_material uuid, p_pieces_per_bag numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_m raw_materials%ROWTYPE;
  v_ppb numeric;
  v_pending numeric;
  v_received numeric;
  v_used numeric;
  v_avail numeric;
  v_total numeric;
  v_cost numeric;
  v_issuer uuid;
  v_ref text;
  v_id uuid;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_m.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT public._issue_department_member(v_uid, 'quality_control') THEN
    RAISE EXCEPTION 'Only a Quality Control person can move preforms into her blowing stock';
  END IF;
  IF NOT (v_m.is_preform OR v_m.name ILIKE '%preform%'
          OR EXISTS (SELECT 1 FROM brands b WHERE b.id = v_m.brand_id AND b.name ILIKE '%preform%')) THEN
    RAISE EXCEPTION '% is not a preform', v_m.name;
  END IF;

  v_ppb := v_m.pieces_per_bag;
  IF v_ppb IS NULL THEN
    IF p_pieces_per_bag IS NULL OR p_pieces_per_bag <= 0 OR p_pieces_per_bag <> trunc(p_pieces_per_bag) THEN
      RAISE EXCEPTION 'Enter the pieces per bag for % first', v_m.name;
    END IF;
    v_ppb := p_pieces_per_bag;
    UPDATE raw_materials SET pieces_per_bag = v_ppb, updated_at = now() WHERE id = p_material;
    PERFORM public._pf_audit(v_m.factory_id, 'set_pieces_per_bag', 'raw_materials', p_material,
      jsonb_build_object('pieces_per_bag', NULL), jsonb_build_object('pieces_per_bag', v_ppb, 'via', 'move to preforms'));
  END IF;

  -- Lock this preform's lines in QC's general store.
  PERFORM 1 FROM qc_store_receipts WHERE material_id = p_material AND status IN ('pending', 'confirmed') FOR UPDATE;
  SELECT COALESCE(SUM(quantity) FILTER (WHERE status = 'pending'), 0),
         COALESCE(SUM(quantity) FILTER (WHERE status = 'confirmed'), 0)
    INTO v_pending, v_received
    FROM qc_store_receipts WHERE material_id = p_material;
  SELECT COALESCE(SUM(quantity), 0) INTO v_used FROM qc_store_usage WHERE material_id = p_material AND NOT test_cleared;
  v_avail := GREATEST(v_received - v_used, 0);
  v_total := v_pending + v_avail;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Nothing of % is left in Received from Store to move', v_m.name;
  END IF;

  SELECT r.issued_by, mv.unit_cost INTO v_issuer, v_cost
    FROM qc_store_receipts r LEFT JOIN raw_material_movements mv ON mv.id = r.movement_id
   WHERE r.material_id = p_material AND r.status IN ('pending', 'confirmed')
   ORDER BY r.issued_at DESC LIMIT 1;

  v_ref := public._pf_ref('PFI');
  INSERT INTO preform_issues(factory_id, reference, material_id, operator_id, bags, pieces_per_bag, loose_pieces, pieces,
                             unit_cost, issue_date, notes, status, issued_by, issued_at, responded_by, responded_at)
  VALUES (v_m.factory_id, v_ref, p_material, v_uid, floor(v_total / v_ppb), v_ppb, v_total - floor(v_total / v_ppb) * v_ppb,
          v_total, COALESCE(v_cost, 0), public._pf_today(), 'Moved from Received from Store', 'accepted',
          COALESCE(v_issuer, v_uid), now(), v_uid, now())
  RETURNING id INTO v_id;
  PERFORM public._pf_move(v_m.factory_id, v_uid, p_material, 'issue_in', v_total, public._pf_today(), v_ref, v_id, NULL,
                          'Moved from Received from Store');

  IF v_pending > 0 THEN
    UPDATE qc_store_receipts SET status = 'moved', moved_to_issue = v_id
     WHERE material_id = p_material AND status = 'pending';
  END IF;
  IF v_avail > 0 THEN
    INSERT INTO qc_store_usage(factory_id, material_id, quantity, reason, used_by)
    VALUES (v_m.factory_id, p_material, v_avail, 'Moved to Quality Control → Preforms (' || v_ref || ')', v_uid);
  END IF;

  PERFORM public._pf_audit(v_m.factory_id, 'qc_move_preforms_to_blowing', 'preform_issues', v_id, NULL,
    jsonb_build_object('reference', v_ref, 'material', v_m.name, 'awaiting_confirmation', v_pending,
                       'confirmed_unused', v_avail, 'pieces', v_total));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref, 'pieces', v_total,
                            'from_pending', v_pending, 'from_confirmed', v_avail);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_move_preforms_to_blowing(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_move_preforms_to_blowing(uuid, numeric) TO authenticated;
