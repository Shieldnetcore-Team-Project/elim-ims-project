-- ============================================================================
-- Warehouse Recent activity: a corrected posting shows once
-- ----------------------------------------------------------------------------
-- The user (2026-10-29): a posting corrected in the Warehouse appeared once
-- per correction -- every corrected (reversed) version stayed on Recent
-- activity next to the reposted one. Only the posting that holds stock
-- should show.
--
-- warehouse_recent_activity is as 20261028220000 except that postings to
-- marketers / the Retail Shop that were reversed (by a correction or a
-- reversal; their goods are back in stock) are left out. A corrected
-- distributor posting was already left out (its sale is soft-deleted).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.warehouse_recent_activity(p_factory uuid, p_limit int DEFAULT 30)
RETURNS TABLE(kind text, reference text, at timestamptz, party text, items text,
              quantity numeric, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT * FROM (
    SELECT CASE WHEN r.status = 'rejected' THEN 'refused' ELSE 'received' END,
           r.release_number,
           COALESCE(r.accepted_at, r.released_at),
           'Production'::text,
           pr.name || ' × ' || trim(to_char(COALESCE(r.accepted_quantity, r.quantity), 'FM999G999G990D###')),
           COALESCE(r.accepted_quantity, r.quantity),
           r.status
      FROM production_releases r
      JOIN products pr ON pr.id = r.product_id
     WHERE r.factory_id = p_factory AND r.status IN ('accepted', 'rejected')

    UNION ALL
    SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END,
           d.dispatch_number,
           d.created_at,
           sr.full_name,
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
             WHERE i.dispatch_id = d.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
           d.status
      FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id
     WHERE d.factory_id = p_factory AND d.status <> 'reversed'

    UNION ALL
    SELECT CASE WHEN c.registered THEN 'distributor' ELSE 'sale' END,
           s.invoice_number,
           s.created_at,
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id
             WHERE i.sale_id = s.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i WHERE i.sale_id = s.id),
           s.status
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
  ) a
  ORDER BY 3 DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 200);
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_recent_activity(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_recent_activity(uuid, int) TO authenticated;

NOTIFY pgrst, 'reload schema';
