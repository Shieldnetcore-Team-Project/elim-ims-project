-- ============================================================================
-- monthly_party_sheet: the monthly performance sheet for every party
-- ----------------------------------------------------------------------------
-- The office keeps a month-by-day sheet per marketer ("AYUBA (OCT, 2026)":
-- Date, Total Sales, Credit Sales, Cash Sales, Recovery, Total Cash Remitted).
-- marketer_daily_accountability() gives it for one marketer; the Finance
-- overview's Monthly accumulated sales tab now shows it for everyone who buys:
--   marketer     sales/payments on a marketer's account (sales_reps kind 'rep')
--   retail       the retail shop (sales_reps kind 'outlet')
--   distributor  a registered customer not on a marketer's account
--   other        walk-ins and unregistered customers, as one party
-- Same rules as marketer_daily_accountability: posted, non-PR, non-deleted
-- sales by sale_date; credit = total - customer credit applied - money paid
-- with the sale; recovery = payments on debts (not at point of sale) by
-- payment_date. One row per party per day that had anything; the page fills
-- the quiet days. SECURITY DEFINER so an accountant without distribution /
-- customers rights still sees names.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.monthly_party_sheet(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(
  party_kind text, party_id uuid, party_code text, party_name text,
  day date, total numeric, credit numeric, recovery numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._works_in_factory(auth.uid(), p_factory)
     OR NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
          OR public.has_permission(auth.uid(), 'reports'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Pick at most a year of days'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT s.sale_date AS d, s.account_rep_id AS rep, s.customer_id AS cust,
           s.grand_total AS amt,
           GREATEST(s.grand_total - s.credit_applied - COALESCE((SELECT SUM(p.amount) FROM payments_received p
                 WHERE p.sale_id = s.id AND p.at_point_of_sale AND p.status NOT IN ('reversed','rejected')), 0), 0) AS cr,
           0::numeric AS rec
      FROM sales s
     WHERE s.factory_id = p_factory AND s.status = 'posted' AND s.deleted_at IS NULL
       AND NOT COALESCE(s.is_pr, false) AND s.sale_date BETWEEN p_from AND p_to
    UNION ALL
    SELECT p.payment_date, p.account_rep_id, p.customer_id, 0, 0, p.amount
      FROM payments_received p
     WHERE p.factory_id = p_factory AND NOT p.at_point_of_sale
       AND p.status NOT IN ('reversed','rejected') AND p.payment_date BETWEEN p_from AND p_to
  ),
  tagged AS (
    SELECT mv.*,
           CASE WHEN r.id IS NOT NULL THEN (CASE WHEN r.kind = 'outlet' THEN 'retail' ELSE 'marketer' END)
                WHEN c.registered THEN 'distributor' ELSE 'other' END AS k,
           CASE WHEN r.id IS NOT NULL THEN r.id WHEN c.registered THEN c.id END AS pid,
           CASE WHEN r.id IS NOT NULL THEN r.code::text WHEN c.registered THEN c.code::text END AS pcode,
           CASE WHEN r.id IS NOT NULL THEN r.full_name::text WHEN c.registered THEN c.name::text
                ELSE 'Walk-in & other customers' END AS pname
      FROM mv
      LEFT JOIN sales_reps r ON r.id = mv.rep
      LEFT JOIN customers c ON c.id = mv.cust
  )
  SELECT t.k, t.pid, t.pcode, t.pname, t.d::date, SUM(t.amt), SUM(t.cr), SUM(t.rec)
    FROM tagged t
   GROUP BY t.k, t.pid, t.pcode, t.pname, t.d;
END;
$$;
REVOKE ALL ON FUNCTION public.monthly_party_sheet(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.monthly_party_sheet(uuid, date, date) TO authenticated;
