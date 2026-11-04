-- ============================================================================
-- Record movement takes a date; Abiodun's 5 Old Jugs loaded
-- ----------------------------------------------------------------------------
-- User (2026-11-04):
--  1. "add date on return qc - dispensers - record container movement to
--     enable back-dating returning of jugs": record_container_movement takes
--     payload.movement_date (a day, not in the future); the move is dated
--     noon (Lagos) that day, so the Jugs posted & returned report and the
--     day's figures put it on the right day. Body otherwise as
--     20260928140000.
--  2. "add 5 jugs for abiodun loaded, he has return his 5 now, so that he will
--     not be having -5 on his outstanding": Abiodun (SR-01) returned 5 Old
--     Jugs that were never recorded going out to him (given before tracking
--     started). 5 Old Jugs are recorded as issued to him (loaded) the day
--     before his first return, so loaded 5, received 5, outstanding 0. If
--     20261104140000 already brought him to 0 with a 'count', that count is
--     taken back off, so he is not counted twice. Runs once.
-- ============================================================================

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
          v_kind, NULLIF(btrim(COALESCE(payload->>'reference', '')), ''), v_notes, v_uid, v_at)
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

-- ---------------------------------------------------------------- Abiodun
DO $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_n int;
  v_type uuid;
  v_first timestamptz;
  v_count numeric;
BEGIN
  v_n := (SELECT count(*) FROM sales_reps WHERE kind = 'rep'
           AND (full_name ILIKE '%abiodun%' OR full_name ILIKE 'biodun%' OR code = 'SR-01'));
  IF v_n <> 1 THEN
    RAISE NOTICE 'Abiodun skipped: % marketers match -- record the 5 Old Jugs on QC -> Dispenser -> Record movement (Issue)', v_n;
    RETURN;
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE kind = 'rep'
     AND (full_name ILIKE '%abiodun%' OR full_name ILIKE 'biodun%' OR code = 'SR-01');
  v_type := public._jug_type_for_kind(v_rep.factory_id, 'old');
  IF v_type IS NULL THEN RAISE NOTICE 'Abiodun skipped: no Old Jug type'; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM container_movements WHERE reference = 'OPENING-SR01-OLD') THEN
    RAISE NOTICE 'Abiodun: already done'; RETURN;
  END IF;

  -- The day before his first Old Jug came back.
  SELECT min(created_at) INTO v_first FROM container_movements
   WHERE container_type_id = v_type AND from_type = 'sales_rep' AND from_id = v_rep.id
     AND source IN ('return', 'rep_return');
  v_first := COALESCE(v_first, now());

  INSERT INTO container_movements(factory_id, container_type_id, from_type, to_type, to_id, quantity, source,
                                  reference, notes, created_at)
  VALUES (v_rep.factory_id, v_type, 'external', 'sales_rep', v_rep.id, 5, 'issue', 'OPENING-SR01-OLD',
          '5 Old Jugs he held before tracking started (loaded, 2026-11-04)',
          ((public._jug_day(v_first) - 1)::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Lagos');

  -- Undo the 'count' 20261104140000 gave him for the same jugs, if any.
  SELECT COALESCE(SUM(quantity), 0) INTO v_count FROM container_movements
   WHERE container_type_id = v_type AND source = 'count' AND to_type = 'sales_rep' AND to_id = v_rep.id;
  IF v_count > 0 THEN
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, quantity, source,
                                    reference, notes)
    VALUES (v_rep.factory_id, v_type, 'sales_rep', v_rep.id, 'external', LEAST(v_count, 5), 'count',
            'OPENING-SR01-OLD', 'Replaced by the 5 Old Jugs recorded as loaded');
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_rep.factory_id, 'jug_opening_balance', 'sales_reps', v_rep.id::text,
          jsonb_build_object('who', v_rep.full_name, 'jug', 'Old Jug', 'loaded', 5,
                             'reason', 'Returned 5 he held before tracking started'));
  RAISE NOTICE '%: 5 Old Jugs recorded as loaded -- outstanding 0', v_rep.full_name;
END $$;

NOTIFY pgrst, 'reload schema';
