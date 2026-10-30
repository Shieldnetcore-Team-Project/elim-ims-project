-- ============================================================================
-- What was on a marketer's posting, return or sale (user request 2026-10-30)
-- ----------------------------------------------------------------------------
-- Marketer & retail accounts → a marketer → All activity: clicking a
-- transaction shows its products, quantity, price and amount. Accountants
-- can't read products directly (RLS), so the lines come from here:
--   p_kind 'dispatch'  a Warehouse posting to the marketer (stock_dispatch_items)
--   p_kind 'return'    goods the marketer brought back (rep_return_items;
--                      note = accepted / damaged / rejected)
--   p_kind 'sale'      the marketer's sale to a customer (sale_items)
-- For anyone who can see marketer accounts (distribution, finance or
-- marketer-accounts view), in their own factory. Read only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rep_posting_lines(p_kind text, p_id uuid)
RETURNS TABLE(product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  IF p_kind = 'dispatch' THEN
    RETURN QUERY
    SELECT COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
           COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price), NULL::text
      FROM stock_dispatch_items i
      JOIN stock_dispatches d ON d.id = i.dispatch_id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE i.dispatch_id = p_id AND public._works_in_factory(auth.uid(), d.factory_id)
     ORDER BY p.name;
  ELSIF p_kind = 'return' THEN
    RETURN QUERY
    SELECT COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity_returned, i.unit_price,
           i.quantity_returned * i.unit_price,
           NULLIF(concat_ws(', ',
             CASE WHEN i.accepted_quantity IS NOT NULL THEN 'accepted ' || trim(to_char(i.accepted_quantity, 'FM999G999G990D###')) END,
             CASE WHEN i.damaged_quantity > 0 THEN 'damaged ' || trim(to_char(i.damaged_quantity, 'FM999G999G990D###')) END,
             CASE WHEN i.rejected_quantity > 0 THEN 'rejected ' || trim(to_char(i.rejected_quantity, 'FM999G999G990D###')) END), '')
      FROM rep_return_items i
      JOIN rep_returns r ON r.id = i.rep_return_id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE i.rep_return_id = p_id AND public._works_in_factory(auth.uid(), r.factory_id)
     ORDER BY p.name;
  ELSIF p_kind = 'sale' THEN
    RETURN QUERY
    SELECT COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total,
           NULL::text
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = p_id AND public._works_in_factory(auth.uid(), s.factory_id)
     ORDER BY p.name;
  ELSE
    RAISE EXCEPTION 'Unknown transaction kind: %', p_kind;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.rep_posting_lines(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_posting_lines(text, uuid) TO authenticated;
