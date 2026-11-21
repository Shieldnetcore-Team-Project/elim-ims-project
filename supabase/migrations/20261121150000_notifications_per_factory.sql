-- ============================================================================
-- Notifications per factory: Lugbe starts empty
-- ----------------------------------------------------------------------------
-- User (2026-11-21): Lugbe Factory has no activity yet, so its bell and
-- badges must be empty until it starts operating. Two things leaked Kubwa's
-- items into Lugbe:
--   * my_open_notifications() also listed every notification with no factory
--     on it. Those were all raised while Kubwa was the only factory, so they
--     now count in Kubwa only.
--   * warehouse_postings_to_confirm() counted postings from every factory.
--     A new one-argument version counts one factory's postings. The old
--     no-argument version is left in place for any open browser that still
--     calls it.
-- Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.my_open_notifications(p_factory uuid, p_limit int DEFAULT 30)
RETURNS TABLE(id uuid, title text, body text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT n.id, n.title, n.body, n.created_at
    FROM public.notifications n
   WHERE auth.uid() IS NOT NULL
     AND (n.factory_id = p_factory
          OR (n.factory_id IS NULL
              AND p_factory = (SELECT f.id FROM public.factories f WHERE f.code = 'water')))
     AND (
           (n.user_id = auth.uid() AND NOT n.read)
        OR (n.user_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM public.notification_reads r
               WHERE r.notification_id = n.id AND r.user_id = auth.uid()))
         )
     AND NOT (
           n.title = 'Stock adjustment awaiting approval'
       AND NOT EXISTS (
             SELECT 1 FROM public.stock_adjustment_requests a
              WHERE a.reference_number = split_part(n.body, ' ', 1)
                AND a.status = 'pending_approval')
         )
     AND NOT (
           n.title = 'Deletion requested'
       AND NOT EXISTS (
             SELECT 1 FROM public.delete_requests d
              WHERE d.review_status = 'pending'
                AND d.factory_id IS NOT DISTINCT FROM n.factory_id
                AND strpos(n.body, '"' || d.entity_label || '"') > 0)
         )
   ORDER BY n.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$fn$;
REVOKE ALL ON FUNCTION public.my_open_notifications(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_open_notifications(uuid, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.warehouse_postings_to_confirm(p_factory uuid)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT CASE WHEN NOT public._can_confirm_postings(auth.uid()) THEN 0 ELSE (
    SELECT count(*)::int FROM sales s
     WHERE s.factory_id = p_factory
       AND s.status = 'pending_approval' AND s.deleted_at IS NULL
       AND public.is_warehouse_posting(s)
       AND (s.created_by IS DISTINCT FROM auth.uid()
            OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  ) + (
    SELECT count(*)::int FROM sales s
     WHERE s.factory_id = p_factory
       AND s.status = 'posted' AND s.deleted_at IS NULL
       AND s.created_at >= '2026-10-29 00:00:00+01'
       AND public.is_warehouse_posting(s)
       AND NOT EXISTS (SELECT 1 FROM posting_assessments pa
                        WHERE pa.posting_kind = 'sale' AND pa.posting_id = s.id)
  ) + (
    SELECT count(*)::int FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id AND sr.kind <> 'outlet'
     WHERE d.factory_id = p_factory
       AND d.status = 'posted'
       AND NOT EXISTS (SELECT 1 FROM posting_assessments pa
                        WHERE pa.posting_kind = 'dispatch' AND pa.posting_id = d.id)
  ) END;
$fn$;
REVOKE ALL ON FUNCTION public.warehouse_postings_to_confirm(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_postings_to_confirm(uuid) TO authenticated;
