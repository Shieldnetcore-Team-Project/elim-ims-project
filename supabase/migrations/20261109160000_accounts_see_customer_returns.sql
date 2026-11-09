-- ============================================================================
-- Accounts sees what distributors and customers return to the Warehouse
-- ----------------------------------------------------------------------------
-- User (2026-11-09): Kemi returned products for a distributor and the Accountant
-- could not see it. A customer's return is kept in sales_returns, which Accounts
-- cannot read and All activity never listed. One row per return, whatever the
-- number of products on it. A return on a marketer's or the shop's sale is left
-- out: it already shows on their own account.
-- Safe to run again. Paste the whole file into the SQL Editor (run without RLS).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.accounting_customer_returns(
  p_factory uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_customer uuid DEFAULT NULL
) RETURNS TABLE(return_number text, return_date date, at timestamptz, customer_id uuid, customer text,
                items text, value numeric, debt_reduced numeric, credit_added numeric, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  RETURN QUERY
  SELECT regexp_replace(r.return_number, '^(SR-[0-9]{8}-[0-9]+)-[0-9]+$', '\1')::text,
         MAX(r.return_date),
         MAX(COALESCE(r.inspected_at, r.received_at)),
         r.customer_id,
         COALESCE(c.name, MAX(s.customer_name), 'Customer')::text,
         string_agg(p.name || ' × ' || trim(to_char(r.quantity_returned, 'FM999G999G990D###')) || ' ' || COALESCE(r.unit, p.unit),
                    ' · ' ORDER BY p.name),
         COALESCE(SUM(r.value), 0)::numeric,
         COALESCE(SUM(r.debt_reduced), 0)::numeric,
         COALESCE(SUM(r.credit_added), 0)::numeric,
         MIN(r.status)::text
    FROM sales_returns r
    JOIN products p ON p.id = r.product_id
    LEFT JOIN customers c ON c.id = r.customer_id
    LEFT JOIN sales s ON s.id = r.sale_id
   WHERE r.factory_id = p_factory AND r.sales_rep_id IS NULL AND r.status <> 'cancelled'
     AND (p_from IS NULL OR r.return_date >= p_from)
     AND (p_to IS NULL OR r.return_date <= p_to)
     AND (p_customer IS NULL OR r.customer_id = p_customer)
   GROUP BY 1, r.customer_id, c.name
   ORDER BY 3 DESC NULLS LAST
   LIMIT 500;
END;
$fn$;
REVOKE ALL ON FUNCTION public.accounting_customer_returns(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accounting_customer_returns(uuid, date, date, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Read-only check: the latest distributor / customer returns Accounts will now see.
SELECT r.return_date, regexp_replace(r.return_number, '^(SR-[0-9]{8}-[0-9]+)-[0-9]+$', '\1') AS return_number,
       COALESCE(c.name, 'Customer') AS customer, COUNT(*) AS products, SUM(r.value) AS value
  FROM sales_returns r LEFT JOIN customers c ON c.id = r.customer_id
 WHERE r.sales_rep_id IS NULL AND r.status <> 'cancelled'
 GROUP BY 1, 2, 3
 ORDER BY 1 DESC, 2 DESC
 LIMIT 10;
