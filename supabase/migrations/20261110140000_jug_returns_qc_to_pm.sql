-- ============================================================================
-- Returned empty jugs: marketer / distributor / shop -> QC -> PM (daily)
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "all posting of jug should not go to warehouse, instead
-- it should go to pm when quality control post returned jugs from marketers,
-- distributors and retail shop ... qc collects all returns from marketers and
-- distributors and posts them to pm for production ... so that qc can collect
-- jugs and post to pm on a daily basis", and the PM page shows everything QC
-- has posted.
--
-- Before: an empty counted back was booked holder -> Warehouse and then
-- Warehouse -> QC; Record movement "Empties returned" stopped in the
-- Warehouse and never reached QC or the PM; QC verified and posted each
-- consignment on its own.
-- Now:
--   * every empty jug returned goes holder -> QC (source 'return'):
--       verify_jug_return          (QC counts what the Warehouse recorded)
--       record_container_movement  (QC records a return herself) -- also
--                                  opens a QC consignment so it can be posted
--     Other containers (crates...) are unchanged: back to the Warehouse.
--   * qc_jug_batches.collected marks those consignments (the move into QC is
--     already written, so the trigger does not move Warehouse -> QC again);
--     from_type / from_id say who brought them back.
--   * qc_post_jugs_to_pm(factory, damaged, reason): QC posts EVERY jug she
--     holds to the PM at once -- one posting (QPM-...) a day or whenever she
--     likes; the damaged ones (with what is wrong) are written off, taken
--     from the oldest consignments first.
--   * receive_qc_jug_posting(factory, posting): the PM confirms a whole
--     posting (still dispenser production only, trg_qc_jugs_dispenser_production).
--   * qc_pm_jug_postings(factory, from, to): every posting -- older single
--     consignments count as their own posting -- for the PM page and QC.
--   * jug_overview gains at_qc and at_production.
-- Past moves are not rewritten.
-- ============================================================================

-- ---------------------------------------------------------------- columns
ALTER TABLE public.qc_jug_batches ADD COLUMN IF NOT EXISTS collected boolean NOT NULL DEFAULT false;
ALTER TABLE public.qc_jug_batches ADD COLUMN IF NOT EXISTS from_type text;
ALTER TABLE public.qc_jug_batches ADD COLUMN IF NOT EXISTS from_id uuid;
ALTER TABLE public.qc_jug_batches ADD COLUMN IF NOT EXISTS pm_posting text;
CREATE INDEX IF NOT EXISTS qc_jug_batches_posting_idx ON public.qc_jug_batches (factory_id, pm_posting);

UPDATE public.qc_jug_batches b
   SET from_type = CASE WHEN j.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'customer' END,
       from_id = COALESCE(j.sales_rep_id, j.customer_id)
  FROM public.jug_returns j
 WHERE j.id = b.jug_return_id AND b.from_type IS NULL;

-- ---------------------------------------------------------------- trigger
CREATE OR REPLACE FUNCTION public._containers_on_qc_jug_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type uuid := public._jug_type_for_kind(NEW.factory_id, NEW.jug_kind);
  v_old text := CASE WHEN TG_OP = 'INSERT' THEN 'sent' ELSE OLD.status END;
BEGIN
  IF v_type IS NULL OR NEW.status = v_old THEN RETURN NEW; END IF;
  -- QC took them in: new jugs from the Store, or (before 2026-11-10) empties
  -- booked into the Warehouse first. Collected empties are already at QC.
  IF v_old = 'sent' AND NEW.status IN ('accepted', 'verified', 'received') AND NOT NEW.collected THEN
    PERFORM public._jug_move(NEW.factory_id, v_type,
      CASE WHEN NEW.jug_return_id IS NOT NULL THEN 'warehouse' ELSE 'store' END, 'qc',
      NEW.quantity_accepted, 'qc_accept', NEW.reference);
  END IF;
  IF v_old IN ('sent', 'accepted') AND NEW.status IN ('verified', 'received') THEN
    PERFORM public._jug_move(NEW.factory_id, v_type, 'qc', 'external', NEW.quantity_damaged, 'qc_damaged',
      NEW.reference, NEW.damage_reason);
  END IF;
  IF NEW.status = 'received' THEN
    PERFORM public._jug_move(NEW.factory_id, v_type, 'qc', 'production', NEW.quantity_good, 'qc_to_production',
      NEW.reference);
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Record movement
-- As 20261110130000; an empty jug returned goes to QC and opens a consignment.
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
  v_type_name text;
  v_jug_back boolean;
  v_name text;
