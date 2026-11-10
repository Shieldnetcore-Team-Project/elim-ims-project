-- ============================================================================
-- Empty jug returns are no longer refused ("can return at most 0")
-- ----------------------------------------------------------------------------
-- User (2026-11-10): on Quality Control, returning jugs from marketers and
-- distributors failed with "Emmanuel can return at most 0 -- record an
-- opening balance first". Two causes:
--   * a marketer's posted Dispenser Water counted as FULL until Accounts
--     record the sale item by item -- which mostly never happens -- so the
--     empties they bring back were "not held";
--   * jugs a person had before tracking started are not on the ledger.
-- Now:
--   * the limit is every jug the person holds (full or empty), not only the
--     empties;
--   * when more come back than that, the extra is booked automatically as an
--     opening balance ('issue', reference OPENING-BALANCE, noon the day before
--     the return -- the same rule as 20261110100000) so nobody goes below 0
--     and the return goes through. Audit-logged.
-- Where:
--   record_container_movement  (QC -> Dispenser -> Record movement, "Empties
--                               returned") books the extra at once;
--   record_jug_return          (Warehouse) records any claim -- QC's count is
--                               the physical check;
--   verify_jug_return          (QC count) books the extra when counted.
-- Old and New Dispenser Jug count together. Bodies otherwise as
-- 20261110110000 / 20261102210000 / 20261103210000.
-- ============================================================================

-- Book the jugs coming back above what the person holds as an opening balance.
-- p_skip_return: the pending return being counted (its claim isn't "other").
CREATE OR REPLACE FUNCTION public._jug_open_for_return(
  p_factory uuid, p_type uuid, p_holder_type text, p_holder_id uuid, p_qty numeric, p_day date,
  p_reference text, p_skip_return uuid DEFAULT NULL)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_is_jug boolean;
  v_held numeric;
  v_extra numeric;
BEGIN
  IF p_holder_id IS NULL OR p_holder_type NOT IN ('customer', 'sales_rep') OR COALESCE(p_qty, 0) <= 0 THEN
    RETURN 0;
  END IF;
  v_is_jug := EXISTS (SELECT 1 FROM container_types ct WHERE ct.id = p_type AND ct.name ~* 'jug|dispenser');
  SELECT COALESCE(SUM(
           CASE WHEN p_holder_type = 'customer' THEN public._jug_customer_balance(p_holder_id, ct.id)
                ELSE public._jug_rep_balance(p_holder_id, ct.id) END
           - COALESCE((SELECT SUM(j.quantity_claimed) FROM jug_returns j
                        WHERE j.status = 'pending' AND j.container_type_id = ct.id
                          AND j.id IS DISTINCT FROM p_skip_return
                          AND ((p_holder_type = 'customer' AND j.customer_id = p_holder_id)
                            OR (p_holder_type = 'sales_rep' AND j.sales_rep_id = p_holder_id))), 0)), 0)
    INTO v_held
    FROM container_types ct
   WHERE ct.factory_id = p_factory
     AND (ct.id = p_type OR (v_is_jug AND ct.name ~* 'jug|dispenser'));
  v_extra := p_qty - v_held;
  IF v_extra <= 0 THEN RETURN 0; END IF;

  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, notes, created_by, created_at)
  VALUES (p_factory, p_type, 'external', NULL, p_holder_type, p_holder_id, v_extra, 'issue', 'OPENING-BALANCE',
          'Jugs held before tracking started -- booked when ' || COALESCE(p_reference, 'a return')
            || ' brought back more than recorded',
          auth.uid(), ((p_day - 1)::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Lagos');
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), p_factory, 'jug_opening_balance',
          CASE WHEN p_holder_type = 'customer' THEN 'customers' ELSE 'sales_reps' END, p_holder_id::text,
          jsonb_build_object('loaded', v_extra, 'dated', p_day - 1, 'returned', p_qty, 'held', v_held,
                             'reference', p_reference, 'reason', 'More jugs came back than recorded'));
  RETURN v_extra;
END;
$$;
REVOKE ALL ON FUNCTION public._jug_open_for_return(uuid, uuid, text, uuid, numeric, date, text, uuid)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- Record movement
CREATE OR REPLACE FUNCTION public.record_container_movement(payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_type uuid := (payload->>'container_type_id')::uuid;
  v_kind text := payload->>'kind';
  v_holder_type text := NULLIF(payload->>'holder_type', '');
  v_holder_id uuid := NULLIF(payload->>'holder_id', '')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_ref text := NULLIF(btrim(COALESCE(payload->>'reference', '')), '');
  v_today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  v_day date := COALESCE(NULLIF(payload->>'movement_date', '')::date, v_today);
  v_at timestamptz;
  v_from_type text; v_from_id uuid; v_to_type text; v_to_id uuid;
  v_id uuid;
BEGIN
  IF v_kind NOT IN ('return','issue','purchase','lost','damaged') THEN RAISE EXCEPTION 'Unknown movement type'; END IF;
  IF NOT public.has_permission(v_uid, 'distribution'::module_key,
       (CASE WHEN v_kind IN ('return','issue') THEN 'create' ELSE 'approve' END)::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_day > v_today THEN RAISE EXCEPTION 'A movement can''t be dated in the future'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be more than 0'; END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = v_type AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Container type not found for this factory';
  END IF;
  IF v_kind IN ('return','issue','lost') THEN
    IF v_holder_type NOT IN ('customer','sales_rep','walk_in') OR (v_kind = 'issue' AND v_holder_type = 'walk_in') THEN
      RAISE EXCEPTION 'Choose who holds the containers';
    END IF;
    IF v_holder_type = 'walk_in' THEN v_holder_id := NULL;
    ELSIF v_holder_id IS NULL THEN RAISE EXCEPTION 'Choose the customer or marketer';
    ELSIF v_holder_type = 'customer' AND NOT EXISTS (SELECT 1 FROM customers WHERE id = v_holder_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Customer not found for this factory';
    ELSIF v_holder_type = 'sales_rep' AND NOT EXISTS (SELECT 1 FROM sales_reps WHERE id = v_holder_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Marketer not found for this factory';
    END IF;
  END IF;
  IF v_kind IN ('lost','damaged') AND v_notes IS NULL THEN RAISE EXCEPTION 'Say what happened to the containers'; END IF;

  -- More back than they hold: the extra becomes their opening balance, so
  -- the return goes through and nobody goes below 0. The row lock serialises
  -- two returns for the same person.
  IF v_kind = 'return' AND v_holder_id IS NOT NULL THEN
    IF v_holder_type = 'customer' THEN
      PERFORM 1 FROM customers c WHERE c.id = v_holder_id FOR UPDATE;
    ELSE
      PERFORM 1 FROM sales_reps r WHERE r.id = v_holder_id FOR UPDATE;
    END IF;
    PERFORM public._jug_open_for_return(v_factory, v_type, v_holder_type, v_holder_id, v_qty, v_day,
                                        COALESCE(v_ref, 'Record movement'));
  END IF;

  CASE v_kind
    WHEN 'return'   THEN v_from_type := v_holder_type; v_from_id := v_holder_id; v_to_type := 'warehouse';
    WHEN 'issue'    THEN v_from_type := 'warehouse'; v_to_type := v_holder_type; v_to_id := v_holder_id;
    WHEN 'purchase' THEN v_from_type := 'external'; v_to_type := 'warehouse';
    WHEN 'lost'     THEN v_from_type := v_holder_type; v_from_id := v_holder_id; v_to_type := 'external';
    WHEN 'damaged'  THEN v_from_type := 'warehouse'; v_to_type := 'external';
  END CASE;

  -- Today: now. An earlier day: noon (Lagos) that day.
  v_at := CASE WHEN v_day = v_today THEN now()
               ELSE (v_day::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Lagos' END;

  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, notes, created_by, created_at)
  VALUES (v_factory, v_type, v_from_type, v_from_id, v_to_type, v_to_id, v_qty,
          v_kind, v_ref, v_notes, v_uid, v_at)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'record_container_movement', 'container_movements', v_id::text,
          jsonb_build_object('kind', v_kind, 'container_type_id', v_type, 'holder_type', v_holder_type,
                             'holder_id', v_holder_id, 'quantity', v_qty, 'notes', v_notes,
                             'movement_date', v_day));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_container_movement(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_container_movement(jsonb) TO authenticated;

-- ---------------------------------------------------------------- Warehouse claim
CREATE OR REPLACE FUNCTION public.record_jug_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep uuid := NULLIF(payload->>'sales_rep_id', '')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id', '')::uuid;
  v_type uuid := NULLIF(payload->>'container_type_id', '')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, (now() AT TIME ZONE 'Africa/Lagos')::date);
  v_at timestamptz;
  v_r sales_reps%ROWTYPE;
  v_c customers%ROWTYPE;
  v_factory uuid;
  v_existing jug_returns%ROWTYPE;
  v_ref text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'sales'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM jug_returns WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  IF (v_rep IS NULL) = (v_customer IS NULL) THEN
    RAISE EXCEPTION 'Choose who brought the jugs back';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN
    RAISE EXCEPTION 'Enter a whole number of jugs above 0';
  END IF;
  IF v_date > v_today THEN RAISE EXCEPTION 'A return can''t be dated in the future'; END IF;
  v_at := CASE WHEN v_date = v_today THEN now()
               ELSE (v_date + time '17:00') AT TIME ZONE 'Africa/Lagos' END;

  IF v_rep IS NOT NULL THEN
    SELECT * INTO v_r FROM sales_reps WHERE id = v_rep FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
    v_factory := v_r.factory_id;
  ELSE
    SELECT * INTO v_c FROM customers WHERE id = v_customer FOR UPDATE;
    IF NOT FOUND OR v_c.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Customer not found'; END IF;
    v_factory := v_c.factory_id;
  END IF;
  IF NOT public._works_in_factory(v_uid, v_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = v_type AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Jug type not found for this factory';
  END IF;
  -- No limit here (2026-11-10): QC's count is the physical check, and any
  -- jugs above what the person holds are booked as their opening balance then.

  v_ref := 'JR-' || to_char(v_date, 'YYYYMMDD') || '-' || lpad(nextval('public.jug_return_seq')::text, 5, '0');
  INSERT INTO jug_returns(factory_id, reference, client_ref, sales_rep_id, customer_id, container_type_id,
                          quantity_claimed, notes, recorded_by, recorded_at)
  VALUES (v_factory, v_ref, v_client, v_rep, v_customer, v_type, v_qty, v_notes, v_uid, v_at)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'record_jug_return', 'jug_returns', v_id::text,
          jsonb_build_object('reference', v_ref, 'sales_rep_id', v_rep, 'customer_id', v_customer, 'quantity', v_qty));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.record_jug_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_jug_return(jsonb) TO authenticated;

-- ---------------------------------------------------------------- QC count
CREATE OR REPLACE FUNCTION public.verify_jug_return(p_id uuid, p_received numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_j jug_returns%ROWTYPE;
  v_name text;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_type container_types%ROWTYPE;
  v_holder_type text;
BEGIN
  IF NOT (public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key)
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only Quality Control counts returned jugs';
  END IF;
  SELECT * INTO v_j FROM jug_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  IF v_j.status <> 'pending' THEN RAISE EXCEPTION 'Return % is already %', v_j.reference, v_j.status; END IF;
  IF v_j.recorded_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Someone other than the person who recorded % must count and confirm it', v_j.reference;
  END IF;
  IF p_received IS NULL OR p_received < 0 OR p_received <> trunc(p_received) THEN
    RAISE EXCEPTION 'Enter the whole number of jugs counted (0 if none arrived)';
  END IF;
  IF p_received > v_j.quantity_claimed THEN
    RAISE EXCEPTION 'Counted % but the Warehouse recorded % -- the Warehouse records the extra jugs as a new return',
      trim_scale(p_received), trim_scale(v_j.quantity_claimed);
  END IF;
  IF p_received <> v_j.quantity_claimed AND v_note IS NULL THEN
    RAISE EXCEPTION 'The count differs from the % claimed -- say why', trim_scale(v_j.quantity_claimed);
  END IF;

  IF v_j.sales_rep_id IS NOT NULL THEN
    SELECT full_name INTO v_name FROM sales_reps WHERE id = v_j.sales_rep_id FOR UPDATE;
    v_holder_type := 'sales_rep';
  ELSE
    SELECT name INTO v_name FROM customers WHERE id = v_j.customer_id FOR UPDATE;
    v_holder_type := 'customer';
  END IF;

  IF p_received > 0 THEN
    -- More counted than they hold: the extra is their opening balance.
    PERFORM public._jug_open_for_return(v_j.factory_id, v_j.container_type_id, v_holder_type,
                                        COALESCE(v_j.sales_rep_id, v_j.customer_id), p_received,
                                        public._jug_day(v_j.recorded_at), v_j.reference, v_j.id);
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                    source, reference, notes, created_by)
    VALUES (v_j.factory_id, v_j.container_type_id, v_holder_type,
            COALESCE(v_j.sales_rep_id, v_j.customer_id), 'warehouse', NULL, p_received,
            'return', v_j.reference, COALESCE(v_note, v_j.notes), v_uid);
  END IF;
  SELECT * INTO v_type FROM container_types WHERE id = v_j.container_type_id;
  -- Rule A (2026-11-03): an empty brought back clears the jug, no money credit.
  UPDATE jug_returns SET status = 'verified', quantity_received = p_received, verified_by = v_uid,
         verified_at = now(), verify_note = v_note, credit_price = NULL
   WHERE id = p_id;

  -- The counted jugs are QC's from here: an accepted consignment, which QC
  -- verifies (good / damaged) and posts to the PM as usual.
  IF p_received > 0 THEN
    INSERT INTO qc_jug_batches (factory_id, reference, jug_kind, quantity_sent, send_notes, sent_by, sent_at,
                                status, quantity_accepted, accept_note, accepted_by, accepted_at, jug_return_id)
    VALUES (v_j.factory_id, v_j.reference, CASE WHEN v_type.name ~* 'old' THEN 'old' ELSE 'new' END,
            v_j.quantity_claimed, 'From ' || v_name || COALESCE(' -- ' || v_j.notes, ''),
            v_j.recorded_by, v_j.recorded_at, 'accepted', p_received, v_note, v_uid, now(), v_j.id)
    ON CONFLICT (reference) DO NOTHING;
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_j.factory_id, 'verify_jug_return', 'jug_returns', p_id::text,
          jsonb_build_object('claimed', v_j.quantity_claimed),
          jsonb_build_object('received', p_received, 'note', v_note));
  RETURN jsonb_build_object('reference', v_j.reference, 'received', p_received,
                            'short', v_j.quantity_claimed - p_received);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_jug_return(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_jug_return(uuid, numeric, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
