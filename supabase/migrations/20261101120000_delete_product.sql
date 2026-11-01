-- ============================================================================
-- Costing -> Product Prices: delete a product (Admin)
-- ----------------------------------------------------------------------------
-- User request (2026-11-01): a delete icon on the Costing page so products
-- can be deleted, by the administrator (as every product edit,
-- 20261101110000).
--
-- delete_product(p_id):
--   * Admin or Chairman only;
--   * refused while it still holds stock -- in the Warehouse, or with a
--     marketer / the shop -- so no stock disappears: move or clear it first;
--   * a product nothing refers to (never sold, posted, produced...) is
--     deleted outright;
--   * one with history is taken off every list instead (active = false):
--     its past sales, postings and reports keep their product. An admin can
--     bring it back in Settings -> Products.
-- Every table that points at products is checked, so new ones are covered.
-- Audited.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_product(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row products%ROWTYPE;
  v_fk record;
  v_used boolean := false;
  v_held numeric;
BEGIN
  IF NOT public._is_product_admin(v_uid) THEN
    RAISE EXCEPTION 'Only an administrator can delete products';
  END IF;
  SELECT * INTO v_row FROM products WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF COALESCE(v_row.current_stock, 0) <> 0 THEN
    RAISE EXCEPTION '% still has % % in the Warehouse -- move or clear that stock first',
      v_row.name, trim_scale(v_row.current_stock), COALESCE(v_row.unit, '');
  END IF;
  v_held := COALESCE((SELECT SUM(quantity) FROM rep_stock WHERE product_id = p_id), 0);
  IF v_held <> 0 THEN
    RAISE EXCEPTION 'Marketers / the shop still hold % % of % -- clear that first',
      trim_scale(v_held), COALESCE(v_row.unit, ''), v_row.name;
  END IF;

  -- Anything that refers to it (one-column foreign keys to products).
  FOR v_fk IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'public.products'::regclass AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', v_fk.tbl, v_fk.col) INTO v_used USING p_id;
    EXIT WHEN v_used;
  END LOOP;
  -- Ledger rows that name a product without a foreign key.
  v_used := v_used
    OR EXISTS (SELECT 1 FROM container_movements WHERE product_id = p_id)
    OR EXISTS (SELECT 1 FROM sale_items WHERE product_id = p_id);

  IF v_used THEN
    UPDATE products SET active = false, updated_at = now() WHERE id = p_id;
  ELSE
    DELETE FROM products WHERE id = p_id;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, CASE WHEN v_used THEN 'deactivate' ELSE 'delete' END, 'products', p_id::text,
          to_jsonb(v_row),
          jsonb_build_object('mode', CASE WHEN v_used THEN 'deactivated (has history)' ELSE 'deleted' END));
  RETURN jsonb_build_object('mode', CASE WHEN v_used THEN 'deactivated' ELSE 'deleted' END, 'name', v_row.name);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_product(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_product(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
