-- ============================================================================
-- Accountant > All activity: any day's postings, not only the latest
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "add date ... so that the accountant can select a date
-- to see previous and any date's postings on the All activity page".
-- accounting_postings(p_factory, p_limit) returns the newest postings only
-- (at most 1,000), so an earlier day could fall off. accounting_postings_between
-- is the same list for the days p_from..p_to (Lagos dates, at most a year),
-- with no limit. accounting_postings itself is unchanged.
-- ============================================================================

-- As accounting_postings (20261017090000), filtered by day instead of limited.
CREATE OR REPLACE FUNCTION public.accounting_postings_between(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(kind text, posting_kind text, posting_id uuid, reference text, at timestamptz,
              party_id uuid, party text, items text, value numeric, paid numeric,
              balance numeric, status text, assessed_at timestamptz, assessed_by text,
              assessment_remarks text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;

  RETURN QUERY
  SELECT a.*, pa.assessed_at, pf.full_name, pa.remarks
    FROM (
      SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END AS kind,
             'dispatch'::text AS posting_kind,
             d.id AS posting_id,
             d.dispatch_number AS reference,
             d.created_at AS at,
             sr.id AS party_id,
             sr.full_name AS party,
             (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
                FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
               WHERE i.dispatch_id = d.id) AS items,
             COALESCE((SELECT SUM(i.line_value) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
                      d.total_value)::numeric AS value,
             NULL::numeric AS paid,
             NULL::numeric AS balance,
             d.status AS status
        FROM stock_dispatches d
        JOIN sales_reps sr ON sr.id = d.sales_rep_id
       WHERE d.factory_id = p_factory

      UNION ALL
      SELECT 'distributor', 'sale', s.id, s.invoice_number, s.created_at,
             c.id, c.name,
             (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
                FROM sale_items i JOIN products p ON p.id = i.product_id
               WHERE i.sale_id = s.id),
             s.grand_total::numeric, s.amount_paid::numeric, s.balance::numeric, s.status::text
        FROM sales s
        JOIN customers c ON c.id = s.customer_id AND c.registered
       WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
         AND NOT COALESCE(s.is_pr, false)

      -- Chairman's gifts: value at cost, nothing to pay.
      UNION ALL
      SELECT 'chairmans_gift', 'gift', g.id, g.gift_number, g.created_at,
             NULL::uuid, COALESCE(g.recipient, 'Chairman''s request'),
             (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
                FROM chairmans_gift_items i JOIN products p ON p.id = i.product_id
               WHERE i.gift_id = g.id),
             g.total_value::numeric, NULL::numeric, NULL::numeric, g.status
        FROM chairmans_gifts g
       WHERE g.factory_id = p_factory
    ) a
    LEFT JOIN posting_assessments pa ON pa.posting_kind = a.posting_kind AND pa.posting_id = a.posting_id
    LEFT JOIN profiles pf ON pf.id = pa.assessed_by
   WHERE (a.at AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to
   ORDER BY a.at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.accounting_postings_between(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accounting_postings_between(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
