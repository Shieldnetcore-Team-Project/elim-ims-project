-- ============================================================================
-- Everything the Warehouse posted on a day, to everyone, in one read
-- ----------------------------------------------------------------------------
-- User (2026-11-04): the Accountant picks a day and prints all products
-- posted that day to marketers, distributors and the Retail Shop.
--
-- day_postings(p_factory, p_from, p_to) -- one row per product line:
--   party_type 'marketer'     a marketer's posting (stock_dispatches)
--              'retail'       a posting to the Retail Shop (outlet rep)
--              'distributor'  a Warehouse posting to a distributor (a sale,
--                             is_warehouse_posting: registered customer, no
--                             rep, not PR)
-- Reversed postings, deleted / rejected / cancelled invoices are left out.
-- Dated by the posting's own date (dispatch_date / sale_date). Readable by
-- whoever reads party_postings_and_returns (distribution / finance /
-- marketer-accounts view) -- accountants can't read products directly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.day_postings(p_factory uuid, p_from date, p_to date DEFAULT NULL)
RETURNS TABLE(party_type text, party text, party_code text, id uuid, reference text, day date,
              at timestamptz, status text, product_name text, unit text, quantity numeric,
              unit_price numeric, line_total numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_to date := COALESCE(p_to, p_from);
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL THEN RAISE EXCEPTION 'Pick a day'; END IF;
  IF v_to < p_from THEN RAISE EXCEPTION 'The end date is before the start date'; END IF;
  IF v_to - p_from > 92 THEN RAISE EXCEPTION 'Pick at most three months'; END IF;

  RETURN QUERY
  SELECT CASE WHEN r.kind::text = 'outlet' THEN 'retail' ELSE 'marketer' END,
         COALESCE(r.full_name, '-')::text, r.code::text,
         d.id, d.dispatch_number, d.dispatch_date, d.created_at, d.status::text,
         COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
         COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price)
    FROM stock_dispatches d
    JOIN stock_dispatch_items i ON i.dispatch_id = d.id
    LEFT JOIN sales_reps r ON r.id = d.sales_rep_id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE d.factory_id = p_factory AND d.status::text <> 'reversed'
     AND d.dispatch_date BETWEEN p_from AND v_to
  UNION ALL
  SELECT 'distributor', COALESCE(NULLIF(btrim(s.customer_name), ''), c.name, '-')::text, NULL::text,
         s.id, s.invoice_number, s.sale_date, s.created_at, s.status::text,
         COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN products p ON p.id = si.product_id
   WHERE s.factory_id = p_factory AND s.deleted_at IS NULL
     AND s.status::text NOT IN ('rejected', 'cancelled')
     AND public.is_warehouse_posting(s)
     AND s.sale_date BETWEEN p_from AND v_to
   ORDER BY 1, 2, 7, 9;
END;
$$;
REVOKE ALL ON FUNCTION public.day_postings(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.day_postings(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
