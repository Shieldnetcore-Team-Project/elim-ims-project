-- ============================================================================
-- QC jug verification: Old Jug and New Jug
-- ----------------------------------------------------------------------------
-- Dispenser jugs, kept apart as "Old Jug" and "New Jug", go
--   Warehouse --send--> Quality Control --accept (count)--> verify -->
--     good ones posted to the Production Manager (who confirms receipt),
--     damaged ones recorded by QC with a reason.
--
-- One row per consignment (qc_jug_batches) moves through:
--   sent        Warehouse sent it; QC has not counted it yet
--   accepted    QC counted it in (quantity_accepted; a shortfall needs a note)
--   verified    QC split it into good + damaged (= accepted); the good ones
--               are posted to the PM
--   received    the PM confirmed the good ones arrived
--   cancelled   withdrawn by the Warehouse before QC accepted it
-- Each step is done by a different person from the one before it where it
-- matters: whoever sent a consignment cannot accept it.
--
-- The QC register (per jug and day) is worked out from these rows:
--   Balance b/f  jugs at QC before the day (accepted − verified)
--   Qty in       accepted that day         Total = b/f + in
--   Good to PM / Damaged / Qty out (= good + damaged), verified that day
--   Balance      total − out, the next day's b/f
--
-- Rights:
--   send / cancel a send   finished-goods create / submit or distribution create (Warehouse)
--   accept / verify        goods-receiving submit (Quality Control)
--   confirm receipt        production submit / create (Production Manager)
--   view                   any of goods-receiving / finished-goods / production view
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.qc_jug_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  client_ref uuid UNIQUE,
  jug_kind text NOT NULL CHECK (jug_kind IN ('old', 'new')),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'verified', 'received', 'cancelled')),
  quantity_sent numeric(14,3) NOT NULL CHECK (quantity_sent > 0 AND quantity_sent = trunc(quantity_sent)),
  send_notes text,
  sent_by uuid NOT NULL REFERENCES auth.users(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  quantity_accepted numeric(14,3) CHECK (quantity_accepted IS NULL OR (quantity_accepted >= 0 AND quantity_accepted = trunc(quantity_accepted))),
  accept_note text,
  accepted_by uuid REFERENCES auth.users(id),
  accepted_at timestamptz,
  quantity_good numeric(14,3) CHECK (quantity_good IS NULL OR (quantity_good >= 0 AND quantity_good = trunc(quantity_good))),
  quantity_damaged numeric(14,3) CHECK (quantity_damaged IS NULL OR (quantity_damaged >= 0 AND quantity_damaged = trunc(quantity_damaged))),
  damage_reason text,
  verified_by uuid REFERENCES auth.users(id),
  verified_at timestamptz,
  received_by uuid REFERENCES auth.users(id),
  received_at timestamptz,
  receive_note text,
  cancelled_by uuid REFERENCES auth.users(id),
  cancelled_at timestamptz,
  cancel_reason text,
  CHECK (quantity_accepted IS NULL OR quantity_accepted <= quantity_sent),
  CHECK (quantity_good IS NULL OR quantity_good + quantity_damaged = quantity_accepted),
  CHECK ((status IN ('accepted', 'verified', 'received')) = (accepted_at IS NOT NULL)),
  CHECK ((status IN ('verified', 'received')) = (verified_at IS NOT NULL)),
  CHECK ((status = 'received') = (received_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS qc_jug_batches_open_idx ON public.qc_jug_batches (factory_id, status);

CREATE OR REPLACE FUNCTION public._qc_jug_day(p timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE AS $$ SELECT (p AT TIME ZONE 'Africa/Lagos')::date; $$;

CREATE OR REPLACE FUNCTION public._qc_jug_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key);
$$;

ALTER TABLE public.qc_jug_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "qc jug batches read" ON public.qc_jug_batches;
CREATE POLICY "qc jug batches read" ON public.qc_jug_batches FOR SELECT TO authenticated
  USING (public._qc_jug_can_view());
REVOKE ALL ON public.qc_jug_batches FROM anon, authenticated;
GRANT SELECT ON public.qc_jug_batches TO authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'qc_jug_batches') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.qc_jug_batches;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._qc_jug_audit(p_factory uuid, p_action text, p_id uuid, p_value jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), p_factory, p_action, 'qc_jug_batches', p_id::text, p_value);
$$;
REVOKE ALL ON FUNCTION public._qc_jug_audit(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 1. send
CREATE OR REPLACE FUNCTION public.send_jugs_to_qc(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_kind text := NULLIF(payload->>'jug_kind', '');
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_existing qc_jug_batches%ROWTYPE;
  v_ref text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'finished-goods'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'finished-goods'::module_key, 'submit'::action_key)
          OR public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM qc_jug_batches WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  IF v_factory IS NULL OR NOT EXISTS (SELECT 1 FROM factories WHERE id = v_factory) THEN
    RAISE EXCEPTION 'factory_id required';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('old', 'new') THEN RAISE EXCEPTION 'Choose Old Jug or New Jug'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN
    RAISE EXCEPTION 'Enter a whole number of jugs above 0';
  END IF;
  v_ref := 'JQC-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-' || lpad((floor(random() * 99999))::int::text, 5, '0');
  INSERT INTO qc_jug_batches (factory_id, reference, client_ref, jug_kind, quantity_sent, send_notes, sent_by)
  VALUES (v_factory, v_ref, v_client, v_kind, v_qty, v_notes, v_uid)
  RETURNING id INTO v_id;
  PERFORM public._qc_jug_audit(v_factory, 'send_jugs_to_qc', v_id, payload);
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.send_jugs_to_qc(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_jugs_to_qc(jsonb) TO authenticated;

-- Withdrawn by the Warehouse before QC has counted it.
CREATE OR REPLACE FUNCTION public.cancel_jugs_to_qc(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_b qc_jug_batches%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'create'::action_key)
          OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'submit'::action_key)
          OR public.has_permission(auth.uid(), 'distribution'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason for cancelling'; END IF;
  SELECT * INTO v_b FROM qc_jug_batches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consignment not found'; END IF;
  IF v_b.status <> 'sent' THEN RAISE EXCEPTION 'QC has already accepted % -- it can no longer be cancelled', v_b.reference; END IF;
  UPDATE qc_jug_batches SET status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._qc_jug_audit(v_b.factory_id, 'cancel_jugs_to_qc', p_id, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'reference', v_b.reference);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_jugs_to_qc(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_jugs_to_qc(uuid, text) TO authenticated;

-- ---------------------------------------------------------------- 2. accept
-- QC counts what arrived. Fewer than sent needs a note; more is refused.
CREATE OR REPLACE FUNCTION public.accept_qc_jugs(p_id uuid, p_quantity numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_b qc_jug_batches%ROWTYPE;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_b FROM qc_jug_batches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consignment not found'; END IF;
  IF v_b.status <> 'sent' THEN RAISE EXCEPTION '% is not waiting to be accepted', v_b.reference; END IF;
  IF v_b.sent_by = auth.uid() THEN RAISE EXCEPTION 'You sent these jugs -- another person in QC must accept them'; END IF;
  IF p_quantity IS NULL OR p_quantity < 0 OR p_quantity <> trunc(p_quantity) THEN
    RAISE EXCEPTION 'Enter the whole number of jugs counted';
  END IF;
  IF p_quantity > v_b.quantity_sent THEN
    RAISE EXCEPTION 'Counted % but only % were sent -- ask the Warehouse to send the rest separately', trim_scale(p_quantity), trim_scale(v_b.quantity_sent);
  END IF;
  IF p_quantity < v_b.quantity_sent AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Explain why fewer jugs arrived than were sent';
  END IF;
  UPDATE qc_jug_batches
     SET status = 'accepted', quantity_accepted = p_quantity, accept_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
         accepted_by = auth.uid(), accepted_at = now()
   WHERE id = p_id;
  PERFORM public._qc_jug_audit(v_b.factory_id, 'accept_qc_jugs', p_id,
          jsonb_build_object('sent', v_b.quantity_sent, 'accepted', p_quantity, 'note', p_note));
  RETURN jsonb_build_object('id', p_id, 'reference', v_b.reference, 'accepted', p_quantity,
                            'short', v_b.quantity_sent - p_quantity);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_qc_jugs(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_qc_jugs(uuid, numeric, text) TO authenticated;

-- ---------------------------------------------------------------- 3. verify
-- QC splits the accepted jugs into good (posted to the PM) and damaged.
CREATE OR REPLACE FUNCTION public.verify_qc_jugs(p_id uuid, p_good numeric, p_damaged numeric, p_damage_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_b qc_jug_batches%ROWTYPE;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_b FROM qc_jug_batches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consignment not found'; END IF;
  IF v_b.status <> 'accepted' THEN RAISE EXCEPTION '% is not waiting for verification', v_b.reference; END IF;
  IF p_good IS NULL OR p_damaged IS NULL OR p_good < 0 OR p_damaged < 0
     OR p_good <> trunc(p_good) OR p_damaged <> trunc(p_damaged) THEN
    RAISE EXCEPTION 'Enter whole numbers of good and damaged jugs';
  END IF;
  IF p_good + p_damaged <> v_b.quantity_accepted THEN
    RAISE EXCEPTION 'Good (%) + damaged (%) must equal the % jugs accepted', trim_scale(p_good), trim_scale(p_damaged), trim_scale(v_b.quantity_accepted);
  END IF;
  IF p_damaged > 0 AND NULLIF(btrim(COALESCE(p_damage_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Record what is wrong with the damaged jugs';
  END IF;
  UPDATE qc_jug_batches
     SET status = 'verified', quantity_good = p_good, quantity_damaged = p_damaged,
         damage_reason = NULLIF(btrim(COALESCE(p_damage_reason, '')), ''),
         verified_by = auth.uid(), verified_at = now()
   WHERE id = p_id;
  PERFORM public._qc_jug_audit(v_b.factory_id, 'verify_qc_jugs', p_id,
          jsonb_build_object('good', p_good, 'damaged', p_damaged, 'reason', p_damage_reason));
  RETURN jsonb_build_object('id', p_id, 'reference', v_b.reference, 'good', p_good, 'damaged', p_damaged);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_qc_jugs(uuid, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_qc_jugs(uuid, numeric, numeric, text) TO authenticated;

-- ---------------------------------------------------------------- 4. PM receives
CREATE OR REPLACE FUNCTION public.receive_qc_jugs(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_b qc_jug_batches%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'production'::module_key, 'submit'::action_key)
          OR public.has_permission(auth.uid(), 'production'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_b FROM qc_jug_batches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consignment not found'; END IF;
  IF v_b.status <> 'verified' THEN RAISE EXCEPTION '% is not waiting for the Production Manager', v_b.reference; END IF;
  IF v_b.quantity_good = 0 THEN RAISE EXCEPTION 'No good jugs were posted on %', v_b.reference; END IF;
  UPDATE qc_jug_batches
     SET status = 'received', received_by = auth.uid(), received_at = now(),
         receive_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_id;
  PERFORM public._qc_jug_audit(v_b.factory_id, 'receive_qc_jugs', p_id, jsonb_build_object('good', v_b.quantity_good, 'note', p_note));
  RETURN jsonb_build_object('id', p_id, 'reference', v_b.reference, 'good', v_b.quantity_good);
END;
$$;
REVOKE ALL ON FUNCTION public.receive_qc_jugs(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_qc_jugs(uuid, text) TO authenticated;

-- ---------------------------------------------------------------- 5. register
-- One row per jug and day in the range that has activity or jugs at QC.
CREATE OR REPLACE FUNCTION public.qc_jug_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE (
  report_date date, jug_kind text, jug_name text, balance_bf numeric, quantity_in numeric,
  total numeric, quantity_good numeric, quantity_damaged numeric, quantity_out numeric, balance numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to < p_from THEN RAISE EXCEPTION 'The end date is before the start date'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;
  RETURN QUERY
  WITH kinds(k, nm, ord) AS (VALUES ('old', 'Old Jug', 1), ('new', 'New Jug', 2)),
  days AS (SELECT g::date AS d FROM generate_series(p_from, p_to, interval '1 day') g),
  ev AS (
    SELECT b.jug_kind AS k, public._qc_jug_day(b.accepted_at) AS d, b.quantity_accepted AS qi,
           0::numeric AS qg, 0::numeric AS qd
      FROM qc_jug_batches b
     WHERE b.factory_id = p_factory AND b.accepted_at IS NOT NULL AND public._qc_jug_day(b.accepted_at) <= p_to
    UNION ALL
    SELECT b.jug_kind, public._qc_jug_day(b.verified_at), 0, b.quantity_good, b.quantity_damaged
      FROM qc_jug_batches b
     WHERE b.factory_id = p_factory AND b.verified_at IS NOT NULL AND public._qc_jug_day(b.verified_at) <= p_to
  ), e AS (
    SELECT k, d, SUM(qi) AS qi, SUM(qg) AS qg, SUM(qd) AS qd FROM ev GROUP BY 1, 2
  ), grid AS (
    SELECT dy.d, kd.k, kd.nm, kd.ord,
           COALESCE((SELECT SUM(x.qi - x.qg - x.qd) FROM e x WHERE x.k = kd.k AND x.d < dy.d), 0) AS bf,
           COALESCE(t.qi, 0) AS qi, COALESCE(t.qg, 0) AS qg, COALESCE(t.qd, 0) AS qd
      FROM days dy CROSS JOIN kinds kd
      LEFT JOIN e t ON t.k = kd.k AND t.d = dy.d
  )
  SELECT g.d, g.k, g.nm, g.bf, g.qi, g.bf + g.qi, g.qg, g.qd, g.qg + g.qd, g.bf + g.qi - g.qg - g.qd
    FROM grid g
   WHERE g.bf <> 0 OR g.qi <> 0 OR g.qg <> 0 OR g.qd <> 0
   ORDER BY g.d, g.ord;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_jug_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_jug_report(uuid, date, date) TO authenticated;
