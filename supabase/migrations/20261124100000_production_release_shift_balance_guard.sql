-- A release dated to an earlier production day must be covered by stock
-- available by that day and shift, not by later production currently in the hall.
CREATE OR REPLACE FUNCTION public._production_hall_available_at_shift(
  p_factory uuid, p_product uuid, p_day date, p_shift text)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH opening AS (
    SELECT h.opening_date, h.quantity, h.created_at
      FROM production_hall_openings h
     WHERE h.factory_id = p_factory AND h.product_id = p_product
     ORDER BY h.opening_date DESC
     LIMIT 1
  ), events AS (
    SELECT GREATEST(
             p.production_date,
             COALESCE((SELECT max(h.opening_date)
                         FROM production_hall_openings h
                        WHERE h.factory_id = p_factory AND h.product_id = p_product
                          AND h.opening_date <= p_day AND h.created_at < p.created_at),
                      p.production_date)
           ) AS event_date,
           COALESCE(p.shift, 'day') AS event_shift,
           p.quantity_produced - COALESCE(p.damaged_quantity, 0) AS delta
      FROM production p
     WHERE p.factory_id = p_factory AND p.product_id = p_product
       AND p.status::text = 'pending_confirmation'
       AND (NOT EXISTS (SELECT 1 FROM opening)
            OR p.production_date >= (SELECT opening_date FROM opening)
            OR p.created_at > (SELECT created_at FROM opening)
            OR p.production_date >= p_day)
    UNION ALL
    SELECT COALESCE(r.production_date, (r.released_at AT TIME ZONE 'Africa/Lagos')::date),
           COALESCE(r.shift, public._production_shift_at(r.released_at)),
           -r.quantity
      FROM production_releases r
     WHERE r.factory_id = p_factory AND r.product_id = p_product
       AND r.status IN ('pending', 'accepted')
       AND (NOT EXISTS (SELECT 1 FROM opening)
            OR COALESCE(r.production_date, (r.released_at AT TIME ZONE 'Africa/Lagos')::date)
                 >= (SELECT opening_date FROM opening))
    UNION ALL
    SELECT (c.cleared_at AT TIME ZONE 'Africa/Lagos')::date,
           public._production_shift_at(c.cleared_at),
           -c.quantity
      FROM production_hall_clearances c
     WHERE c.factory_id = p_factory AND c.product_id = p_product
       AND (NOT EXISTS (SELECT 1 FROM opening)
            OR (c.cleared_at AT TIME ZONE 'Africa/Lagos')::date
                 >= (SELECT opening_date FROM opening))
  )
  SELECT COALESCE((SELECT quantity FROM opening), 0)
       + COALESCE((
           SELECT sum(e.delta)
             FROM events e
            WHERE e.event_date < p_day
               OR (e.event_date = p_day
                   AND CASE e.event_shift
                         WHEN 'day' THEN 1
                         WHEN 'night' THEN 2
                         WHEN 'overtime' THEN 3
                         ELSE 0
                       END
                       <= CASE p_shift
                            WHEN 'day' THEN 1
                            WHEN 'night' THEN 2
                            WHEN 'overtime' THEN 3
                            ELSE 0
                          END)
         ), 0);
$$;
REVOKE ALL ON FUNCTION public._production_hall_available_at_shift(uuid, uuid, date, text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.release_to_warehouse(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_request uuid := NULLIF(payload->>'production_request_id', '')::uuid;
  v_notes text := NULLIF(btrim(payload->>'notes'), '');
  v_name text := NULLIF(btrim(payload->>'released_by_name'), '');
  v_today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  v_day date := COALESCE(NULLIF(payload->>'production_date', '')::date, v_today);
  v_shift text := COALESCE(NULLIF(payload->>'shift', ''), public._production_shift_at(now()));
  v_open date;
  v_unit text;
  v_available numeric;
  v_shift_available numeric;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'production'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'production'::module_key, 'submit'::action_key)
          OR public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL OR v_product IS NULL THEN RAISE EXCEPTION 'factory_id and product_id are required'; END IF;
  IF NOT public.has_production_scope_access(v_uid, v_factory) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity to release must be > 0'; END IF;
  IF v_shift NOT IN ('day', 'night', 'overtime') THEN RAISE EXCEPTION 'Shift must be Day, Night or Over-Time'; END IF;
  -- Anything on a Sunday is Over-Time (20261109110000).
  IF extract(dow FROM v_day) = 0 THEN v_shift := 'overtime'; END IF;
  IF v_day > v_today THEN RAISE EXCEPTION 'A release cannot be dated after today'; END IF;
  IF v_day < v_today - 7 THEN
    RAISE EXCEPTION 'A release can be put on a production day up to 7 days back only';
  END IF;

  SELECT unit INTO v_unit FROM products WHERE id = v_product AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found in this factory'; END IF;
  IF v_request IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM production_requests WHERE id = v_request AND factory_id = v_factory
  ) THEN
    RAISE EXCEPTION 'Request not found in this factory';
  END IF;
  v_open := (SELECT max(opening_date) FROM production_hall_openings
              WHERE factory_id = v_factory AND product_id = v_product);
  IF v_open IS NOT NULL AND v_day < v_open THEN
    RAISE EXCEPTION 'The production hall opened at its opening balance on % -- a release cannot be dated before it',
      to_char(v_open, 'DD Mon YYYY');
  END IF;

  -- Serialize against other releases and production batches for this product.
  PERFORM pg_advisory_xact_lock(hashtext('production_hall:' || v_factory::text || ':' || v_product::text));
  v_shift_available := public._production_hall_available_at_shift(v_factory, v_product, v_day, v_shift);
  IF v_qty > v_shift_available THEN
    RAISE EXCEPTION 'Only % % was available in the production hall for the selected shift on %',
      v_shift_available, COALESCE(v_unit, ''), to_char(v_day, 'DD Mon YYYY');
  END IF;
  v_available := public._production_hall_available(v_factory, v_product);
  IF v_qty > v_available THEN
    RAISE EXCEPTION 'Only % % of this product is in the production hall', v_available, COALESCE(v_unit, '');
  END IF;

  v_number := 'REL-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  INSERT INTO production_releases (factory_id, release_number, product_id, quantity, unit,
                                   production_request_id, notes, released_by, released_by_name,
                                   production_date, shift)
  VALUES (v_factory, v_number, v_product, v_qty, v_unit, v_request, v_notes, v_uid,
          COALESCE(v_name, (SELECT full_name FROM profiles WHERE id = v_uid)), v_day, v_shift)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'release_to_warehouse', 'production_releases', v_id::text,
          jsonb_build_object('release_number', v_number, 'product_id', v_product, 'quantity', v_qty,
                             'production_date', v_day, 'shift', v_shift, 'late_entry', v_day < v_today));

  RETURN jsonb_build_object('id', v_id, 'release_number', v_number, 'in_hall_after', v_available - v_qty,
                            'production_date', v_day, 'shift', v_shift);
END;
$$;
REVOKE ALL ON FUNCTION public.release_to_warehouse(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_to_warehouse(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
