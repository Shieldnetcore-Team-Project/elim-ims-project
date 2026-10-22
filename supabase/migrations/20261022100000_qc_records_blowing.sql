-- ============================================================================
-- QC records the blowing and stocks the good bottles herself
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-22): Quality Control is in charge of blowing
-- preforms. Nobody sends bottles to QC. She records the shift (preforms used,
-- good bottles, damage), separates good from damaged once, and the good
-- bottles go straight into stock; she then sends them to production (PM),
-- which confirms receipt (20261022090000). Damaged preforms and bottles are
-- recorded for the record only: they leave her preform holding as usage and
-- go nowhere else.
--
-- How:
--   * qc_officer gains preform-production create / edit / submit (the
--     operator's rights): the Store can issue preforms to her, she accepts
--     them and records and submits her shifts.
--   * submit_preform_shift: when the shift's operator may stock bottles in
--     (preform-production confirm -- QC), the separation she recorded IS the
--     inspection and the stocking. In the same transaction the record gets an
--     approved QC inspection (all good bottles good, none rejected) and an
--     accepted stocking for the good bottles; the bottle product's stock rises
--     and the record is completed. Nothing waits for a second person.
--   * Anyone else's submission (an operator without confirm) follows the old
--     route unchanged: awaiting inspection -> QC -> stocking -> accept.
--
-- Reversal is unchanged: a manager reverses the stocking (stock comes back
-- out, the record returns to awaiting stocking) and then the shift (usage
-- returns to her holding). Opening, usage and expected-remaining figures,
-- daily reports and reconciliation are all computed exactly as before.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT r.slug, 'preform-production'::module_key, g.action::action_key
FROM public.roles r
CROSS JOIN (VALUES ('create'), ('edit'), ('submit')) AS g(action)
WHERE r.slug = 'qc_officer'
ON CONFLICT (role, module, action) DO NOTHING;

CREATE OR REPLACE FUNCTION public.submit_preform_shift(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r preform_shift_records%ROWTYPE;
  v_held numeric;
  v_issued numeric;
  v_usage numeric;
  v_stock_ref text;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift record not found'; END IF;
  IF v_r.status <> 'draft' THEN RAISE EXCEPTION 'This record has already been submitted'; END IF;
  IF v_r.operator_id <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'You can only submit your own shift records';
  END IF;
  IF v_r.output_product_id IS NULL THEN
    RAISE EXCEPTION 'This preform has no bottle product set up (Quality Control → Good bottles → Setup)';
  END IF;
  v_usage := v_r.good_bottles + v_r.damaged_preforms + v_r.damaged_bottles + v_r.other_losses;
  IF v_usage <= 0 THEN RAISE EXCEPTION 'Enter the good bottles and damage for this shift'; END IF;

  -- Lock the holding so two submissions can't both spend the same preforms.
  INSERT INTO preform_holdings(factory_id, operator_id, material_id, quantity)
  VALUES (v_r.factory_id, v_r.operator_id, v_r.material_id, 0)
  ON CONFLICT (operator_id, material_id) DO NOTHING;
  SELECT quantity INTO v_held FROM preform_holdings
   WHERE operator_id = v_r.operator_id AND material_id = v_r.material_id FOR UPDATE;

  SELECT COALESCE(SUM(pieces), 0) INTO v_issued FROM preform_issues
   WHERE operator_id = v_r.operator_id AND material_id = v_r.material_id
     AND status = 'accepted' AND shift_record_id IS NULL;

  IF v_usage > v_held THEN
    RAISE EXCEPTION 'Usage of % pieces is more than the % pieces available (opening % + received %). Short by % pieces.',
      v_usage, v_held, v_held - v_issued, v_issued, v_usage - v_held;
  END IF;

  UPDATE preform_issues SET shift_record_id = p_id
   WHERE operator_id = v_r.operator_id AND material_id = v_r.material_id
     AND status = 'accepted' AND shift_record_id IS NULL;

  PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'good_bottles', -v_r.good_bottles,
                          v_r.production_date, v_r.reference, NULL, p_id, 'Blown into good bottles');
  PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'damaged_preforms', -v_r.damaged_preforms,
                          v_r.production_date, v_r.reference, NULL, p_id, 'Damaged preforms');
  PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'damaged_bottles', -v_r.damaged_bottles,
                          v_r.production_date, v_r.reference, NULL, p_id, 'Damaged during blowing');
  PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'other_losses', -v_r.other_losses,
                          v_r.production_date, v_r.reference, NULL, p_id, COALESCE(v_r.other_loss_reason, 'Other loss'));

  UPDATE preform_shift_records SET
    status = 'awaiting_inspection', opening_qty = v_held - v_issued, issued_qty = v_issued, available_qty = v_held,
    usage_qty = v_usage, expected_remaining = v_held - v_usage,
    submitted_by = auth.uid(), submitted_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public._pf_audit(v_r.factory_id, 'submit_preform_shift', 'preform_shift_records', p_id, NULL,
    jsonb_build_object('available', v_held, 'usage', v_usage, 'remaining', v_held - v_usage));

  -- QC blew these bottles herself (she may stock bottles in): her good /
  -- damaged separation is the inspection, and the good bottles go straight
  -- into stock. The damage stays recorded on the shift only.
  IF public.has_permission(v_r.operator_id, 'preform-production'::module_key, 'confirm'::action_key) THEN
    INSERT INTO preform_qc_inspections(factory_id, shift_record_id, decision, inspected_qty, good_qty, rejected_qty,
                                       notes, inspector_id)
    VALUES (v_r.factory_id, p_id, 'approved', v_r.good_bottles, v_r.good_bottles, 0,
            'Separated and stocked by QC when the shift was recorded', auth.uid());
    IF v_r.good_bottles > 0 THEN
      v_stock_ref := public._pf_ref('PGS');
      INSERT INTO preform_stockings(factory_id, reference, shift_record_id, product_id, destination, expected_qty,
                                    counted_qty, received_qty, accepted_qty, status, sent_by, received_by, received_at,
                                    send_note)
      VALUES (v_r.factory_id, v_stock_ref, p_id, v_r.output_product_id, 'Quality Control', v_r.good_bottles,
              v_r.good_bottles, v_r.good_bottles, v_r.good_bottles, 'accepted', auth.uid(), auth.uid(), now(),
              'Stocked by QC from her own shift record');
      PERFORM public._pf_product_move(v_r.output_product_id, v_r.good_bottles, 'produced', v_stock_ref,
                                      'Good bottles from ' || v_r.reference || ' (' || v_r.shift || ' shift ' || v_r.production_date || ')');
    END IF;
    UPDATE preform_shift_records SET qc_good = v_r.good_bottles, qc_rejected = 0, status = 'completed',
           completed_at = now(), updated_at = now()
     WHERE id = p_id;
    PERFORM public._pf_audit(v_r.factory_id, 'qc_stock_preform_shift', 'preform_shift_records', p_id, NULL,
      jsonb_build_object('good_stocked', v_r.good_bottles, 'stocking', v_stock_ref,
                         'damaged_preforms', v_r.damaged_preforms, 'damaged_bottles', v_r.damaged_bottles,
                         'other_losses', v_r.other_losses));
    RETURN jsonb_build_object('id', p_id, 'status', 'completed', 'stocked', v_r.good_bottles, 'stocking', v_stock_ref,
                              'available', v_held, 'usage', v_usage, 'expected_remaining', v_held - v_usage);
  END IF;

  RETURN jsonb_build_object('id', p_id, 'status', 'awaiting_inspection', 'available', v_held, 'usage', v_usage,
                            'expected_remaining', v_held - v_usage);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_preform_shift(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_preform_shift(uuid) TO authenticated;
