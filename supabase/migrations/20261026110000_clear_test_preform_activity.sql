-- ============================================================================
-- Undo the test preform activity; only preforms on the all-preforms list
-- ----------------------------------------------------------------------------
-- 1. Factory decision (user, 2026-10-26): the preform issues and blowing
--    entered so far (Hana 117 bags, Prima 70 bags, 33,336 blown / 33,264 good
--    bottles) were test data. Undo everything as if it never happened:
--      * PM-stage rejections reversed, bottles back in PM's stock;
--      * issues to PM: not yet received -> cancelled; received -> reversed;
--        either way the bottles return to bottle stock;
--      * good-bottle stockings: sent -> cancelled; accepted -> reversed
--        (the bottles come out of bottle stock);
--      * blowing records: submitted -> reversed, newest first (the preforms
--        return to QC's balance); drafts -> reversed;
--      * open exceptions -> voided;
--      * preform issues: not yet accepted -> cancelled; accepted -> reversed;
--        either way the pieces go back into the Store at their issue cost.
--    The same ledger lines as the manager reversals, each dated as the line
--    it undoes, so every day nets to zero and Process preforms, the reports
--    and the Store-to-PM list are empty. Nothing is deleted: each row keeps
--    its figures, status 'reversed' / 'cancelled' and the reason, and every
--    step is in the audit log.
--    Only what was recorded before 27 Oct 2026 (Nigeria time) is undone, so
--    entries made after this decision are never touched. Safe to run again.
--
-- 2. qc_preform_overview listed every material with a bag size, so Bottle
--    Caps (sold by the carton) showed as preforms. It now lists preforms
--    only (flagged preform or named so) plus anything actually issued or
--    blown as one.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._clear_preform_activity(p_before timestamptz, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_why text := 'Test data cleared: ' || p_reason;
  n_rej int := 0; n_tr int := 0; n_st int := 0; n_sh int := 0; n_is int := 0; n_back numeric := 0;
BEGIN
  -- PM-stage rejections.
  FOR r IN SELECT * FROM bottle_rejections WHERE status = 'posted' AND recorded_at < p_before ORDER BY recorded_at DESC LOOP
    PERFORM public._pf_dept_move(r.factory_id, r.department, r.product_id, r.quantity, 'pm_rejection_reversed',
                                 r.reference, r.transfer_id);
    UPDATE bottle_rejections SET status = 'reversed', reversed_at = now(), reversal_reason = v_why WHERE id = r.id;
    PERFORM public._pf_audit(r.factory_id, 'reverse_bottle_rejection', 'bottle_rejections', r.id, NULL,
                             jsonb_build_object('reason', v_why));
    n_rej := n_rej + 1;
  END LOOP;

  -- Issues to PM.
  FOR r IN SELECT * FROM bottle_transfers
            WHERE status IN ('dispatched', 'received', 'discrepancy') AND sent_at < p_before ORDER BY sent_at DESC LOOP
    IF r.status <> 'dispatched' AND COALESCE(r.quantity_received, 0) > 0 THEN
      PERFORM public._pf_dept_move(r.factory_id, r.to_department, r.product_id, -r.quantity_received,
                                   'transfer_reversed', r.reference, r.id);
    END IF;
    PERFORM public._pf_product_move(r.product_id, r.quantity_sent, 'returned', r.reference, v_why);
    UPDATE preform_exceptions SET status = 'voided', resolved_at = now(), resolution_note = v_why
     WHERE transfer_id = r.id AND status <> 'voided';
    UPDATE bottle_transfers
       SET status = CASE WHEN r.status = 'dispatched' THEN 'cancelled' ELSE 'reversed' END,
           reversed_at = now(), reversal_reason = v_why
     WHERE id = r.id;
    PERFORM public._pf_audit(r.factory_id, 'reverse_bottle_transfer', 'bottle_transfers', r.id, NULL,
                             jsonb_build_object('reason', v_why));
    n_tr := n_tr + 1;
  END LOOP;

  -- Good-bottle stockings.
  FOR r IN SELECT * FROM preform_stockings WHERE status IN ('sent', 'accepted') AND sent_at < p_before ORDER BY sent_at DESC LOOP
    IF r.status = 'accepted' AND COALESCE(r.accepted_qty, 0) > 0 THEN
      PERFORM public._pf_product_move(r.product_id, -r.accepted_qty, 'correction', r.reference, v_why);
    END IF;
    UPDATE preform_stockings
       SET status = CASE WHEN r.status = 'sent' THEN 'cancelled' ELSE 'reversed' END,
           reversed_at = now(), reversal_reason = v_why
     WHERE id = r.id;
    UPDATE preform_exceptions SET status = 'voided', resolved_at = now(), resolution_note = v_why
     WHERE stocking_id = r.id AND status <> 'voided';
    PERFORM public._pf_audit(r.factory_id, 'reverse_preform_stocking', 'preform_stockings', r.id, NULL,
                             jsonb_build_object('reason', v_why));
    n_st := n_st + 1;
  END LOOP;

  -- Blowing records, newest first (later ones were built on earlier ones).
  FOR r IN SELECT * FROM preform_shift_records
            WHERE status <> 'reversed' AND created_at < p_before
            ORDER BY submitted_at DESC NULLS FIRST, created_at DESC LOOP
    IF r.status <> 'draft' THEN
      PERFORM public._pf_undo_usage(r.id, v_why);
    END IF;
    UPDATE preform_exceptions SET status = 'voided', resolved_at = now(), resolution_note = v_why
     WHERE shift_record_id = r.id AND status <> 'voided';
    UPDATE preform_shift_records SET status = 'reversed', reversed_at = now(), reversal_reason = v_why, updated_at = now()
     WHERE id = r.id;
    PERFORM public._pf_audit(r.factory_id, 'reverse_preform_shift', 'preform_shift_records', r.id, NULL,
                             jsonb_build_object('reason', v_why));
    n_sh := n_sh + 1;
  END LOOP;

  -- Any exception still open.
  UPDATE preform_exceptions SET status = 'voided', resolved_at = now(), resolution_note = v_why
   WHERE status = 'open' AND raised_at < p_before;

  -- Store issues: the pieces go back into the Store.
  FOR r IN SELECT * FROM preform_issues WHERE status IN ('issued', 'accepted') AND issued_at < p_before ORDER BY issued_at DESC LOOP
    IF r.status = 'accepted' THEN
      PERFORM public._pf_move(r.factory_id, r.operator_id, r.material_id, 'issue_reversed', -r.pieces, r.issue_date,
                              r.reference, r.id, NULL, v_why);
    END IF;
    PERFORM public._pf_store_back(r.material_id, r.pieces, r.unit_cost, r.reference, v_why);
    UPDATE preform_issues
       SET status = CASE WHEN r.status = 'issued' THEN 'cancelled' ELSE 'reversed' END,
           shift_record_id = NULL, reversed_at = now(), reversal_reason = v_why
     WHERE id = r.id;
    PERFORM public._pf_audit(r.factory_id, 'reverse_preform_issue', 'preform_issues', r.id, NULL,
                             jsonb_build_object('reason', v_why, 'pieces_back_to_store', r.pieces));
    n_is := n_is + 1;
    n_back := n_back + r.pieces;
  END LOOP;

  RETURN format('Undone: %s PM rejection(s), %s issue(s) to PM, %s stocking(s), %s blowing record(s), %s Store issue(s) (%s pieces back in the Store).',
                n_rej, n_tr, n_st, n_sh, n_is, n_back);
END;
$$;
REVOKE ALL ON FUNCTION public._clear_preform_activity(timestamptz, text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  RAISE NOTICE '%', public._clear_preform_activity('2026-10-27 00:00:00+01', 'test entries (factory decision 2026-10-26)');
END $$;

-- ---------- 2. Preforms only on the all-preforms list ----------
-- As 20261024010000, without "has a bag size" (Bottle Caps have one).
CREATE OR REPLACE FUNCTION public.qc_preform_overview(p_factory uuid)
RETURNS TABLE(
  material_id uuid, material text, brand text, grammage text, supplier text,
  pieces_per_bag numeric, in_store numeric, issued numeric, waiting numeric, received numeric,
  blown numeric, damages numeric, good numeric, qc_holds numeric, last_issue date
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH iss AS (
    SELECT i.material_id,
           SUM(i.pieces) FILTER (WHERE i.status IN ('issued', 'accepted')) AS issued,
           SUM(i.pieces) FILTER (WHERE i.status = 'issued') AS waiting,
           SUM(i.pieces) FILTER (WHERE i.status = 'accepted') AS received,
           MAX(i.issue_date) FILTER (WHERE i.status IN ('issued', 'accepted')) AS last_issue
      FROM preform_issues i WHERE i.factory_id = p_factory GROUP BY i.material_id
  ), blw AS (
    SELECT r.material_id,
           SUM(r.good_bottles + r.damaged_preforms + r.damaged_bottles + r.other_losses) AS blown,
           SUM(r.damaged_preforms + r.damaged_bottles + r.other_losses) AS damages
      FROM preform_shift_records r
     WHERE r.factory_id = p_factory AND r.status NOT IN ('draft', 'reversed')
     GROUP BY r.material_id
  ), held AS (
    SELECT mv.material_id, SUM(mv.quantity) AS qc_holds
      FROM preform_movements mv WHERE mv.factory_id = p_factory GROUP BY mv.material_id
  )
  SELECT m.id, m.name, b.name, b.grammage, s.name, m.pieces_per_bag, m.current_stock,
         COALESCE(iss.issued, 0), COALESCE(iss.waiting, 0), COALESCE(iss.received, 0),
         COALESCE(blw.blown, 0), COALESCE(blw.damages, 0),
         COALESCE(blw.blown, 0) - COALESCE(blw.damages, 0),
         COALESCE(held.qc_holds, 0), iss.last_issue
    FROM raw_materials m
    LEFT JOIN brands b ON b.id = m.brand_id
    LEFT JOIN suppliers s ON s.id = COALESCE(m.supplier_id, b.supplier_id)
    LEFT JOIN iss ON iss.material_id = m.id
    LEFT JOIN blw ON blw.material_id = m.id
    LEFT JOIN held ON held.material_id = m.id
   WHERE m.factory_id = p_factory
     AND (m.is_preform OR m.name ILIKE '%preform%' OR b.name ILIKE '%preform%'
          OR iss.material_id IS NOT NULL OR blw.material_id IS NOT NULL)
   ORDER BY m.name;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_preform_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_preform_overview(uuid) TO authenticated;
