-- ============================================================================
-- QC sees the bottles she sends to PM
-- ----------------------------------------------------------------------------
-- Quality Control → Good bottles → Send to production: the Product box was
-- empty for QC (Joy) but filled for an admin. products is readable only with
-- finished-goods read (20260814093000_rls_permission_rewrite.sql) and
-- raw_materials with raw-materials read; QC has neither, so the good bottles
-- she had just stocked never showed, and product names on her transfers,
-- department stock and PM rejections came back blank.
--
-- _pf_is_bottle_product: a product blowing stocks into -- semi-finished, the
-- bottle a preform makes (raw_materials.output_product_id), or one a stocking,
-- blowing record or transfer used. SECURITY DEFINER so the check is not itself
-- hidden by raw_materials' RLS.
-- "preform read bottle products": anyone with preform-production view may
-- read those products only (not the rest of the catalogue).
-- pf_bottle_products: the list for the Send-to-production box.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._pf_is_bottle_product(p_product uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_type = 'semi_finished'
      OR EXISTS (SELECT 1 FROM raw_materials m WHERE m.output_product_id = p_product)
      OR EXISTS (SELECT 1 FROM preform_stockings s WHERE s.product_id = p_product)
      OR EXISTS (SELECT 1 FROM preform_shift_records r WHERE r.output_product_id = p_product)
      OR EXISTS (SELECT 1 FROM bottle_transfers t WHERE t.product_id = p_product);
$$;
REVOKE ALL ON FUNCTION public._pf_is_bottle_product(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pf_is_bottle_product(uuid, text) TO authenticated;

DROP POLICY IF EXISTS "preform read bottle products" ON public.products;
CREATE POLICY "preform read bottle products" ON public.products FOR SELECT TO authenticated
  USING (public._pf_can('view') AND public._pf_is_bottle_product(id, product_type::text));

CREATE OR REPLACE FUNCTION public.pf_bottle_products(p_factory uuid)
RETURNS TABLE(id uuid, name text, current_stock numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._pf_can('post') OR public._pf_can('confirm')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT (public._works_in_factory(auth.uid(), p_factory) OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT p.id, p.name::text, p.current_stock::numeric
    FROM products p
   WHERE p.factory_id = p_factory
     AND p.active
     AND public._pf_is_bottle_product(p.id, p.product_type::text)
   ORDER BY (p.current_stock > 0) DESC, p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.pf_bottle_products(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pf_bottle_products(uuid) TO authenticated;
