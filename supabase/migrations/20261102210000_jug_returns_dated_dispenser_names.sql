-- ============================================================================
-- Empty Dispenser Jug returns: dated, and the jugs named "Dispenser Jug"
-- ----------------------------------------------------------------------------
-- User (2026-11-02):
--   * "add date on the box so that user can return jug for the previous day"
--     -- record_jug_return takes payload.return_date (today or earlier): a
--     return for an earlier day is recorded at 5 p.m. that day, so it counts
--     on that day's jug report;
--   * "change the name from jug to Dispenser Jug" -- the jug types read
--     "Old Dispenser Jug" / "New Dispenser Jug" (QC still tells them apart by
--     "old" in the name).
-- record_jug_return is otherwise as 20261102150000.
-- ============================================================================

UPDATE public.container_types
   SET name = regexp_replace(name, '\mJug\M', 'Dispenser Jug')
 WHERE name ~* '\mjug\M' AND name !~* 'dispenser';

-- As 20261102150000, plus payload.return_date.
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
  v_name text;
  v_existing jug_returns%ROWTYPE;
  v_returnable numeric;
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
  -- An earlier day's return counts on that day (5 p.m. there).
  v_at := CASE WHEN v_date = v_today THEN now()
               ELSE (v_date + time '17:00') AT TIME ZONE 'Africa/Lagos' END;

  IF v_rep IS NOT NULL THEN
    -- Serialise claims per marketer so two at once cannot both pass the check.
    SELECT * INTO v_r FROM sales_reps WHERE id = v_rep FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
    v_factory := v_r.factory_id;
    v_name := v_r.full_name;
  ELSE
    SELECT * INTO v_c FROM customers WHERE id = v_customer FOR UPDATE;
    IF NOT FOUND OR v_c.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Customer not found'; END IF;
    v_factory := v_c.factory_id;
    v_name := v_c.name;
  END IF;
  IF NOT public._works_in_factory(v_uid, v_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = v_type AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Jug type not found for this factory';
  END IF;

  IF v_rep IS NOT NULL THEN
    v_returnable := public._jug_rep_balance(v_rep, v_type) - public._jug_rep_full(v_rep, v_type)
                  - COALESCE((SELECT SUM(quantity_claimed) FROM jug_returns
                               WHERE sales_rep_id = v_rep AND container_type_id = v_type AND status = 'pending'), 0);
  ELSE
    v_returnable := public._jug_customer_balance(v_customer, v_type)
                  - COALESCE((SELECT SUM(quantity_claimed) FROM jug_returns
                               WHERE customer_id = v_customer AND container_type_id = v_type AND status = 'pending'), 0);
  END IF;
  IF v_qty > GREATEST(v_returnable, 0) THEN
    RAISE EXCEPTION '% can return at most % empty jugs (the rest are full on their stock, already claimed, or not owed). Record a write-off or opening balance first if the figures are wrong.',
      v_name, trim_scale(GREATEST(v_returnable, 0));
  END IF;

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
