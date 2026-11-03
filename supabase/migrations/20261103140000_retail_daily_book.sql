-- ============================================================================
-- Accountant > Retail daily: the shop's day in one read
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "the accountant page should have what was posted to the
-- retail shop on a daily basis and all their sales for the day, to print the
-- invoice of what was posted to them -- dispensers, bottles and sachets --
-- and of their sales daily".
--
-- retail_daily_book(p_outlet, p_from, p_to) -- one row per product line, for
-- the days p_from..p_to (at most a year), newest day first:
--   kind 'posting'  the Warehouse's postings to the shop (stock_dispatches,
--                   by dispatch_date; reversed ones left out)
--   kind 'return'   what the shop sent back to the Warehouse (rep_returns,
--                   by return_date; cancelled ones left out)
--   kind 'sale'     the shop's posted sales (by sale_date; deleted ones left
--                   out), PR flagged
-- with the record id and number, so the page can print the day's posting
-- invoice and the day's combined sales invoice. Readable by Accounts and the
-- shop's / Warehouse's viewers (accountants can't read products directly).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.retail_daily_book(p_outlet uuid, p_from date, p_to date)
RETURNS TABLE(day date, kind text, id uuid, reference text, at timestamptz, product_name text, unit text,
              quantity numeric, unit_price numeric, line_total numeric, is_pr boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_rep sales_reps%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE sales_reps.id = p_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail outlet not found'; END IF;
  IF NOT public._works_in_factory(auth.uid(), v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;

  RETURN QUERY
  SELECT d.dispatch_date, 'posting'::text, d.id, d.dispatch_number, d.created_at,
         COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
         COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price), false
    FROM stock_dispatches d
    JOIN stock_dispatch_items i ON i.dispatch_id = d.id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE d.sales_rep_id = p_outlet AND d.status::text <> 'reversed'
     AND d.dispatch_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT r.return_date, 'return', r.id, r.return_number, COALESCE(r.received_at, r.created_at),
         COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity_returned, i.unit_price,
         i.quantity_returned * i.unit_price, false
    FROM rep_returns r
    JOIN rep_return_items i ON i.rep_return_id = r.id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE r.sales_rep_id = p_outlet AND r.status::text <> 'cancelled'
     AND r.return_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT s.sale_date, 'sale', s.id, s.invoice_number, s.created_at,
         COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price,
         CASE WHEN COALESCE(s.is_pr, false) THEN 0 ELSE si.line_total END, COALESCE(s.is_pr, false)
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN products p ON p.id = si.product_id
   WHERE s.sales_rep_id = p_outlet AND s.status::text = 'posted' AND s.deleted_at IS NULL
     AND s.sale_date BETWEEN p_from AND p_to
   ORDER BY 1 DESC, 2, 6;
END;
$$;
REVOKE ALL ON FUNCTION public.retail_daily_book(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retail_daily_book(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
