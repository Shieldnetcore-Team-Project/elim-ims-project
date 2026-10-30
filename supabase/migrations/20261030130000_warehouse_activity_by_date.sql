-- ============================================================================
-- Warehouse activity by date (user request 2026-10-30)
-- ----------------------------------------------------------------------------
-- warehouse_activity(factory, from, to): everything that moved through the
-- Warehouse between two days (Lagos time), newest first, with who did it --
-- for the Warehouse page's Activity log, searched with a calendar:
--   received / refused   releases from Production       (accepted_by)
--   marketer / retail    postings to marketers, the shop (created_by)
--   distributor / sale   postings to distributors, direct sales (created_by)
--   adjusted             stock corrections and counts   (user_id), e.g.
--                        WAREHOUSE-STOCK-2026-10-30
-- Same rights and rows as warehouse_recent_activity (20261029180000), which
-- the page's "Recent activity" keeps using. At most 2,000 rows.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.warehouse_activity(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(kind text, reference text, at timestamptz, party text, items text,
              quantity numeric, status text, posted_by text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Pick a from and to date';
  END IF;

  RETURN QUERY
  SELECT a.* FROM (
    SELECT CASE WHEN r.status = 'rejected' THEN 'refused' ELSE 'received' END,
           r.release_number,
           COALESCE(r.accepted_at, r.released_at),
           'Production'::text,
           pr.name || ' × ' || trim(to_char(COALESCE(r.accepted_quantity, r.quantity), 'FM999G999G990D###')),
           COALESCE(r.accepted_quantity, r.quantity),
           r.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = r.accepted_by)
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
           d.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = d.created_by)
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
           s.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = s.created_by)
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL

    UNION ALL
    -- Stock corrections and counts on finished goods: one row per reference
    -- and person (a count touching several products is one row).
    SELECT 'adjusted',
           COALESCE(m.reference, 'Adjustment'),
           MIN(m.created_at),
           CASE WHEN bool_and(m.movement_type = 'opening_balance') THEN 'Balance brought forward'
                ELSE 'Stock correction' END,
           string_agg(p.name || ' ' || CASE WHEN m.quantity > 0 THEN '+' ELSE '' END
                      || trim(to_char(m.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name),
           SUM(m.quantity),
           'posted'::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = m.user_id)
      FROM inventory_movements m
      JOIN products p ON p.id = m.product_id AND p.product_type = 'finished'
     WHERE m.factory_id = p_factory
       AND m.movement_type IN ('adjusted', 'damaged', 'opening_balance')
     GROUP BY COALESCE(m.reference, 'Adjustment'), m.user_id,
              (m.created_at AT TIME ZONE 'Africa/Lagos')::date
  ) a(k, ref, ts, pty, its, qty, st, who)
  WHERE (a.ts AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to
  ORDER BY a.ts DESC
  LIMIT 2000;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_activity(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_activity(uuid, date, date) TO authenticated;
