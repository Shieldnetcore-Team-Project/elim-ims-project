-- ============================================================================
-- Retail › All activity: everything that happened at the Retail Shop
-- ----------------------------------------------------------------------------
-- User (2026-11-02): the Retail Shop's activity comes off the Accountant's
-- All activity and goes on its own Retail tab. retail_activity(outlet, from,
-- to) lists, newest first, between two days:
--   Posting          products the Warehouse posted to the shop
--   Sale             the shop's sales (customer, products, paid, balance)
--   Customer return  goods a customer brought back (record_retail_return)
--   Payment          money a customer paid later at the shop (POS Receive)
--   Return           goods the shop sent back to the Warehouse
--   Cash remitted    money the shop handed in
-- Product names come through here because not everyone who sees the shop can
-- read products. For Retail (sales view) and Accounts (finance view), in
-- their own factory. Read only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.retail_activity(p_outlet uuid, p_from date, p_to date)
RETURNS TABLE(kind text, at timestamptz, reference text, party text, details text,
              amount numeric, paid numeric, balance numeric, method text, status text,
              sale_id uuid, dispatch_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_rep sales_reps%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' OR NOT public._works_in_factory(auth.uid(), v_rep.factory_id) THEN
    RAISE EXCEPTION 'Retail outlet not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a from and to date'; END IF;

  RETURN QUERY
  SELECT a.* FROM (
    SELECT 'Posting'::text AS k, d.created_at AS t, d.dispatch_number AS ref, 'From the Warehouse'::text AS who,
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')) || ' ' || p.unit, ' · '
                              ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = d.id) AS info,
           d.total_value AS amt, NULL::numeric AS pd, NULL::numeric AS bal, NULL::text AS how, d.status AS st,
           NULL::uuid AS sid, d.id AS did
      FROM stock_dispatches d
     WHERE d.sales_rep_id = p_outlet AND d.dispatch_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Sale', s.created_at, s.invoice_number, COALESCE(NULLIF(btrim(s.customer_name), ''), 'Walk-in'),
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')) || ' ' || p.unit, ' · '
                              ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = s.id),
           s.grand_total, s.amount_paid, s.balance, s.payment_method::text,
           CASE WHEN COALESCE(s.is_pr, false) THEN 'PR' ELSE s.status::text END, s.id, NULL::uuid
      FROM sales s
     WHERE s.sales_rep_id = p_outlet AND s.deleted_at IS NULL AND s.sale_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Customer return', COALESCE(r.inspected_at, r.received_at), r.return_number,
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           p.name || ' × ' || trim(to_char(r.quantity_returned, 'FM999G999G990D###')) || ' ' || COALESCE(r.unit, p.unit)
             || CASE WHEN r.refund_amount > 0 THEN ' · refunded ' || trim(to_char(r.refund_amount, 'FM999G999G990'))
                     WHEN r.credit_added > 0 THEN ' · kept as credit ' || trim(to_char(r.credit_added, 'FM999G999G990'))
                     ELSE '' END,
           r.value, NULL::numeric, NULL::numeric, r.refund_method::text, r.status, r.sale_id, NULL::uuid
      FROM sales_returns r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN sales s ON s.id = r.sale_id
     WHERE r.sales_rep_id = p_outlet AND r.return_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Payment', pr.created_at, pr.receipt_number, COALESCE(c.name, s.customer_name, '—'),
           CASE WHEN s.invoice_number IS NOT NULL THEN 'On ' || s.invoice_number END,
           pr.amount, NULL::numeric, NULL::numeric, pr.payment_method::text, pr.status::text, pr.sale_id, NULL::uuid
      FROM payments_received pr
      LEFT JOIN customers c ON c.id = pr.customer_id
      LEFT JOIN sales s ON s.id = pr.sale_id
     WHERE pr.collected_by_rep = p_outlet AND NOT pr.at_point_of_sale
       AND pr.payment_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Return', COALESCE(x.received_at, x.created_at), x.return_number, 'To the Warehouse',
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity_returned, 'FM999G999G990D###')) || ' ' || p.unit,
                              ' · ' ORDER BY p.name)
              FROM rep_return_items i JOIN products p ON p.id = i.product_id WHERE i.rep_return_id = x.id),
           (SELECT COALESCE(SUM(i.quantity_returned * i.unit_price), 0) FROM rep_return_items i WHERE i.rep_return_id = x.id),
           NULL::numeric, NULL::numeric, NULL::text, x.status, NULL::uuid, NULL::uuid
      FROM rep_returns x
     WHERE x.sales_rep_id = p_outlet AND x.return_date BETWEEN p_from AND p_to

    UNION ALL
    SELECT 'Cash remitted', m.created_at, m.remittance_number, 'Handed in', m.remarks,
           m.amount, NULL::numeric, NULL::numeric, m.payment_method::text, 'received', NULL::uuid, NULL::uuid
      FROM rep_remittances m
     WHERE m.sales_rep_id = p_outlet AND m.remittance_date BETWEEN p_from AND p_to
  ) a
  ORDER BY a.t DESC NULLS LAST
  LIMIT 2000;
END;
$$;
REVOKE ALL ON FUNCTION public.retail_activity(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retail_activity(uuid, date, date) TO authenticated;

-- The new tab Retail › All activity: ticked for every account that already
-- has the Retail Outlet page (as 20261030090000 did for the summary pages).
INSERT INTO public.user_page_access (user_id, page_id, granted)
SELECT a.user_id, 'Retail › All activity', true
  FROM public.user_page_access a
 WHERE a.page_id = 'Retail › Retail Outlet' AND a.granted
ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();
