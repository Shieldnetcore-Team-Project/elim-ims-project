-- ============================================================================
-- Warehouse › All transactions: every party's goods, one row per party
-- ----------------------------------------------------------------------------
-- User (2026-11-02): the Warehouse's "Recent activity" becomes "All
-- transactions". The Warehouse clicks a marketer or a Distributor/Office
-- Delivery customer to see everything that moved with them and to act on
-- their account there: return products, return empty jugs.
--
-- warehouse_transactions(factory, limit, party) -- goods only, no money:
--   received / refused  releases from Production
--   marketer / retail   postings to a marketer / the Retail Shop
--   distributor / sale  postings to a distributor / direct sales
--   returned            goods a marketer / the shop brought back
--   customer_return     goods a customer brought back
--   jugs_returned       empty jugs recorded back (claimed; QC counts them)
-- party_type 'production' | 'marketer' | 'retail' | 'distributor' | 'walk_in',
-- party_id the sales_reps / customers row. p_party narrows it to one party.
-- Same rights as warehouse_recent_activity. Read only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.warehouse_transactions(p_factory uuid, p_limit int DEFAULT 200, p_party uuid DEFAULT NULL)
RETURNS TABLE(kind text, reference text, at timestamptz, party_type text, party_id uuid, party text,
              items text, quantity numeric, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  RETURN QUERY
  SELECT a.* FROM (
    SELECT CASE WHEN r.status = 'rejected' THEN 'refused' ELSE 'received' END AS k,
           r.release_number AS ref, COALESCE(r.accepted_at, r.released_at) AS t,
           'production'::text AS ptype, NULL::uuid AS pid, 'Production'::text AS who,
           pr.name || ' × ' || trim(to_char(COALESCE(r.accepted_quantity, r.quantity), 'FM999G999G990D###')) AS info,
           COALESCE(r.accepted_quantity, r.quantity) AS qty, r.status::text AS st
      FROM production_releases r
      JOIN products pr ON pr.id = r.product_id
     WHERE r.factory_id = p_factory AND r.status IN ('accepted', 'rejected') AND p_party IS NULL

    UNION ALL
    SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, d.dispatch_number, d.created_at,
           CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, sr.id, sr.full_name,
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = d.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
           d.status
      FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id
     WHERE d.factory_id = p_factory AND d.status <> 'reversed' AND (p_party IS NULL OR sr.id = p_party)

    UNION ALL
    SELECT CASE WHEN c.registered THEN 'distributor' ELSE 'sale' END, s.invoice_number, s.created_at,
           CASE WHEN c.registered THEN 'distributor' ELSE 'walk_in' END, c.id,
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = s.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i WHERE i.sale_id = s.id),
           s.status::text
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
       AND (p_party IS NULL OR c.id = p_party)

    UNION ALL
    SELECT 'returned', x.return_number, COALESCE(x.received_at, x.created_at),
           CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, sr.id, sr.full_name,
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity_returned, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM rep_return_items i JOIN products p ON p.id = i.product_id WHERE i.rep_return_id = x.id),
           (SELECT COALESCE(SUM(i.quantity_returned), 0) FROM rep_return_items i WHERE i.rep_return_id = x.id),
           x.status
      FROM rep_returns x
      JOIN sales_reps sr ON sr.id = x.sales_rep_id
     WHERE x.factory_id = p_factory AND x.status <> 'cancelled' AND (p_party IS NULL OR sr.id = p_party)

    UNION ALL
    SELECT 'customer_return', r.return_number, COALESCE(r.inspected_at, r.received_at),
           CASE WHEN c.registered THEN 'distributor' ELSE 'walk_in' END, c.id,
           COALESCE(c.name, 'Customer'),
           p.name || ' × ' || trim(to_char(r.quantity_returned, 'FM999G999G990D###')),
           r.quantity_returned, r.status
      FROM sales_returns r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.factory_id = p_factory AND r.sales_rep_id IS NULL AND r.status <> 'cancelled'
       AND (p_party IS NULL OR c.id = p_party)

    UNION ALL
    SELECT 'jugs_returned', j.reference, j.recorded_at,
           CASE WHEN j.customer_id IS NOT NULL THEN 'distributor'
                WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END,
           COALESCE(j.sales_rep_id, j.customer_id), COALESCE(sr.full_name, c.name),
           'Empty ' || ct.name || ' × ' || trim(to_char(j.quantity_claimed, 'FM999G999G990'))
             || CASE WHEN j.status = 'verified' THEN ' (QC counted ' || trim(to_char(j.quantity_received, 'FM999G999G990')) || ')'
                     ELSE '' END,
           j.quantity_claimed, j.status
      FROM jug_returns j
      JOIN container_types ct ON ct.id = j.container_type_id
      LEFT JOIN sales_reps sr ON sr.id = j.sales_rep_id
      LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.factory_id = p_factory AND j.status <> 'cancelled'
       AND (p_party IS NULL OR j.sales_rep_id = p_party OR j.customer_id = p_party)
  ) a
  ORDER BY a.t DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 2000);
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_transactions(uuid, int, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_transactions(uuid, int, uuid) TO authenticated;
