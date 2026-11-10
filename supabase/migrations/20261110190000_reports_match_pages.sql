-- ============================================================================
-- QC reports agree with the pages: jug "Returned" counts every return
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "the report for bottle and jug should be generated from
-- the pages ... so that all activities and transactions are accurate on the
-- report, no discrepancies".
-- jug_accountability_report (QC -> Reports -> Jugs posted & returned):
-- Returned counted only what the Warehouse recorded (jug_returns), while
-- Received counted every return on the ledger -- so QC's own Record movement
-- returns showed as Received but never as Returned. Returned now counts
-- those too. Otherwise as 20261031160000.
-- The new "Jugs collected" and "Jugs posted to PM" reports read the very
-- functions the pages use (qc_jug_collections, qc_pm_jug_postings), and the
-- Bottle report already reads the Good bottles records.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.jug_accountability_report(
  p_factory uuid, p_from date, p_to date, p_container_type uuid DEFAULT NULL
) RETURNS TABLE (
  report_date date, sales_rep_id uuid, rep_code text, rep_name text, rep_kind text,
  container_type_id uuid, container_name text,
  opening numeric, loaded numeric, total numeric, jug_water_sold numeric, refills_sold numeric,
  empties_sold numeric, empties_value numeric, returned numeric, pending_claims numeric,
  expected_empties numeric, received numeric, written_off numeric, outstanding numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._jug_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to < p_from THEN RAISE EXCEPTION 'The end date is before the start date'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT CASE WHEN m.to_type = 'sales_rep' THEN m.to_id ELSE m.from_id END AS rep_id,
           m.container_type_id AS type_id, public._jug_day(m.created_at) AS d, m.source,
           CASE WHEN m.to_type = 'sales_rep' THEN m.quantity ELSE -m.quantity END AS delta,
           m.quantity AS qty, pc.jug_role
      FROM container_movements m
      LEFT JOIN product_containers pc ON pc.product_id = m.product_id AND pc.container_type_id = m.container_type_id
     WHERE m.factory_id = p_factory
       AND (p_container_type IS NULL OR m.container_type_id = p_container_type)
       AND (m.to_type = 'sales_rep' OR m.from_type = 'sales_rep')
       AND public._jug_day(m.created_at) <= p_to
  ), opening AS (
    SELECT rep_id, type_id, SUM(delta) AS bal FROM mv WHERE d < p_from GROUP BY 1, 2
  ), day_mv AS (
    SELECT rep_id, type_id, d,
           SUM(CASE WHEN source IN ('dispatch', 'issue') THEN qty WHEN source = 'dispatch_reversal' THEN -qty ELSE 0 END) AS loaded,
           SUM(CASE WHEN source = 'sale' AND COALESCE(jug_role, 'with_water') <> 'empty' THEN qty
                    WHEN source = 'sale_reversal' AND COALESCE(jug_role, 'with_water') <> 'empty' THEN -qty
                    WHEN source = 'jar_sold' THEN qty WHEN source = 'jar_sold_reversal' THEN -qty
                    WHEN source = 'customer_return' THEN -qty ELSE 0 END) AS jw,
           SUM(CASE WHEN source = 'sale' AND jug_role = 'empty' THEN qty
                    WHEN source = 'sale_reversal' AND jug_role = 'empty' THEN -qty ELSE 0 END) AS es,
           SUM(CASE WHEN source IN ('return', 'rep_return') THEN qty WHEN source = 'rep_return_cancelled' THEN -qty ELSE 0 END) AS rcv,
           SUM(CASE WHEN source = 'lost' THEN qty ELSE 0 END) AS wo,
           SUM(delta) AS net
      FROM mv WHERE d BETWEEN p_from AND p_to GROUP BY 1, 2, 3
  ), claims AS (
    -- Returned = what the Warehouse recorded (counted or not yet) plus what
    -- QC entered herself with Record movement (2026-11-10), so Returned and
    -- Received agree once QC has counted.
    SELECT rep_id, type_id, d, SUM(claimed) AS claimed, SUM(pending) AS pending FROM (
      SELECT j.sales_rep_id AS rep_id, j.container_type_id AS type_id, public._jug_day(j.recorded_at) AS d,
             j.quantity_claimed AS claimed,
             CASE WHEN j.status = 'pending' THEN j.quantity_claimed END AS pending
        FROM jug_returns j
       WHERE j.factory_id = p_factory AND j.status <> 'cancelled' AND j.sales_rep_id IS NOT NULL
         AND (p_container_type IS NULL OR j.container_type_id = p_container_type)
         AND public._jug_day(j.recorded_at) BETWEEN p_from AND p_to
      UNION ALL
      SELECT m.from_id, m.container_type_id, public._jug_day(m.created_at), m.quantity, NULL::numeric
        FROM container_movements m
       WHERE m.factory_id = p_factory AND m.source = 'return' AND m.from_type = 'sales_rep'
         AND (p_container_type IS NULL OR m.container_type_id = p_container_type)
         AND public._jug_day(m.created_at) BETWEEN p_from AND p_to
         AND NOT EXISTS (SELECT 1 FROM jug_returns j WHERE j.factory_id = m.factory_id AND j.reference = m.reference)
    ) x
     GROUP BY 1, 2, 3
  ), sales_info AS (
    -- Refills (swaps) and the value of empty jugs sold, from posted invoices.
    SELECT s.sales_rep_id AS rep_id, pc.container_type_id AS type_id, public._jug_day(COALESCE(s.approved_at, s.created_at)) AS d,
           SUM(CASE WHEN pc.jug_role = 'refill' THEN si.quantity * pc.quantity_per_unit ELSE 0 END) AS refills,
           SUM(CASE WHEN pc.jug_role = 'empty' THEN si.line_total ELSE 0 END) AS empties_value
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN product_containers pc ON pc.product_id = si.product_id AND pc.jug_role IS NOT NULL
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NOT NULL AND s.status = 'posted' AND s.deleted_at IS NULL
       AND (p_container_type IS NULL OR pc.container_type_id = p_container_type)
       AND public._jug_day(COALESCE(s.approved_at, s.created_at)) BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3
  ), grid AS (
    SELECT r.id AS rep_id, ct.id AS type_id, g.d::date AS d
      FROM sales_reps r
      CROSS JOIN container_types ct
      CROSS JOIN generate_series(p_from, p_to, interval '1 day') g(d)
     WHERE r.factory_id = p_factory AND ct.factory_id = p_factory
       AND (p_container_type IS NULL OR ct.id = p_container_type)
  ), calc AS (
    SELECT g.d, g.rep_id, g.type_id,
           COALESCE(o.bal, 0)
             + COALESCE((SELECT SUM(x.net) FROM day_mv x
                          WHERE x.rep_id = g.rep_id AND x.type_id = g.type_id AND x.d < g.d), 0) AS opening,
           COALESCE(dm.loaded, 0) AS loaded, COALESCE(dm.jw, 0) AS jw, COALESCE(si.refills, 0) AS refills,
           COALESCE(dm.es, 0) AS es, COALESCE(si.empties_value, 0) AS ev,
           COALESCE(c.claimed, 0) AS claimed, COALESCE(c.pending, 0) AS pending,
           COALESCE(dm.rcv, 0) AS rcv, COALESCE(dm.wo, 0) AS wo,
           (dm.rep_id IS NOT NULL OR c.rep_id IS NOT NULL OR si.rep_id IS NOT NULL) AS active
      FROM grid g
      LEFT JOIN opening o ON o.rep_id = g.rep_id AND o.type_id = g.type_id
      LEFT JOIN day_mv dm ON dm.rep_id = g.rep_id AND dm.type_id = g.type_id AND dm.d = g.d
      LEFT JOIN claims c ON c.rep_id = g.rep_id AND c.type_id = g.type_id AND c.d = g.d
      LEFT JOIN sales_info si ON si.rep_id = g.rep_id AND si.type_id = g.type_id AND si.d = g.d
  )
  SELECT c.d, r.id, r.code, r.full_name, r.kind, ct.id, ct.name,
         c.opening, c.loaded, c.opening + c.loaded, c.jw, c.refills, c.es, c.ev, c.claimed, c.pending,
         c.opening + c.loaded - c.jw - c.es,
         c.rcv, c.wo,
         c.opening + c.loaded - c.jw - c.es - c.rcv - c.wo
    FROM calc c
    JOIN sales_reps r ON r.id = c.rep_id
    JOIN container_types ct ON ct.id = c.type_id
   WHERE c.active OR c.opening <> 0
   ORDER BY c.d, r.code, ct.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_accountability_report(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_accountability_report(uuid, date, date, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
