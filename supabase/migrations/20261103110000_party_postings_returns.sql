-- ============================================================================
-- Everything posted to a party and everything they returned, in one read
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "all posted products should come at the top of the
-- marketer's interface in the Accountant page ... when the marketer's name
-- is clicked in All activity, and returns of each marketer and distributor".
--
-- party_postings_and_returns(p_factory, p_rep, p_customer_name) -- one row per
-- product line, all time, newest first:
--   kind 'posting'   a marketer's / the shop's postings (stock_dispatches),
--                    or a distributor's supplies (their sales)
--   kind 'return'    their returns (rep_returns / sales_returns); cancelled
--                    ones (corrected or removed) left out
-- A marketer / the shop by id; a distributor by name (case-insensitive), the
-- way the Accountant's customer window finds their invoices. Readable by
-- whoever reads rep_posting_lines (distribution / finance / marketer-accounts
-- view) -- accountants can't read products directly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.party_postings_and_returns(
  p_factory uuid, p_rep uuid DEFAULT NULL, p_customer_name text DEFAULT NULL
) RETURNS TABLE(kind text, id uuid, reference text, day date, at timestamptz, status text,
                product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric,
                note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_name text := lower(btrim(COALESCE(p_customer_name, '')));
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF (p_rep IS NULL) = (v_name = '') THEN RAISE EXCEPTION 'Choose a marketer or a customer'; END IF;

  IF p_rep IS NOT NULL THEN
    RETURN QUERY
    SELECT 'posting'::text, d.id, d.dispatch_number, d.dispatch_date, d.created_at, d.status::text,
           COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
           COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price), NULL::text
      FROM stock_dispatches d
      JOIN stock_dispatch_items i ON i.dispatch_id = d.id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE d.factory_id = p_factory AND d.sales_rep_id = p_rep
    UNION ALL
    SELECT 'return', r.id, r.return_number, r.return_date, COALESCE(r.received_at, r.created_at), r.status::text,
           COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity_returned, i.unit_price,
           i.quantity_returned * i.unit_price,
           CASE WHEN cd.dispatch_number IS NOT NULL AND cd.status <> 'reversed'
                THEN 'Added to ' || cd.dispatch_number END
      FROM rep_returns r
      JOIN rep_return_items i ON i.rep_return_id = r.id
      LEFT JOIN products p ON p.id = i.product_id
      LEFT JOIN stock_dispatches cd ON cd.id = r.carried_dispatch_id
     WHERE r.factory_id = p_factory AND r.sales_rep_id = p_rep AND r.status::text <> 'cancelled'
     ORDER BY 5 DESC, 7;
  ELSE
    RETURN QUERY
    SELECT 'posting'::text, s.id, s.invoice_number, s.sale_date, s.created_at, s.status::text,
           COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total,
           CASE WHEN COALESCE(s.is_pr, false) THEN 'PR' END
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE s.factory_id = p_factory AND s.deleted_at IS NULL
       AND lower(btrim(s.customer_name)) = v_name
       AND s.status::text NOT IN ('rejected', 'cancelled')
    UNION ALL
    SELECT 'return', sr.id, sr.return_number, sr.return_date, COALESCE(sr.received_at, sr.created_at), sr.status::text,
           COALESCE(p.name, '-')::text, COALESCE(p.unit, sr.unit, '')::text, sr.quantity_returned,
           CASE WHEN sr.quantity_returned > 0 THEN sr.value / sr.quantity_returned END, sr.value,
           (SELECT 'On ' || s2.invoice_number FROM sales s2 WHERE s2.id = sr.sale_id)
      FROM sales_returns sr
      LEFT JOIN products p ON p.id = sr.product_id
      LEFT JOIN customers c ON c.id = sr.customer_id
      LEFT JOIN sales s ON s.id = sr.sale_id
     WHERE sr.factory_id = p_factory AND sr.status::text <> 'cancelled'
       AND (lower(btrim(c.name)) = v_name OR lower(btrim(s.customer_name)) = v_name)
     ORDER BY 5 DESC, 7;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.party_postings_and_returns(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.party_postings_and_returns(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
