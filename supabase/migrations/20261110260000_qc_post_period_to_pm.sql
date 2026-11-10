-- ============================================================================
-- QC posts the jugs of a period to the PM
-- ----------------------------------------------------------------------------
-- User (2026-11-10): after picking From and To on Collect & post to PM, QC
-- must be able to send every jug of that period in one posting, not only the
-- first day's.
-- qc_post_jugs_to_pm gains p_to: entries that came to QC from p_day to p_to
-- (Lagos day of accepted_at) are posted; the rest stay with QC. p_to NULL =
-- p_day only (as 20261110220000); both NULL = every day. Otherwise unchanged.
-- ============================================================================

DROP FUNCTION IF EXISTS public.qc_post_jugs_to_pm(uuid, numeric, text, numeric, date);
CREATE OR REPLACE FUNCTION public.qc_post_jugs_to_pm(p_factory uuid, p_damaged numeric DEFAULT 0,
                                                    p_damage_reason text DEFAULT NULL,
                                                    p_good numeric DEFAULT NULL,
                                                    p_day date DEFAULT NULL,
                                                    p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_damage_reason, '')), '');
  v_damaged numeric := COALESCE(p_damaged, 0);
  v_good numeric;
  v_total numeric;
  v_take_all numeric;
  v_take numeric;
  v_dmg numeric;
  v_left_dmg numeric;
  v_rest numeric;
  v_ref text;
  v_rest_ref text;
  v_n int := 0;
  v_i int;
  b record;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Only Quality Control posts jugs to the PM';
  END IF;
  IF p_factory IS NULL OR NOT public._works_in_factory(v_uid, p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_damaged < 0 OR v_damaged <> trunc(v_damaged) THEN RAISE EXCEPTION 'Enter the whole number of damaged jugs'; END IF;
  IF v_damaged > 0 AND v_reason IS NULL THEN RAISE EXCEPTION 'Record what is wrong with the damaged jugs'; END IF;
  IF p_to < p_day THEN RAISE EXCEPTION 'The To date is before the From date'; END IF;

  -- Everything QC holds, locked so two postings can't take the same jugs.
  PERFORM 1 FROM qc_jug_batches WHERE factory_id = p_factory AND status = 'accepted' FOR UPDATE;
  -- Only the entries of the days chosen (p_day to p_to), or every day when none.
  SELECT COALESCE(SUM(quantity_accepted), 0) INTO v_total
    FROM qc_jug_batches WHERE factory_id = p_factory AND status = 'accepted'
     AND (p_day IS NULL OR public._jug_day(accepted_at) BETWEEN p_day AND COALESCE(p_to, p_day));
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'There are no jugs with QC to post%',
      CASE WHEN p_day IS NULL THEN '' WHEN COALESCE(p_to, p_day) = p_day THEN ' for ' || to_char(p_day, 'DD Mon YYYY')
           ELSE ' from ' || to_char(p_day, 'DD Mon YYYY') || ' to ' || to_char(p_to, 'DD Mon YYYY') END;
  END IF;

  v_good := COALESCE(p_good, v_total - v_damaged);
  IF v_good < 0 OR v_good <> trunc(v_good) THEN RAISE EXCEPTION 'Enter the whole number of good jugs to send'; END IF;
  IF v_good + v_damaged <= 0 THEN RAISE EXCEPTION 'Enter the good jugs to send to the PM'; END IF;
  IF v_good + v_damaged > v_total THEN
    RAISE EXCEPTION 'Good (%) + damaged (%) is more than the % jugs with QC',
      trim_scale(v_good), trim_scale(v_damaged), trim_scale(v_total);
  END IF;

  v_ref := 'QPM-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-'
           || lpad((floor(random() * 99999))::int::text, 5, '0');
  v_take_all := v_good + v_damaged;
  v_left_dmg := v_damaged;
  FOR b IN SELECT * FROM qc_jug_batches
            WHERE factory_id = p_factory AND status = 'accepted'
              AND (p_day IS NULL OR public._jug_day(accepted_at) BETWEEN p_day AND COALESCE(p_to, p_day))
            ORDER BY accepted_at, reference LOOP
    EXIT WHEN v_take_all <= 0;
    v_take := LEAST(v_take_all, b.quantity_accepted);
    v_rest := b.quantity_accepted - v_take;
    v_take_all := v_take_all - v_take;
    v_dmg := LEAST(v_left_dmg, v_take);
    v_left_dmg := v_left_dmg - v_dmg;

    IF v_rest > 0 THEN
      -- The rest stays with QC: same sender, its own reference.
      v_i := 1;
      LOOP
        v_rest_ref := b.reference || '-R' || v_i;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM qc_jug_batches WHERE reference = v_rest_ref);
        v_i := v_i + 1;
      END LOOP;
      INSERT INTO qc_jug_batches (factory_id, reference, jug_kind, quantity_sent, send_notes, sent_by, sent_at,
                                  status, quantity_accepted, accept_note, accepted_by, accepted_at,
                                  collected, from_type, from_id)
      VALUES (b.factory_id, v_rest_ref, b.jug_kind, v_rest, b.send_notes, b.sent_by, b.sent_at,
              'accepted', v_rest, concat_ws(' · ', b.accept_note, 'Not yet posted from ' || b.reference),
              b.accepted_by, b.accepted_at,
              -- Already at QC on the ledger: the trigger must not move them in again.
              true, b.from_type, b.from_id);
      UPDATE qc_jug_batches SET quantity_accepted = v_take WHERE id = b.id;
    END IF;

    UPDATE qc_jug_batches
       SET status = 'verified', quantity_good = v_take - v_dmg, quantity_damaged = v_dmg,
           damage_reason = CASE WHEN v_dmg > 0 THEN v_reason END,
           verified_by = v_uid, verified_at = now(), pm_posting = v_ref
     WHERE id = b.id;
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, p_factory, 'qc_post_jugs_to_pm', 'qc_jug_batches', v_ref,
          jsonb_build_object('day', p_day, 'to', p_to, 'with_qc', v_total, 'good', v_good, 'damaged', v_damaged,
                             'kept_at_qc', v_total - v_good - v_damaged, 'reason', v_reason,
                             'consignments', v_n));
  RETURN jsonb_build_object('reference', v_ref, 'total', v_good + v_damaged, 'good', v_good,
                            'damaged', v_damaged, 'kept', v_total - v_good - v_damaged,
                            'consignments', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_post_jugs_to_pm(uuid, numeric, text, numeric, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_post_jugs_to_pm(uuid, numeric, text, numeric, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
