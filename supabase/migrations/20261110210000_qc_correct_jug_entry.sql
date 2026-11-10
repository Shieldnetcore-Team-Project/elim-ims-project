-- ============================================================================
-- QC corrects an entry in "Jugs with QC" (quantity, who brought it, remove)
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "create an icon to make adjustment in case of error, qc
-- should be able to correct entry of the jugs on each row".
--
-- correct_qc_jug_entry(id, quantity, reason, from_type, from_id)
--   For a consignment still with QC (status 'accepted'):
--   * quantity  the right number of jugs; 0 removes the entry (cancelled);
--   * from      who really brought them back (marketer / the shop /
--               customer / walk-in) -- returned empties only, and only while
--               none of that return has been posted to the PM yet.
--   The entry itself is put right -- the consignment, the jug ledger move(s)
--   under its reference and, for a Warehouse-recorded return, the return
--   (jug_returns) -- so QC's page, Jugs collected, the reports and the
--   Accounts all read the corrected figure. The jug ledger stays append-only
--   for everything else: only this function may change those rows
--   (elim.jug_correction, set for the moment and reset). A reason is required;
--   before and after go to the audit log.
--   A part left over from a partial posting ("<ref>-R1") shares its
--   return's ledger move: its quantity changes that move by the difference.
-- ============================================================================

