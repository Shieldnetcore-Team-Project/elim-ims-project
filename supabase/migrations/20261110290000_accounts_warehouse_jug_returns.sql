-- ============================================================================
-- Accountant -> Dispensers -> Empties to Warehouse: what the Warehouse took in
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "Empties sent to the Warehouse should be seen here".
-- accounts_warehouse_jug_returns(factory, from, to): every empty jug the
-- Warehouse recorded from a marketer, the shop or a distributor / customer
-- (jug_returns) in the dates chosen -- plus any still waiting for QC's count
-- whatever the date -- with who recorded it, what QC counted and where the
-- jugs are now. Read only; same access as accounts_jug_activity.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.accounts_warehouse_jug_returns(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(id uuid, reference text, recorded_at timestamptz, holder_name text, holder_kind text, jug text,
              recorded numeric, counted numeric, good numeric, damaged numeric, stage text,
              recorded_by text, counted_by text, counted_at timestamptz, notes text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_collections_can_view(p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  SELECT j.id, j.reference::text, j.recorded_at,
         COALESCE(sr.full_name, c.name, '(unknown)')::text,
         CASE WHEN j.sales_rep_id IS NOT NULL THEN COALESCE(sr.kind, 'rep') ELSE 'customer' END::text,
         ct.name::text,
         j.quantity_claimed, j.quantity_received, b.quantity_good, b.quantity_damaged,
         CASE WHEN j.status = 'pending' THEN 'awaiting_count'
              WHEN j.status = 'cancelled' THEN 'cancelled'
              WHEN b.id IS NULL THEN 'none_counted'
              WHEN b.status = 'accepted' THEN 'at_qc'
              WHEN b.status = 'verified' THEN 'posted_to_pm'
              WHEN b.status = 'received' THEN 'received_by_pm'
              ELSE b.status END::text,
         CASE WHEN j.recorded_by IS NOT NULL THEN public._user_label(j.recorded_by) END,
         CASE WHEN j.verified_by IS NOT NULL THEN public._user_label(j.verified_by) END,
         j.verified_at,
         NULLIF(concat_ws(' · ', j.notes, j.verify_note, j.cancel_reason, b.damage_reason, b.pm_posting), '')::text
    FROM jug_returns j
    JOIN container_types ct ON ct.id = j.container_type_id
    LEFT JOIN qc_jug_batches b ON b.jug_return_id = j.id AND b.status <> 'cancelled'
    LEFT JOIN sales_reps sr ON sr.id = j.sales_rep_id
    LEFT JOIN customers c ON c.id = j.customer_id
   WHERE j.factory_id = p_factory
     AND ((j.recorded_at >= (p_from::timestamp AT TIME ZONE 'Africa/Lagos')
           AND j.recorded_at < ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Lagos'))
          OR j.status = 'pending')
   ORDER BY j.recorded_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.accounts_warehouse_jug_returns(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accounts_warehouse_jug_returns(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
