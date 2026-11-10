-- ============================================================================
-- QC -> Jugs collected: what came back from each marketer, distributor and
-- the shop, where it is now, and who still holds jugs
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "in the quality control page, lets have a page or a tab
-- where we can see what was collected from each marketer -- all recorded old
-- jugs from marketers, distributors and retail -- so that we can see all jugs
-- with quality control until she posts them to PM, and also know who has not
-- returned their jugs".
--
-- Read-only. Old and New Dispenser Jug count as one (never split on screen).
--
-- qc_jug_collections(factory, from, to)  one row per marketer / the shop /
--   customer (distributor, office delivery) / walk-in:
--     collected        empties back in the period (QC-counted returns and
--                      Record movement "Empties returned")
--     awaiting_count   recorded by the Warehouse, QC has not counted yet
--     at_qc            counted by QC, not yet verified / posted to the PM
--     posted_to_pm     verified good, the PM has not confirmed yet
--     received_by_pm   the PM confirmed in the period
--     damaged          verified damaged in the period
--     full_with_them   of those, dispensers still full on a marketer's / the
--                      shop's stock (until Accounts record the sale)
--     not_returned     every jug they still hold, full or empty, less returns
--                      waiting for the QC count -- owed back, now
--     last_collected   the last day anything came back from them
-- qc_jug_collection_lines(factory, from, to)  every collection with its stage:
--   awaiting_count, at_qc, posted_to_pm, received_by_pm, none_counted,
--   cancelled, or direct (Record movement -- booked without a QC count).
--   Open ones (awaiting_count / at_qc / posted_to_pm) show whatever the dates.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._qc_jug_collections_can_view(p_factory uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (public._jug_can_view()
          OR public._qc_jug_can_view()
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key))
     AND public._works_in_factory(auth.uid(), p_factory);
$$;
REVOKE ALL ON FUNCTION public._qc_jug_collections_can_view(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._qc_jug_collections_can_view(uuid) TO authenticated;

-- ---------------------------------------------------------------- per party
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
    SELECT CASE WHEN j.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'customer' END AS ht,
           COALESCE(j.sales_rep_id, j.customer_id) AS hid,
           SUM(b.quantity_accepted) FILTER (WHERE b.status = 'accepted') AS at_qc,
           SUM(b.quantity_good) FILTER (WHERE b.status = 'verified') AS posted,
           SUM(b.quantity_good) FILTER (WHERE b.status = 'received'
                                          AND public._jug_day(b.received_at) BETWEEN p_from AND p_to) AS recv,
           SUM(b.quantity_damaged) FILTER (WHERE b.status IN ('verified', 'received')
                                             AND public._jug_day(b.verified_at) BETWEEN p_from AND p_to) AS dmg
      FROM qc_jug_batches b
      JOIN jug_returns j ON j.id = b.jug_return_id
     WHERE b.factory_id = p_factory AND j.container_type_id IN (SELECT id FROM jt)
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

-- ---------------------------------------------------------------- each collection
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
    -- Recorded by the Warehouse, counted by QC, then verified and posted to the PM.
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
           NULLIF(concat_ws(' · ', j.notes, j.verify_note, b.damage_reason), '')::text AS notes
      FROM jug_returns j
      LEFT JOIN qc_jug_batches b ON b.jug_return_id = j.id AND b.status <> 'cancelled'
      LEFT JOIN sales_reps sr ON sr.id = j.sales_rep_id
      LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.factory_id = p_factory AND j.container_type_id IN (SELECT id FROM jt)
       AND (public._jug_day(j.recorded_at) BETWEEN p_from AND p_to
            OR j.status = 'pending' OR b.status IN ('accepted', 'verified'))
    UNION ALL
    -- Booked straight back with Record movement: no QC count, no PM step.
    SELECT m.id, COALESCE(m.reference, 'Record movement')::text, public._jug_day(m.created_at),
           m.from_type::text, m.from_id,
           CASE m.from_type WHEN 'walk_in' THEN 'Walk-in customers' ELSE COALESCE(sr.full_name, c.name) END::text,
           CASE m.from_type WHEN 'sales_rep' THEN COALESCE(sr.kind, 'rep') WHEN 'customer' THEN 'customer'
                ELSE 'walk_in' END::text,
           m.quantity, m.quantity, NULL::numeric, NULL::numeric, 'direct'::text, m.created_at, m.notes::text
      FROM container_movements m
      LEFT JOIN sales_reps sr ON m.from_type = 'sales_rep' AND sr.id = m.from_id
      LEFT JOIN customers c ON m.from_type = 'customer' AND c.id = m.from_id
     WHERE m.factory_id = p_factory AND m.source = 'return'
       AND m.from_type IN ('sales_rep', 'customer', 'walk_in')
       AND m.container_type_id IN (SELECT id FROM jt)
       AND public._jug_day(m.created_at) BETWEEN p_from AND p_to
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

NOTIFY pgrst, 'reload schema';
