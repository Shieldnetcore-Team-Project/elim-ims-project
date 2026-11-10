-- ============================================================================
-- Accountant -> Dispensers: every dispenser / jug activity, QC's included
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "all dispenser should reflect here in the accountant
-- page, for the account to have records of all activities from the qc, and
-- all other dispenser activities".
--
-- Read only. Nothing here changes a balance.
--   * _qc_jug_collections_can_view also lets in whoever sees the dispenser
--     reports (Accounts), so qc_jug_collections / qc_jug_collection_lines
--     (jugs collected per marketer / distributor / shop) open on that page.
--   * accounts_jug_activity(factory, from, to) -> jsonb:
--       movements  every jug ledger movement of the period (supplied to
--                  marketers, sold, returned to QC, taken in / damaged at QC,
--                  QC -> Production, filled dispensers released, Store issues,
--                  counts), with readable From / To names
--       postings   every QC -> PM posting (open ones whatever the dates)
--       with_qc    jugs with QC now, not yet posted
-- ============================================================================

CREATE OR REPLACE FUNCTION public._qc_jug_collections_can_view(p_factory uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (public._jug_can_view()
          OR public._qc_jug_can_view()
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)
          OR public._dispenser_can_view())
     AND public._works_in_factory(auth.uid(), p_factory);
$$;
REVOKE ALL ON FUNCTION public._qc_jug_collections_can_view(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._qc_jug_collections_can_view(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.accounts_jug_activity(p_factory uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_moves jsonb;
  v_posts jsonb;
  v_with_qc numeric;
BEGIN
  IF NOT public._qc_jug_collections_can_view(p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;

  WITH jt AS (
    SELECT ct.id, ct.name FROM container_types ct
     WHERE ct.factory_id = p_factory AND ct.name ~* 'jug|dispenser'
  ), m AS (
    SELECT m.*, jt.name AS jug FROM container_movements m JOIN jt ON jt.id = m.container_type_id
     -- A plain time range (Lagos days) so the (container_type_id, created_at)
     -- index is used instead of reading the whole ledger (Disk IO).
     WHERE m.factory_id = p_factory
       AND m.created_at >= (p_from::timestamp AT TIME ZONE 'Africa/Lagos')
       AND m.created_at <  ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Lagos')
     ORDER BY m.seq DESC
     LIMIT 5000
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', m.id, 'at', m.created_at, 'day', public._jug_day(m.created_at),
           'jug', m.jug, 'source', m.source, 'quantity', m.quantity,
           'reference', m.reference, 'notes', m.notes,
           'from_type', m.from_type, 'to_type', m.to_type,
           'from_name', CASE m.from_type
                          WHEN 'sales_rep' THEN fr.full_name WHEN 'customer' THEN fc.name
                          WHEN 'walk_in' THEN 'Walk-in customers' WHEN 'warehouse' THEN 'Warehouse'
                          WHEN 'qc' THEN 'Quality Control' WHEN 'production' THEN 'Production'
                          WHEN 'store' THEN 'Store' WHEN 'external' THEN 'Outside'
                          ELSE m.from_type END,
           'from_kind', CASE m.from_type WHEN 'sales_rep' THEN COALESCE(fr.kind, 'rep') ELSE m.from_type END,
           'to_name', CASE m.to_type
                        WHEN 'sales_rep' THEN tr.full_name WHEN 'customer' THEN tc.name
                        WHEN 'walk_in' THEN 'Walk-in customers' WHEN 'warehouse' THEN 'Warehouse'
                        WHEN 'qc' THEN 'Quality Control' WHEN 'production' THEN 'Production'
                        WHEN 'store' THEN 'Store' WHEN 'external' THEN 'Outside'
                        ELSE m.to_type END,
           'to_kind', CASE m.to_type WHEN 'sales_rep' THEN COALESCE(tr.kind, 'rep') ELSE m.to_type END,
           'by', CASE WHEN m.created_by IS NOT NULL THEN public._user_label(m.created_by) END
         ) ORDER BY m.seq DESC), '[]'::jsonb)
    INTO v_moves
    FROM m
    LEFT JOIN sales_reps fr ON m.from_type = 'sales_rep' AND fr.id = m.from_id
    LEFT JOIN customers fc ON m.from_type = 'customer' AND fc.id = m.from_id
    LEFT JOIN sales_reps tr ON m.to_type = 'sales_rep' AND tr.id = m.to_id
    LEFT JOIN customers tc ON m.to_type = 'customer' AND tc.id = m.to_id;

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
           string_agg(DISTINCT damage_reason, '; ') AS why, string_agg(DISTINCT who, ', ') AS src,
           bool_and(status = 'received' OR quantity_good = 0) AS done,
           MAX(received_at) AS rat, (array_agg(received_by ORDER BY received_at DESC NULLS LAST))[1] AS rby
      FROM b GROUP BY pst
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'posting', g.pst, 'posted_at', g.vat,
           'posted_by', CASE WHEN g.vby IS NOT NULL THEN public._user_label(g.vby) END,
           'total', g.tot, 'good', g.gd, 'damaged', g.dmg, 'damage_reason', g.why, 'sources', g.src,
           'status', CASE WHEN g.done THEN 'received' ELSE 'verified' END,
           'received_at', CASE WHEN g.done THEN g.rat END,
           'received_by', CASE WHEN g.done AND g.rby IS NOT NULL THEN public._user_label(g.rby) END
         ) ORDER BY g.vat DESC), '[]'::jsonb)
    INTO v_posts
    FROM g
   WHERE NOT g.done OR public._jug_day(g.vat) BETWEEN p_from AND p_to;

  SELECT COALESCE(SUM(quantity_accepted), 0) INTO v_with_qc
    FROM qc_jug_batches WHERE factory_id = p_factory AND status = 'accepted';

  RETURN jsonb_build_object('movements', v_moves, 'postings', v_posts, 'with_qc', v_with_qc);
END;
$$;
REVOKE ALL ON FUNCTION public.accounts_jug_activity(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accounts_jug_activity(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
