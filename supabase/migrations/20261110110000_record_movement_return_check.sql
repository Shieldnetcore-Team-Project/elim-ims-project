-- ============================================================================
-- Record movement: "Empties returned" can't exceed what the person holds
-- ----------------------------------------------------------------------------
-- User (2026-11-10): QC -> Dispenser -> Record movement took empties back from
-- anyone in any quantity, which is how minus figures appeared on "Who is
-- holding dispensers". The normal Warehouse return and the QC count already
-- refuse more than is held; this applies the same limit here:
--   a customer   jugs held, less returns still waiting for the QC count
--   a marketer / the shop   the same, less the full dispensers on their stock
-- Old and New Jug count as one, as on the screen. Other container types keep
-- their own figure. Walk-in has no per-person figure, so it isn't limited.
-- Someone who really held more gets an opening balance first (Record movement
-- -> Issue containers). Body otherwise as 20261104160000.
--
-- Paste into the SQL Editor only AFTER the held marketers' returns are entered
-- (20261110100000): until then they are below 0 and this would refuse them.
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
  v_name text;
  v_is_jug boolean;
  v_can_return numeric;
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

  -- Never more back than they hold (the row locks serialise two at once).
  IF v_kind = 'return' AND v_holder_id IS NOT NULL THEN
    IF v_holder_type = 'customer' THEN
      SELECT c.name::text INTO v_name FROM customers c WHERE c.id = v_holder_id FOR UPDATE;
    ELSE
      SELECT r.full_name::text INTO v_name FROM sales_reps r WHERE r.id = v_holder_id FOR UPDATE;
    END IF;
    v_is_jug := EXISTS (SELECT 1 FROM container_types ct WHERE ct.id = v_type AND ct.name ~* 'jug|dispenser');
    SELECT COALESCE(SUM(
             CASE WHEN v_holder_type = 'customer' THEN public._jug_customer_balance(v_holder_id, ct.id)
                  ELSE public._jug_rep_balance(v_holder_id, ct.id) - public._jug_rep_full(v_holder_id, ct.id) END
             - COALESCE((SELECT SUM(j.quantity_claimed) FROM jug_returns j
                          WHERE j.status = 'pending' AND j.container_type_id = ct.id
                            AND ((v_holder_type = 'customer' AND j.customer_id = v_holder_id)
                              OR (v_holder_type = 'sales_rep' AND j.sales_rep_id = v_holder_id))), 0)), 0)
      INTO v_can_return
      FROM container_types ct
     WHERE ct.factory_id = v_factory
       AND (ct.id = v_type OR (v_is_jug AND ct.name ~* 'jug|dispenser'));
    IF v_qty > GREATEST(v_can_return, 0) THEN
      RAISE EXCEPTION '% can return at most % -- record an opening balance first (Issue containers) if they really held more',
        v_name, trim_scale(GREATEST(v_can_return, 0));
    END IF;
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

NOTIFY pgrst, 'reload schema';
