-- ============================================================================
-- A marketer's van stock with product name, unit and price (2026-10-30)
-- ----------------------------------------------------------------------------
-- User report: in Accounts, a marketer's customer → "Record sale" showed no
-- product names and no price per pack, so the amount didn't work itself out.
-- The form read rep_stock joined to products, and accountants can't read
-- products (RLS): the names and prices came back empty. This returns the van
-- stock with them, for anyone who can see marketer accounts (distribution,
-- finance or marketer-accounts view), in their own factory. Read only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rep_van_stock(p_rep uuid)
RETURNS TABLE(product_id uuid, name text, unit text, unit_price numeric, quantity numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT st.product_id, COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text,
         COALESCE(p.unit_price, 0), st.quantity
    FROM rep_stock st
    JOIN sales_reps r ON r.id = st.sales_rep_id
    LEFT JOIN products p ON p.id = st.product_id
   WHERE st.sales_rep_id = p_rep AND st.quantity > 0
     AND public._works_in_factory(auth.uid(), r.factory_id)
   ORDER BY p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.rep_van_stock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_van_stock(uuid) TO authenticated;
