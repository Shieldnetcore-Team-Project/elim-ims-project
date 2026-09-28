-- ============================================================================
-- Marketer's customers: every customer a sales rep has sold to, with what
-- each took, paid and still owes
-- ----------------------------------------------------------------------------
-- Backs the "Customers" section of Distribution -> Rep Accounts. One row per
-- approved sale the rep made (sales.sales_rep_id) in the period; the page
-- groups them by customer. Money per invoice:
--
--   grand_total      goods taken
--   cash_paid        paid on the invoice: cash at the sale plus every later
--                    payment against its debt (both land in sales.amount_paid)
--   advance_applied  drawn from the customer's advance at approval
--   written_off      debt written off (posted write-offs only)
--   outstanding      still owed, from the invoice's debt row
--   due_date / paid_at   from the credit-terms migration
--
-- SECURITY DEFINER with a distribution:view check, like rep_account_summary:
-- whoever reconciles a rep sees that rep's customers without also needing
-- Sales / Customers / Debts access.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rep_customer_invoices(
  p_sales_rep_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL
) RETURNS TABLE(
  sale_id uuid, invoice_number text, sale_date date,
  customer_id uuid, customer_name text, customer_phone text,
  grand_total numeric, cash_paid numeric, advance_applied numeric,
  written_off numeric, outstanding numeric,
  due_date date, paid_at timestamptz, debt_status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT s.id, s.invoice_number, s.sale_date,
         s.customer_id,
         COALESCE(c.name, NULLIF(btrim(s.customer_name), ''), 'Walk-in'),
         COALESCE(c.phone, s.customer_phone),
         s.grand_total, s.amount_paid, s.credit_applied,
         CASE WHEN d.writeoff_status = 'posted' THEN COALESCE(d.writeoff_amount, 0) ELSE 0 END,
         COALESCE(d.outstanding, 0),
         d.due_date, d.paid_at, d.status::text
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN debts d ON d.sale_id = s.id
   WHERE s.sales_rep_id = p_sales_rep_id
     AND s.status = 'posted' AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
     AND (p_from IS NULL OR s.sale_date >= p_from)
     AND (p_to IS NULL OR s.sale_date <= p_to)
   ORDER BY s.sale_date DESC, s.invoice_number DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.rep_customer_invoices(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_customer_invoices(uuid, date, date) TO authenticated;