BEGIN
  IF v_kind NOT IN ('return','issue','purchase','lost','damaged') THEN RAISE EXCEPTION 'Unknown movement type'; END IF;
  IF NOT public.has_permission(v_uid, 'distribution'::module_key,
       (CASE WHEN v_kind IN ('return','issue') THEN 'create' ELSE 'approve' END)::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_day > v_today THEN RAISE EXCEPTION 'A movement can''t be dated in the future'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be more than 0'; END IF;
  SELECT ct.name::text INTO v_type_name FROM container_types ct WHERE ct.id = v_type AND ct.factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Container type not found for this factory'; END IF;
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
  v_jug_back := v_kind = 'return' AND v_type_name ~* 'jug|dispenser';
  IF v_jug_back AND v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole number of jugs'; END IF;

  -- More back than they hold: the extra becomes their opening balance.
  IF v_kind = 'return' AND v_holder_id IS NOT NULL THEN
    IF v_holder_type = 'customer' THEN
      SELECT c.name::text INTO v_name FROM customers c WHERE c.id = v_holder_id FOR UPDATE;
    ELSE
      SELECT r.full_name::text INTO v_name FROM sales_reps r WHERE r.id = v_holder_id FOR UPDATE;
    END IF;
    PERFORM public._jug_open_for_return(v_factory, v_type, v_holder_type, v_holder_id, v_qty, v_day,
                                        COALESCE(v_ref, 'Record movement'));
  END IF;

  CASE v_kind
    -- Empty jugs back go to Quality Control (2026-11-10); other containers to the Warehouse.
    WHEN 'return'   THEN v_from_type := v_holder_type; v_from_id := v_holder_id;
                         v_to_type := CASE WHEN v_jug_back THEN 'qc' ELSE 'warehouse' END;
    WHEN 'issue'    THEN v_from_type := 'warehouse'; v_to_type := v_holder_type; v_to_id := v_holder_id;
    WHEN 'purchase' THEN v_from_type := 'external'; v_to_type := 'warehouse';
    WHEN 'lost'     THEN v_from_type := v_holder_type; v_from_id := v_holder_id; v_to_type := 'external';
    WHEN 'damaged'  THEN v_from_type := 'warehouse'; v_to_type := 'external';
  END CASE;

  v_at := CASE WHEN v_day = v_today THEN now()
               ELSE (v_day::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Lagos' END;
  IF v_jug_back THEN
    -- Its own reference (the consignment's); a typed one is kept in the notes.
    IF v_ref IS NOT NULL THEN v_notes := concat_ws(' · ', v_notes, 'Ref ' || v_ref); END IF;
    v_ref := 'JRQ-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(nextval('public.jug_return_seq')::text, 5, '0');
  END IF;

  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, notes, created_by, created_at)
  VALUES (v_factory, v_type, v_from_type, v_from_id, v_to_type, v_to_id, v_qty,
          v_kind, v_ref, v_notes, v_uid, v_at)
  RETURNING id INTO v_id;

  -- The jugs are QC's now: a consignment she posts to the PM with the rest.
  IF v_jug_back THEN
    INSERT INTO qc_jug_batches (factory_id, reference, jug_kind, quantity_sent, send_notes, sent_by, sent_at,
                                status, quantity_accepted, accepted_by, accepted_at, collected, from_type, from_id)
    VALUES (v_factory, v_ref, CASE WHEN v_type_name ~* 'old' THEN 'old' ELSE 'new' END, v_qty,
            'From ' || COALESCE(v_name, 'walk-in customers') || COALESCE(' -- ' || v_notes, ''),
            v_uid, v_at, 'accepted', v_qty, v_uid, v_at, true, v_holder_type, v_holder_id);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'record_container_movement', 'container_movements', v_id::text,
          jsonb_build_object('kind', v_kind, 'container_type_id', v_type, 'holder_type', v_holder_type,
                             'holder_id', v_holder_id, 'quantity', v_qty, 'notes', v_notes,
                             'movement_date', v_day, 'reference', v_ref));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_container_movement(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_container_movement(jsonb) TO authenticated;

-- ---------------------------------------------------------------- QC count
-- As 20261110130000; the counted empties go straight to QC.
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
    PERFORM public._jug_open_for_return(v_j.factory_id, v_j.container_type_id, v_holder_type,
                                        COALESCE(v_j.sales_rep_id, v_j.customer_id), p_received,
                                        public._jug_day(v_j.recorded_at), v_j.reference, v_j.id);
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                    source, reference, notes, created_by)
    VALUES (v_j.factory_id, v_j.container_type_id, v_holder_type,
            COALESCE(v_j.sales_rep_id, v_j.customer_id), 'qc', NULL, p_received,
            'return', v_j.reference, COALESCE(v_note, v_j.notes), v_uid);
  END IF;
  SELECT * INTO v_type FROM container_types WHERE id = v_j.container_type_id;
  UPDATE jug_returns SET status = 'verified', quantity_received = p_received, verified_by = v_uid,
         verified_at = now(), verify_note = v_note, credit_price = NULL
   WHERE id = p_id;

  IF p_received > 0 THEN
    INSERT INTO qc_jug_batches (factory_id, reference, jug_kind, quantity_sent, send_notes, sent_by, sent_at,
                                status, quantity_accepted, accept_note, accepted_by, accepted_at, jug_return_id,
                                collected, from_type, from_id)
    VALUES (v_j.factory_id, v_j.reference, CASE WHEN v_type.name ~* 'old' THEN 'old' ELSE 'new' END,
            v_j.quantity_claimed, 'From ' || v_name || COALESCE(' -- ' || v_j.notes, ''),
            v_j.recorded_by, v_j.recorded_at, 'accepted', p_received, v_note, v_uid, now(), v_j.id,
            true, v_holder_type, COALESCE(v_j.sales_rep_id, v_j.customer_id))
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

-- ---------------------------------------------------------------- QC posts to the PM
CREATE OR REPLACE FUNCTION public.qc_post_jugs_to_pm(p_factory uuid, p_damaged numeric DEFAULT 0,
                                                    p_damage_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_damage_reason, '')), '');
  v_damaged numeric := COALESCE(p_damaged, 0);
  v_total numeric;
  v_left numeric;
  v_take numeric;
  v_ref text;
  v_n int := 0;
  b record;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Only Quality Control posts jugs to the PM';
  END IF;
  IF p_factory IS NULL OR NOT public._works_in_factory(v_uid, p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_damaged < 0 OR v_damaged <> trunc(v_damaged) THEN RAISE EXCEPTION 'Enter the whole number of damaged jugs'; END IF;
  IF v_damaged > 0 AND v_reason IS NULL THEN RAISE EXCEPTION 'Record what is wrong with the damaged jugs'; END IF;

  -- Everything QC holds, locked so two postings can't take the same jugs.
  PERFORM 1 FROM qc_jug_batches WHERE factory_id = p_factory AND status = 'accepted' FOR UPDATE;
  SELECT COALESCE(SUM(quantity_accepted), 0) INTO v_total
    FROM qc_jug_batches WHERE factory_id = p_factory AND status = 'accepted';
  IF v_total <= 0 THEN RAISE EXCEPTION 'There are no jugs with QC to post'; END IF;
  IF v_damaged > v_total THEN
    RAISE EXCEPTION 'Damaged (%) is more than the % jugs with QC', trim_scale(v_damaged), trim_scale(v_total);
  END IF;

  v_ref := 'QPM-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-'
           || lpad((floor(random() * 99999))::int::text, 5, '0');
  v_left := v_damaged;
  FOR b IN SELECT id, quantity_accepted FROM qc_jug_batches
            WHERE factory_id = p_factory AND status = 'accepted'
            ORDER BY accepted_at, reference LOOP
    v_take := LEAST(v_left, b.quantity_accepted);
    v_left := v_left - v_take;
    UPDATE qc_jug_batches
       SET status = 'verified', quantity_good = b.quantity_accepted - v_take, quantity_damaged = v_take,
           damage_reason = CASE WHEN v_take > 0 THEN v_reason END,
           verified_by = v_uid, verified_at = now(), pm_posting = v_ref
     WHERE id = b.id;
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, p_factory, 'qc_post_jugs_to_pm', 'qc_jug_batches', v_ref,
          jsonb_build_object('total', v_total, 'good', v_total - v_damaged, 'damaged', v_damaged,
                             'reason', v_reason, 'consignments', v_n));
  RETURN jsonb_build_object('reference', v_ref, 'total', v_total, 'good', v_total - v_damaged,
                            'damaged', v_damaged, 'consignments', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_post_jugs_to_pm(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_post_jugs_to_pm(uuid, numeric, text) TO authenticated;

-- ---------------------------------------------------------------- PM confirms a posting
CREATE OR REPLACE FUNCTION public.receive_qc_jug_posting(p_factory uuid, p_posting text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_good numeric := 0;
  v_n int := 0;
  b record;
BEGIN
  IF NOT (public.has_permission(v_uid, 'production'::module_key, 'submit'::action_key)
          OR public.has_permission(v_uid, 'production'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_factory IS NULL OR NOT public._works_in_factory(v_uid, p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  FOR b IN SELECT id, quantity_good, status FROM qc_jug_batches
            WHERE factory_id = p_factory AND COALESCE(pm_posting, reference) = p_posting
            FOR UPDATE LOOP
    IF b.status = 'verified' THEN
      IF b.quantity_good > 0 THEN
        -- trg_qc_jugs_dispenser_production checks who confirms.
        UPDATE qc_jug_batches SET status = 'received', received_by = v_uid, received_at = now(),
               receive_note = NULLIF(btrim(COALESCE(p_note, '')), '')
         WHERE id = b.id;
        v_good := v_good + b.quantity_good;
      END IF;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n = 0 THEN RAISE EXCEPTION '% is not waiting for the Production Manager', p_posting; END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, p_factory, 'receive_qc_jug_posting', 'qc_jug_batches', p_posting,
          jsonb_build_object('good', v_good, 'note', p_note));
  RETURN jsonb_build_object('reference', p_posting, 'good', v_good);
END;
$$;
REVOKE ALL ON FUNCTION public.receive_qc_jug_posting(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_qc_jug_posting(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------- every posting
-- Postings QC made to the PM (older single consignments are their own
-- posting). Open postings show whatever the dates.
CREATE OR REPLACE FUNCTION public.qc_pm_jug_postings(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(posting text, posted_at timestamptz, posted_by text, total numeric, good numeric, damaged numeric,
              damage_reason text, consignments int, sources text, status text, received_at timestamptz,
              received_by text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_can_view() OR NOT public._works_in_factory(auth.uid(), p_factory) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH b AS (
    SELECT COALESCE(x.pm_posting, x.reference) AS pst, x.*,
           CASE x.from_type WHEN 'walk_in' THEN 'Walk-in'
                ELSE COALESCE(sr.full_name, c.name, CASE WHEN x.from_type IS NULL THEN 'Store / Warehouse' END) END AS who
      FROM qc_jug_batches x
      LEFT JOIN sales_reps sr ON x.from_type = 'sales_rep' AND sr.id = x.from_id
      LEFT JOIN customers c ON x.from_type = 'customer' AND c.id = x.from_id
     WHERE x.factory_id = p_factory AND x.status IN ('verified', 'received')
  ), g AS (
    SELECT pst, MIN(verified_at) AS vat, (array_agg(verified_by ORDER BY verified_at))[1] AS vby,
           SUM(quantity_accepted) AS tot, SUM(quantity_good) AS gd, SUM(quantity_damaged) AS dmg,
           string_agg(DISTINCT damage_reason, '; ') AS why, count(*)::int AS n,
           string_agg(DISTINCT who, ', ') AS src,
           bool_and(status = 'received' OR quantity_good = 0) AS done,
           MAX(received_at) AS rat, (array_agg(received_by ORDER BY received_at DESC NULLS LAST))[1] AS rby
      FROM b GROUP BY pst
  )
  SELECT g.pst, g.vat, COALESCE(NULLIF(pv.full_name, ''), pv.email)::text, g.tot, g.gd, g.dmg, g.why, g.n, g.src,
         CASE WHEN g.done THEN 'received' ELSE 'verified' END,
         CASE WHEN g.done THEN g.rat END, CASE WHEN g.done THEN COALESCE(NULLIF(pr.full_name, ''), pr.email)::text END
    FROM g
    LEFT JOIN profiles pv ON pv.id = g.vby
    LEFT JOIN profiles pr ON pr.id = g.rby
   WHERE NOT g.done OR public._jug_day(g.vat) BETWEEN p_from AND p_to
   ORDER BY g.vat DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_pm_jug_postings(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_pm_jug_postings(uuid, date, date) TO authenticated;

-- ---------------------------------------------------------------- collections (as 20261110120000)
-- Consignments now say who brought the jugs (from_type / from_id), so QC's
-- own Record movement returns count at QC / to the PM as well.
CREATE OR REPLACE FUNCTION public.qc_jug_collections(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(holder_type text, holder_id uuid, holder_name text, holder_code text, holder_kind text,
              collected numeric, awaiting_count numeric, at_qc numeric, posted_to_pm numeric,
              received_by_pm numeric, damaged numeric, full_with_them numeric, not_returned numeric,
              last_collected date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_collections_can_view(p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH jt AS (
    SELECT ct.id FROM container_types ct WHERE ct.factory_id = p_factory AND ct.name ~* 'jug|dispenser'
  ), mv AS (
    SELECT m.from_type AS ht, m.from_id AS hid, -m.quantity AS q, m.source AS src, m.created_at AS at
      FROM container_movements m
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.from_type IN ('sales_rep', 'customer', 'walk_in')
    UNION ALL
    SELECT m.to_type, m.to_id, m.quantity, m.source, m.created_at
      FROM container_movements m
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.to_type IN ('sales_rep', 'customer', 'walk_in')
  ), bal AS (
    SELECT ht, hid, SUM(q) AS held,
           SUM(-q) FILTER (WHERE src = 'return' AND public._jug_day(at) BETWEEN p_from AND p_to) AS collected,
           MAX(public._jug_day(at)) FILTER (WHERE src = 'return') AS last_day
      FROM mv GROUP BY ht, hid
  ), full_stock AS (
    SELECT rs.sales_rep_id AS hid, SUM(rs.quantity * pc.quantity_per_unit) AS q
      FROM rep_stock rs
      JOIN product_containers pc ON pc.product_id = rs.product_id
     WHERE pc.container_type_id IN (SELECT id FROM jt)
       AND COALESCE(pc.jug_role, 'with_water') <> 'empty' AND rs.quantity > 0
     GROUP BY rs.sales_rep_id
  ), pend AS (
    SELECT CASE WHEN j.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'customer' END AS ht,
           COALESCE(j.sales_rep_id, j.customer_id) AS hid, SUM(j.quantity_claimed) AS q
      FROM jug_returns j
     WHERE j.factory_id = p_factory AND j.status = 'pending' AND j.container_type_id IN (SELECT id FROM jt)
     GROUP BY 1, 2
  ), qcb AS (
    SELECT b.from_type AS ht, b.from_id AS hid,
           SUM(b.quantity_accepted) FILTER (WHERE b.status = 'accepted') AS at_qc,
           SUM(b.quantity_good) FILTER (WHERE b.status = 'verified') AS posted,
           SUM(b.quantity_good) FILTER (WHERE b.status = 'received'
                                          AND public._jug_day(b.received_at) BETWEEN p_from AND p_to) AS recv,
           SUM(b.quantity_damaged) FILTER (WHERE b.status IN ('verified', 'received')
                                             AND public._jug_day(b.verified_at) BETWEEN p_from AND p_to) AS dmg
      FROM qc_jug_batches b
     WHERE b.factory_id = p_factory AND b.from_type IS NOT NULL
     GROUP BY 1, 2
  ), keys AS (
    SELECT ht, hid FROM bal UNION SELECT ht, hid FROM pend UNION SELECT ht, hid FROM qcb
  ), r AS (
    SELECT k.ht, k.hid,
           CASE k.ht WHEN 'walk_in' THEN 'Walk-in customers' ELSE COALESCE(sr.full_name, c.name) END::text AS name,
           sr.code::text AS code,
           CASE k.ht WHEN 'sales_rep' THEN COALESCE(sr.kind, 'rep') WHEN 'customer' THEN 'customer' ELSE 'walk_in' END::text AS kind,
           COALESCE(b.collected, 0) AS collected,
           COALESCE(p.q, 0) AS awaiting,
           COALESCE(q.at_qc, 0) AS at_qc,
           COALESCE(q.posted, 0) AS posted,
           COALESCE(q.recv, 0) AS recv,
           COALESCE(q.dmg, 0) AS dmg,
           CASE WHEN k.ht = 'sales_rep' THEN COALESCE(f.q, 0) ELSE 0 END AS full_q,
           GREATEST(COALESCE(b.held, 0) - COALESCE(p.q, 0), 0) AS owed,
           b.last_day
      FROM keys k
      LEFT JOIN bal b ON b.ht = k.ht AND b.hid IS NOT DISTINCT FROM k.hid
      LEFT JOIN pend p ON p.ht = k.ht AND p.hid IS NOT DISTINCT FROM k.hid
      LEFT JOIN qcb q ON q.ht = k.ht AND q.hid IS NOT DISTINCT FROM k.hid
      LEFT JOIN full_stock f ON k.ht = 'sales_rep' AND f.hid = k.hid
      LEFT JOIN sales_reps sr ON k.ht = 'sales_rep' AND sr.id = k.hid
      LEFT JOIN customers c ON k.ht = 'customer' AND c.id = k.hid
  )
  SELECT r.ht, r.hid, COALESCE(r.name, '(unknown)'), r.code, r.kind, r.collected, r.awaiting, r.at_qc, r.posted,
         r.recv, r.dmg, r.full_q, r.owed, r.last_day
    FROM r
   WHERE r.collected > 0 OR r.awaiting > 0 OR r.at_qc > 0 OR r.posted > 0 OR r.recv > 0 OR r.dmg > 0
      OR r.full_q > 0 OR r.owed > 0
   ORDER BY r.kind, r.name;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_jug_collections(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_jug_collections(uuid, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.qc_jug_collection_lines(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(id uuid, reference text, collected_on date, holder_type text, holder_id uuid, holder_name text,
              holder_kind text, recorded numeric, counted numeric, good numeric, damaged numeric,
              stage text, stage_at timestamptz, notes text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_collections_can_view(p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH jt AS (
    SELECT ct.id FROM container_types ct WHERE ct.factory_id = p_factory AND ct.name ~* 'jug|dispenser'
  ), lines AS (
    SELECT j.id, j.reference::text AS reference, public._jug_day(j.recorded_at) AS day,
           CASE WHEN j.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'customer' END::text AS ht,
           COALESCE(j.sales_rep_id, j.customer_id) AS hid,
           COALESCE(sr.full_name, c.name)::text AS name,
           COALESCE(sr.kind, 'customer')::text AS kind,
           j.quantity_claimed AS recorded, j.quantity_received AS counted,
           b.quantity_good AS good, b.quantity_damaged AS damaged,
           CASE WHEN j.status = 'pending' THEN 'awaiting_count'
                WHEN j.status = 'cancelled' THEN 'cancelled'
                WHEN b.id IS NULL THEN 'none_counted'
                WHEN b.status = 'accepted' THEN 'at_qc'
                WHEN b.status = 'verified' THEN 'posted_to_pm'
                WHEN b.status = 'received' THEN 'received_by_pm'
                ELSE b.status END::text AS stage,
           CASE WHEN j.status = 'pending' THEN j.recorded_at
                WHEN b.status = 'received' THEN b.received_at
                WHEN b.status = 'verified' THEN b.verified_at
                WHEN b.status = 'accepted' THEN b.accepted_at
                ELSE COALESCE(j.verified_at, j.recorded_at) END AS stage_at,
           NULLIF(concat_ws(' · ', j.notes, j.verify_note, b.damage_reason, b.pm_posting), '')::text AS notes
      FROM jug_returns j
      LEFT JOIN qc_jug_batches b ON b.jug_return_id = j.id AND b.status <> 'cancelled'
      LEFT JOIN sales_reps sr ON sr.id = j.sales_rep_id
      LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.factory_id = p_factory AND j.container_type_id IN (SELECT id FROM jt)
       AND (public._jug_day(j.recorded_at) BETWEEN p_from AND p_to
            OR j.status = 'pending' OR b.status IN ('accepted', 'verified'))
    UNION ALL
    -- Recorded with Record movement: straight to QC since 2026-11-10 (a
    -- consignment under the same reference); before that, the Warehouse.
    SELECT m.id, COALESCE(m.reference, 'Record movement')::text, public._jug_day(m.created_at),
           m.from_type::text, m.from_id,
           CASE m.from_type WHEN 'walk_in' THEN 'Walk-in customers' ELSE COALESCE(sr.full_name, c.name) END::text,
           CASE m.from_type WHEN 'sales_rep' THEN COALESCE(sr.kind, 'rep') WHEN 'customer' THEN 'customer'
                ELSE 'walk_in' END::text,
           m.quantity, m.quantity, b.quantity_good, b.quantity_damaged,
           CASE WHEN b.id IS NULL THEN 'direct'
                WHEN b.status = 'accepted' THEN 'at_qc'
                WHEN b.status = 'verified' THEN 'posted_to_pm'
                WHEN b.status = 'received' THEN 'received_by_pm'
                ELSE b.status END::text,
           CASE WHEN b.status = 'received' THEN b.received_at
                WHEN b.status = 'verified' THEN b.verified_at
                ELSE m.created_at END,
           NULLIF(concat_ws(' · ', m.notes, b.damage_reason, b.pm_posting), '')::text
      FROM container_movements m
      LEFT JOIN qc_jug_batches b ON b.factory_id = m.factory_id AND b.reference = m.reference AND b.collected
      LEFT JOIN sales_reps sr ON m.from_type = 'sales_rep' AND sr.id = m.from_id
      LEFT JOIN customers c ON m.from_type = 'customer' AND c.id = m.from_id
     WHERE m.factory_id = p_factory AND m.source = 'return'
       AND m.from_type IN ('sales_rep', 'customer', 'walk_in')
       AND m.container_type_id IN (SELECT id FROM jt)
       AND (public._jug_day(m.created_at) BETWEEN p_from AND p_to OR b.status IN ('accepted', 'verified'))
       AND NOT EXISTS (SELECT 1 FROM jug_returns j WHERE j.factory_id = m.factory_id AND j.reference = m.reference)
  )
  SELECT l.id, l.reference, l.day, l.ht, l.hid, COALESCE(l.name, '(unknown)'), l.kind, l.recorded, l.counted,
         l.good, l.damaged, l.stage, l.stage_at, l.notes
    FROM lines l
   ORDER BY l.day DESC, l.reference DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_jug_collection_lines(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_jug_collection_lines(uuid, date, date) TO authenticated;

-- ---------------------------------------------------------------- overview + QC and PM
-- As 20261031160000, plus at_qc and at_production (new columns, so dropped first).
DROP FUNCTION IF EXISTS public.jug_overview(uuid, date, date);
CREATE FUNCTION public.jug_overview(p_factory uuid, p_from date, p_to date)
RETURNS TABLE (
  container_type_id uuid, container_name text,
  in_circulation numeric, in_warehouse numeric, filled_in_warehouse numeric, empty_in_warehouse numeric,
  with_marketers numeric, full_with_marketers numeric, with_customers numeric, written_off_total numeric,
  pending_returns numeric, produced_approved numeric, issued numeric, sold_with_water numeric,
  empties_sold numeric, refills_sold numeric, received numeric, empties_value numeric, written_off numeric,
  at_qc numeric, at_production numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._jug_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH bal AS (
    SELECT b.container_type_id AS type_id, b.holder_type, SUM(b.balance) AS qty
      FROM container_balances b WHERE b.factory_id = p_factory GROUP BY 1, 2
  ), per AS (
    SELECT ct.id AS type_id, ct.name,
           COALESCE((SELECT SUM(qty) FROM bal WHERE type_id = ct.id AND holder_type <> 'external'), 0) AS circ,
           COALESCE((SELECT qty FROM bal WHERE type_id = ct.id AND holder_type = 'warehouse'), 0) AS wh,
           COALESCE((SELECT SUM(p.current_stock * pc.quantity_per_unit) FROM product_containers pc
                      JOIN products p ON p.id = pc.product_id
                     WHERE pc.container_type_id = ct.id AND COALESCE(pc.jug_role, 'with_water') <> 'empty'), 0) AS filled,
           COALESCE((SELECT qty FROM bal WHERE type_id = ct.id AND holder_type = 'sales_rep'), 0) AS reps,
           COALESCE((SELECT SUM(rs.quantity * pc.quantity_per_unit) FROM rep_stock rs
                      JOIN product_containers pc ON pc.product_id = rs.product_id AND pc.container_type_id = ct.id
                     WHERE rs.factory_id = p_factory AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
                       AND rs.quantity > 0), 0) AS reps_full,
           COALESCE((SELECT SUM(qty) FROM bal WHERE type_id = ct.id AND holder_type IN ('customer', 'walk_in')), 0) AS cust,
           COALESCE((SELECT SUM(m.quantity) FROM container_movements m
                      WHERE m.container_type_id = ct.id AND m.to_type = 'external' AND m.source <> 'jar_sold'), 0)
             - COALESCE((SELECT SUM(m.quantity) FROM container_movements m
                          WHERE m.container_type_id = ct.id AND m.from_type = 'external'
                            AND m.source NOT IN ('purchase', 'jar_sold_reversal', 'customer_return')), 0) AS wo_total,
           COALESCE((SELECT SUM(j.quantity_claimed) FROM jug_returns j
                      WHERE j.container_type_id = ct.id AND j.status = 'pending'), 0) AS pend,
           COALESCE((SELECT SUM(pr.accepted_quantity * pc.quantity_per_unit) FROM production_releases pr
                      JOIN product_containers pc ON pc.product_id = pr.product_id AND pc.container_type_id = ct.id
                     WHERE pr.factory_id = p_factory AND pr.status = 'accepted'
                       AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
                       AND public._jug_day(COALESCE(pr.accepted_at, pr.created_at)) BETWEEN p_from AND p_to), 0) AS produced,
           COALESCE((SELECT qty FROM bal WHERE type_id = ct.id AND holder_type = 'qc'), 0) AS qc,
           COALESCE((SELECT qty FROM bal WHERE type_id = ct.id AND holder_type = 'production'), 0) AS prod
      FROM container_types ct WHERE ct.factory_id = p_factory
  ), act AS (
    SELECT r.container_type_id AS type_id,
           SUM(r.loaded) AS issued, SUM(r.jug_water_sold) AS jw, SUM(r.empties_sold) AS es,
           SUM(r.refills_sold) AS refills, SUM(r.received) AS rcv, SUM(r.empties_value) AS ev, SUM(r.written_off) AS wo
      FROM public.jug_accountability_report(p_factory, p_from, p_to, NULL) r
     GROUP BY 1
  )
  SELECT per.type_id, per.name, per.circ, per.wh, per.filled, per.wh - per.filled, per.reps, per.reps_full,
         per.cust, per.wo_total, per.pend, per.produced,
         COALESCE(act.issued, 0), COALESCE(act.jw, 0), COALESCE(act.es, 0), COALESCE(act.refills, 0),
         COALESCE(act.rcv, 0), COALESCE(act.ev, 0), COALESCE(act.wo, 0), per.qc, per.prod
    FROM per LEFT JOIN act ON act.type_id = per.type_id
   ORDER BY per.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_overview(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_overview(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
