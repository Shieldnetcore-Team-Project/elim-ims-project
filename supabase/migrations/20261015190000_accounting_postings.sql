-- ============================================================================
-- Accounting: Warehouse postings for assessment, and distributor accounts
-- ----------------------------------------------------------------------------
-- Every Warehouse posting reaches the Accountant page (Postings tab) for the
-- accountant to assess and enter payment against:
--
--   marketer     a dispatch to a marketer's van stock   → payment is a remittance
--   retail       a dispatch to the Company Retail Shop  → payment is a remittance
--   distributor  a sale to a registered customer        → payment is a receipt
--                                                          against the invoice
--
-- posting_assessments records that the accountant has assessed (reviewed) a
-- posting: who, when, and any remark. It never changes stock or balances --
-- payments still go through record_payment / record_rep_remittance.
--
-- accounting_postings()   the Postings queue, newest first, with each one's
--                         value, what has been paid (invoices) and whether it
--                         has been assessed
-- distributor_accounts()  one row per distributor (registered customer):
--                         invoiced, paid, outstanding and advance held
-- Both are SECURITY DEFINER so a finance user sees dispatches, sales and
-- customers without the separate distribution/sales/customers view rights;
-- guarded by finance view and scoped to one factory.
-- ============================================================================

-- ============ posting_assessments ============
CREATE TABLE IF NOT EXISTS public.posting_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  posting_kind text NOT NULL CHECK (posting_kind IN ('dispatch', 'sale')),
  posting_id uuid NOT NULL,
  remarks text,
  assessed_by uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  assessed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (posting_kind, posting_id)
);
GRANT SELECT ON public.posting_assessments TO authenticated;
GRANT ALL ON public.posting_assessments TO service_role;
ALTER TABLE public.posting_assessments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "posting assessments read" ON public.posting_assessments;
CREATE POLICY "posting assessments read" ON public.posting_assessments FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key));

-- Mark a posting assessed. Re-assessing updates the remark and who/when.
CREATE OR REPLACE FUNCTION public.assess_posting(p_kind text, p_id uuid, p_remarks text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_factory uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
     OR NOT (public.has_permission(auth.uid(), 'payments'::module_key, 'write'::action_key)
          OR public.has_permission(auth.uid(), 'debts'::module_key, 'write'::action_key)
          OR public.has_permission(auth.uid(), 'distribution'::module_key, 'post'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_kind = 'dispatch' THEN
    SELECT factory_id INTO v_factory FROM stock_dispatches WHERE id = p_id;
  ELSIF p_kind = 'sale' THEN
    SELECT factory_id INTO v_factory FROM sales WHERE id = p_id AND deleted_at IS NULL;
  ELSE
    RAISE EXCEPTION 'Unknown posting kind %', p_kind;
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'Posting not found'; END IF;

  INSERT INTO posting_assessments (factory_id, posting_kind, posting_id, remarks, assessed_by, assessed_at)
  VALUES (v_factory, p_kind, p_id, NULLIF(btrim(COALESCE(p_remarks, '')), ''), auth.uid(), now())
  ON CONFLICT (posting_kind, posting_id) DO UPDATE
     SET remarks = EXCLUDED.remarks, assessed_by = EXCLUDED.assessed_by, assessed_at = EXCLUDED.assessed_at
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.assess_posting(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assess_posting(text, uuid, text) TO authenticated;

-- ============ The Postings queue ============
CREATE OR REPLACE FUNCTION public.accounting_postings(p_factory uuid, p_limit int DEFAULT 300)
RETURNS TABLE(kind text, posting_kind text, posting_id uuid, reference text, at timestamptz,
              party_id uuid, party text, items text, value numeric, paid numeric,
              balance numeric, status text, assessed_at timestamptz, assessed_by text,
              assessment_remarks text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

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
    ) a
    LEFT JOIN posting_assessments pa ON pa.posting_kind = a.posting_kind AND pa.posting_id = a.posting_id
    LEFT JOIN profiles pf ON pf.id = pa.assessed_by
   ORDER BY a.at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 300), 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION public.accounting_postings(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accounting_postings(uuid, int) TO authenticated;

-- ============ Distributor accounts ============
CREATE OR REPLACE FUNCTION public.distributor_accounts(p_factory uuid)
RETURNS TABLE(customer_id uuid, name text, phone text, marketer text,
              invoices bigint, invoiced numeric, paid numeric, outstanding numeric,
              advance numeric, last_sale date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.phone, sr.full_name,
         COALESCE(t.n, 0), COALESCE(t.invoiced, 0), COALESCE(t.paid, 0), COALESCE(t.outstanding, 0),
         COALESCE(c.credit_balance, 0)::numeric, t.last_sale
    FROM customers c
    LEFT JOIN sales_reps sr ON sr.id = c.sales_rep_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS n,
             SUM(s.grand_total)::numeric AS invoiced,
             SUM(s.amount_paid)::numeric AS paid,
             SUM(GREATEST(s.balance, 0))::numeric AS outstanding,
             MAX(s.sale_date)::date AS last_sale
        FROM sales s
       WHERE s.customer_id = c.id AND s.status = 'posted' AND s.deleted_at IS NULL
         AND NOT COALESCE(s.is_pr, false)
    ) t ON true
   WHERE c.factory_id = p_factory AND c.registered
   ORDER BY COALESCE(t.outstanding, 0) DESC, c.name;
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_accounts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_accounts(uuid) TO authenticated;
