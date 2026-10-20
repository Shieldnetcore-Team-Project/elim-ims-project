-- ============================================================================
-- sale_invoice_party: who a printed invoice belongs to
-- ----------------------------------------------------------------------------
-- printSaleInvoice() picks the marketer/distributor invoice layout from the
-- sale's marketer (sales_reps) and customer, and prints the delivery method
-- from deliveries. Those tables are readable only with distribution,
-- customers and logistics view rights, which an accountant printing from the
-- Accountant page may not hold -- the lookup then came back empty and a
-- marketer's sale printed as a plain receipt. This returns just what the
-- invoice needs, to anyone who can see sales or finance.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sale_invoice_party(p_sale uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sale sales%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public._marketer_can_view(COALESCE(
            (SELECT account_rep_id FROM sales WHERE id = p_sale),
            (SELECT sales_rep_id FROM sales WHERE id = p_sale)), true)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_sale FROM sales WHERE id = p_sale;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

  RETURN jsonb_build_object(
    'seller', (SELECT jsonb_build_object('id', r.id, 'code', r.code, 'name', r.full_name, 'kind', r.kind)
                 FROM sales_reps r WHERE r.id = v_sale.sales_rep_id),
    'owner', (SELECT jsonb_build_object('id', r.id, 'code', r.code, 'name', r.full_name, 'kind', r.kind)
                FROM sales_reps r WHERE r.id = v_sale.account_rep_id),
    'customer', (SELECT jsonb_build_object('code', c.code, 'registered', c.registered, 'address', c.address)
                   FROM customers c WHERE c.id = v_sale.customer_id),
    'delivered', EXISTS (SELECT 1 FROM deliveries d WHERE d.sale_id = p_sale AND d.status <> 'cancelled'));
END;
$$;
REVOKE ALL ON FUNCTION public.sale_invoice_party(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sale_invoice_party(uuid) TO authenticated;
