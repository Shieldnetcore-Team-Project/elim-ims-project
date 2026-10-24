-- ============================================================================
-- Preforms the Store issued to QC: onto Quality Control → Preforms
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-23): every preform the Store issued to
-- Quality Control belongs on the Preforms page (QC's blowing stock), not in
-- the general "Received from Store" store. Since the Preforms tab, Issue
-- Stock sends a preform to a QC person as a preform issue; this moves the
-- ones issued before it. The Store's stock is not touched -- it already left.
--
--   * still awaiting QC's confirmation: becomes a preform issue to that QC
--     person (status 'issued'), for her to Accept / Reject on the Preforms
--     page like any other; the old line is marked 'moved'.
--   * already confirmed: what QC has not used of that preform goes into the
--     QC person's blowing stock at once (an accepted preform issue + its
--     ledger line, dated when it was confirmed), and leaves the general QC
--     store as an "out" line "Moved to Quality Control → Preforms", so it is
--     not counted twice.
--
-- The QC person is whoever it was issued to, else whoever confirmed it, and
-- must be in Quality Control. A preform without pieces per bag, or without a
-- QC person, is left where it is and listed in the notice. Safe to run again.
-- ============================================================================

ALTER TABLE public.qc_store_receipts DROP CONSTRAINT IF EXISTS qc_store_receipts_status_check;
ALTER TABLE public.qc_store_receipts
  ADD CONSTRAINT qc_store_receipts_status_check CHECK (status IN ('pending', 'confirmed', 'rejected', 'moved')),
  ADD COLUMN IF NOT EXISTS moved_to_issue uuid REFERENCES public.preform_issues(id);

CREATE OR REPLACE FUNCTION public._move_qc_preforms_to_blowing()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_op uuid;
  v_ppb numeric;
  v_cost numeric;
  v_ref text;
  v_id uuid;
  v_avail numeric;
  v_moved_pending int := 0;
  v_moved_confirmed int := 0;
  v_skipped text := '';
BEGIN
  -- 1. Awaiting confirmation -> a preform issue for her to accept.
  FOR r IN
    SELECT q.*, m.pieces_per_bag, m.name AS material_name, mv.unit_cost AS mv_cost
      FROM qc_store_receipts q
      JOIN raw_materials m ON m.id = q.material_id
      LEFT JOIN raw_material_movements mv ON mv.id = q.movement_id
     WHERE q.status = 'pending' AND (m.is_preform OR m.name ILIKE '%preform%')
     ORDER BY q.issued_at
  LOOP
    v_op := r.issued_to_user;
    v_ppb := r.pieces_per_bag;
    IF v_op IS NULL OR NOT public._issue_department_member(v_op, 'quality_control') OR v_ppb IS NULL OR v_ppb <= 0 THEN
      v_skipped := v_skipped || format(' %s (%s pcs, %s);', r.material_name, r.quantity,
                     CASE WHEN v_ppb IS NULL OR v_ppb <= 0 THEN 'set pieces per bag' ELSE 'no QC person' END);
      CONTINUE;
    END IF;
    v_ref := public._pf_ref('PFI');
    INSERT INTO preform_issues(factory_id, reference, material_id, operator_id, bags, pieces_per_bag, loose_pieces, pieces,
                               unit_cost, issue_date, notes, issued_by, issued_at)
    VALUES (r.factory_id, v_ref, r.material_id, v_op, floor(r.quantity / v_ppb), v_ppb, r.quantity - floor(r.quantity / v_ppb) * v_ppb,
            r.quantity, COALESCE(r.mv_cost, 0), (r.issued_at AT TIME ZONE 'Africa/Lagos')::date,
            'Moved from Received from Store', r.issued_by, r.issued_at)
    RETURNING id INTO v_id;
    UPDATE qc_store_receipts SET status = 'moved', moved_to_issue = v_id WHERE id = r.id;
    v_moved_pending := v_moved_pending + 1;
  END LOOP;

  -- 2. Confirmed -> what QC still has of each preform into the blowing stock.
  FOR r IN
    SELECT q.factory_id, q.material_id, m.pieces_per_bag, m.name AS material_name,
           (array_agg(COALESCE(q.issued_to_user, q.confirmed_by) ORDER BY q.confirmed_at DESC))[1] AS op,
           (array_agg(q.issued_by ORDER BY q.confirmed_at DESC))[1] AS issued_by,
           max(q.confirmed_at) AS confirmed_at,
           SUM(q.quantity) AS received,
           (SELECT mv.unit_cost FROM raw_material_movements mv
             WHERE mv.id = (array_agg(q.movement_id ORDER BY q.confirmed_at DESC))[1]) AS cost
      FROM qc_store_receipts q
      JOIN raw_materials m ON m.id = q.material_id
     WHERE q.status = 'confirmed' AND (m.is_preform OR m.name ILIKE '%preform%')
     GROUP BY q.factory_id, q.material_id, m.pieces_per_bag, m.name
  LOOP
    v_avail := r.received - COALESCE((SELECT SUM(u.quantity) FROM qc_store_usage u WHERE u.material_id = r.material_id), 0);
    IF v_avail <= 0 THEN CONTINUE; END IF;
    v_op := r.op;
    v_ppb := r.pieces_per_bag;
    IF v_op IS NULL OR NOT public._issue_department_member(v_op, 'quality_control') OR v_ppb IS NULL OR v_ppb <= 0 THEN
      v_skipped := v_skipped || format(' %s (%s pcs, %s);', r.material_name, v_avail,
                     CASE WHEN v_ppb IS NULL OR v_ppb <= 0 THEN 'set pieces per bag' ELSE 'no QC person' END);
      CONTINUE;
    END IF;
    v_ref := public._pf_ref('PFI');
    INSERT INTO preform_issues(factory_id, reference, material_id, operator_id, bags, pieces_per_bag, loose_pieces, pieces,
                               unit_cost, issue_date, notes, status, issued_by, issued_at, responded_by, responded_at)
    VALUES (r.factory_id, v_ref, r.material_id, v_op, floor(v_avail / v_ppb), v_ppb, v_avail - floor(v_avail / v_ppb) * v_ppb,
            v_avail, COALESCE(r.cost, 0), (r.confirmed_at AT TIME ZONE 'Africa/Lagos')::date,
            'Moved from Received from Store (already confirmed)', 'accepted', r.issued_by, r.confirmed_at, v_op, r.confirmed_at)
    RETURNING id INTO v_id;
    PERFORM public._pf_move(r.factory_id, v_op, r.material_id, 'issue_in', v_avail,
                            (r.confirmed_at AT TIME ZONE 'Africa/Lagos')::date, v_ref, v_id, NULL,
                            'Moved from Received from Store');
    INSERT INTO qc_store_usage(factory_id, material_id, quantity, reason, used_by)
    VALUES (r.factory_id, r.material_id, v_avail, 'Moved to Quality Control → Preforms (' || v_ref || ')', v_op);
    v_moved_confirmed := v_moved_confirmed + 1;
  END LOOP;

  RETURN format('Moved to Preforms: %s awaiting acceptance, %s already confirmed.%s',
                v_moved_pending, v_moved_confirmed,
                CASE WHEN v_skipped = '' THEN '' ELSE ' Left in Received from Store:' || v_skipped END);
END;
$$;
REVOKE ALL ON FUNCTION public._move_qc_preforms_to_blowing() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._move_qc_preforms_to_blowing();
END $$;
