-- ============================================================================
-- QC moves preforms stuck in "Received from Store" onto her blowing stock
-- ----------------------------------------------------------------------------
-- Factory request (user, 2026-10-26): QC must be able to process preforms
-- the Store issued her earlier. Some preform issues to Quality Control are
-- still in QC's general store (Quality Control → Received from Store) and not
-- in her blowing stock (Preforms → Process preforms), so she cannot blow them:
-- the one-time move of 20261023230000 skipped preforms with no pieces per bag
-- or no QC person, and an issue to the department without a person lands
-- there too.
--
-- qc_move_preforms_to_blowing(material, pieces_per_bag?): for one preform,
-- everything of it still in QC's general store goes into the caller's
-- blowing stock, as 20261023230000 did:
--   * issues still awaiting confirmation -- marked 'moved' (moving them is
--     her receipt of them);
--   * confirmed stock not yet used -- leaves the general store as an "out"
--     line "Moved to Quality Control → Preforms (PFI-…)";
-- and together they become one accepted preform issue to her plus its
-- holding-ledger line, dated today. The Store's stock is not touched (it
-- already left). Nothing can be moved twice: the lines are locked and what
-- moved no longer counts in the general store.
--
-- Who: a Quality Control person who may record blowing (preform-production
-- submit), working in that factory. A preform with no pieces per bag takes
-- the bag size given here the first time (audited), as QC may at receiving.
-- ============================================================================

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
  IF NOT (v_m.is_preform OR v_m.name ILIKE '%preform%') THEN
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
  SELECT COALESCE(SUM(quantity), 0) INTO v_used FROM qc_store_usage WHERE material_id = p_material;
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