-- The ledger lets this correction through, nothing else (as elim.redating).
CREATE OR REPLACE FUNCTION public._container_movements_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('elim.redating', true) = 'on'
     AND (to_jsonb(NEW) - 'created_at') = (to_jsonb(OLD) - 'created_at') THEN
    RETURN NEW;
  END IF;
  IF current_setting('elim.jug_correction', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'container_movements is append-only; record a correcting movement instead';
END;
$$;

CREATE OR REPLACE FUNCTION public.correct_qc_jug_entry(p_id uuid, p_quantity numeric, p_reason text,
                                                      p_from_type text DEFAULT NULL, p_from_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  b qc_jug_batches%ROWTYPE;
  v_base text;
  v_diff numeric;
  v_whole boolean;
  v_new_from_type text := NULLIF(p_from_type, '');
  v_new_from_id uuid := p_from_id;
  v_change_from boolean;
  v_name text;
  m record;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Only Quality Control corrects jug entries';
  END IF;
  SELECT * INTO b FROM qc_jug_batches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found'; END IF;
  IF NOT public._works_in_factory(v_uid, b.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF b.status <> 'accepted' THEN
    RAISE EXCEPTION '% has already been posted to the PM -- it can no longer be corrected here', b.reference;
  END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why the entry is being corrected'; END IF;
  IF p_quantity IS NULL OR p_quantity < 0 OR p_quantity <> trunc(p_quantity) THEN
    RAISE EXCEPTION 'Enter the whole number of jugs (0 removes the entry)';
  END IF;

  -- The return this entry belongs to (a "-R<n>" part shares its return's move).
  v_base := regexp_replace(b.reference, '-R[0-9]+$', '');
  v_diff := p_quantity - b.quantity_accepted;
  -- Other parts of the same return (posted or not).
  v_whole := NOT EXISTS (SELECT 1 FROM qc_jug_batches o
                          WHERE o.factory_id = b.factory_id AND o.id <> b.id AND o.status <> 'cancelled'
                            AND (o.reference = v_base OR o.reference LIKE v_base || '-R%'));

  -- Who brought them: returned empties only, the whole return only.
  v_change_from := v_new_from_type IS NOT NULL
                   AND (v_new_from_type IS DISTINCT FROM b.from_type OR v_new_from_id IS DISTINCT FROM b.from_id);
  IF v_change_from THEN
    IF NOT b.collected OR b.from_type IS NULL THEN
      RAISE EXCEPTION 'Only returned empty jugs have a sender to change';
    END IF;
    IF NOT v_whole THEN
      RAISE EXCEPTION 'Part of this return was already posted to the PM -- the sender can''t be changed now';
    END IF;
    IF v_new_from_type NOT IN ('sales_rep', 'customer', 'walk_in') THEN RAISE EXCEPTION 'Choose who brought the jugs'; END IF;
    IF v_new_from_type = 'walk_in' THEN v_new_from_id := NULL;
    ELSIF v_new_from_id IS NULL THEN RAISE EXCEPTION 'Choose the marketer or customer';
    ELSIF v_new_from_type = 'sales_rep' THEN
      SELECT full_name INTO v_name FROM sales_reps WHERE id = v_new_from_id AND factory_id = b.factory_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
    ELSE
      SELECT name INTO v_name FROM customers WHERE id = v_new_from_id AND factory_id = b.factory_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
    END IF;
  END IF;
  IF v_diff = 0 AND NOT v_change_from THEN RAISE EXCEPTION 'Nothing to change'; END IF;

  PERFORM set_config('elim.jug_correction', 'on', true);
  -- The ledger move(s) of this return: holder -> QC (or -> Warehouse and
  -- Warehouse -> QC for older ones), or Store -> QC for new jugs.
  FOR m IN SELECT * FROM container_movements
            WHERE factory_id = b.factory_id AND reference = v_base AND source IN ('return', 'qc_accept')
            FOR UPDATE LOOP
    IF m.quantity + v_diff <= 0 THEN
      DELETE FROM container_movements WHERE id = m.id;
    ELSE
      UPDATE container_movements
         SET quantity = m.quantity + v_diff,
             from_type = CASE WHEN v_change_from AND m.source = 'return' THEN v_new_from_type ELSE from_type END,
             from_id = CASE WHEN v_change_from AND m.source = 'return' THEN v_new_from_id ELSE from_id END
       WHERE id = m.id;
    END IF;
  END LOOP;
  PERFORM set_config('elim.jug_correction', 'off', true);

  -- A Warehouse-recorded return: what QC counted (and who) follows.
  IF b.jug_return_id IS NOT NULL OR EXISTS (SELECT 1 FROM jug_returns WHERE reference = v_base) THEN
    UPDATE jug_returns
       SET quantity_received = GREATEST(COALESCE(quantity_received, 0) + v_diff, 0),
           quantity_claimed = GREATEST(quantity_claimed, COALESCE(quantity_received, 0) + v_diff),
           sales_rep_id = CASE WHEN v_change_from THEN (CASE WHEN v_new_from_type = 'sales_rep' THEN v_new_from_id END)
                               ELSE sales_rep_id END,
           customer_id = CASE WHEN v_change_from THEN (CASE WHEN v_new_from_type = 'customer' THEN v_new_from_id END)
                              ELSE customer_id END,
           verify_note = concat_ws(' · ', verify_note, 'Corrected by QC: ' || v_reason)
     WHERE reference = v_base AND factory_id = b.factory_id
       AND (NOT v_change_from OR v_new_from_type <> 'walk_in');
  END IF;

  IF p_quantity = 0 THEN
    UPDATE qc_jug_batches
       SET status = 'cancelled', accepted_at = NULL, cancelled_by = v_uid, cancelled_at = now(),
           cancel_reason = 'Removed by QC: ' || v_reason
     WHERE id = b.id;
  ELSE
    UPDATE qc_jug_batches
       SET quantity_accepted = p_quantity,
           quantity_sent = GREATEST(p_quantity, CASE WHEN collected THEN p_quantity ELSE quantity_sent END),
           from_type = CASE WHEN v_change_from THEN v_new_from_type ELSE from_type END,
           from_id = CASE WHEN v_change_from THEN v_new_from_id ELSE from_id END,
           send_notes = CASE WHEN v_change_from THEN 'From ' || COALESCE(v_name, 'walk-in customers') ELSE send_notes END,
           accept_note = concat_ws(' · ', accept_note, 'Corrected by QC: ' || v_reason)
     WHERE id = b.id;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, b.factory_id, 'correct_qc_jug_entry', 'qc_jug_batches', b.id::text,
          jsonb_build_object('reference', b.reference, 'quantity', b.quantity_accepted,
                             'from_type', b.from_type, 'from_id', b.from_id),
          jsonb_build_object('quantity', p_quantity, 'from_type', CASE WHEN v_change_from THEN v_new_from_type ELSE b.from_type END,
                             'from_id', CASE WHEN v_change_from THEN v_new_from_id ELSE b.from_id END,
                             'reason', v_reason, 'removed', p_quantity = 0));
  RETURN jsonb_build_object('reference', b.reference, 'quantity', p_quantity, 'removed', p_quantity = 0);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_qc_jug_entry(uuid, numeric, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_qc_jug_entry(uuid, numeric, text, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
