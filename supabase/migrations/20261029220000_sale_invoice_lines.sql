-- ============================================================================
-- sale_invoice_lines: the product lines of printed invoices
-- ----------------------------------------------------------------------------
-- printSaleInvoice() read sale_items with products(name,unit). products is
-- readable only with finished-goods rights (and sale_items only with sales
-- rights), so an accountant printing from the Accountant page got invoices
-- with no product lines, and the Invoices tab's Products column was empty.
-- This returns just the lines -- product name, unit, quantity, price, amount
-- -- for the given sales, to anyone who can see sales or finance, like
-- sale_invoice_party().
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sale_invoice_lines(p_sales uuid[])
RETURNS TABLE(sale_id uuid, product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF COALESCE(array_length(p_sales, 1), 0) > 1000 THEN RAISE EXCEPTION 'At most 1000 sales at a time'; END IF;

  RETURN QUERY
  SELECT si.sale_id, COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text,
         si.quantity, si.unit_price, si.line_total
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN products p ON p.id = si.product_id
   WHERE si.sale_id = ANY(p_sales)
     AND public._works_in_factory(auth.uid(), s.factory_id)
   ORDER BY si.sale_id, si.id;
END;
$$;
REVOKE ALL ON FUNCTION public.sale_invoice_lines(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sale_invoice_lines(uuid[]) TO authenticated;
