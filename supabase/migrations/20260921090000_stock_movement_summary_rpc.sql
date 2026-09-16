-- ============================================================================
-- STOCK MOVEMENT SUMMARY — one row per product: opening/closing stock plus
-- production/sold/PR/damages for a date range. Feeds a new table on the
-- Sales Returns page (Opening Stock | New Production | Quantity Sold | PR |
-- Damages | Closing Stock), scoped to one factory at a time.
-- ----------------------------------------------------------------------------
-- Sign conventions in inventory_movements are inconsistent by history:
-- 'produced'/'sold' store a positive quantity magnitude (see create_sale()
-- and confirm_production_batch()), while 'damaged' write-offs store a
-- negative quantity_delta (see post_stock_adjustment()). ABS() below
-- normalizes all four movement sums to positive magnitudes for display.
--
-- PR vs ordinary Quantity Sold: create_sale() tags a complimentary/no-charge
-- sale's inventory_movements row with reason = 'PR - complimentary, no
-- charge' (see 20260917090000_pr_giveaway_sales.sql) — that exact string is
-- the only signal distinguishing a PR sale from a normal one at the
-- inventory_movements level, so it's matched literally here.
--
-- DAMAGES intentionally reads only movement_type = 'damaged' (standalone
-- write-offs posted via post_stock_adjustment), not sales-return damage —
-- a sales return's damaged/rejected portion was already deducted from stock
-- at the original sale (counted in Quantity Sold) and never re-enters
-- inventory_movements, so counting it again here would double-subtract it
-- from the Opening -> Closing reconciliation.
--
-- Opening/closing stock fall back to products.current_stock when a product
-- had no inventory_movements row inside the requested range (nothing moved,
-- so opening == closing == current for that product).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_stock_movement_summary(
  p_factory_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE(
  product_id uuid,
  product_name text,
  unit text,
  opening_stock numeric,
  new_production numeric,
  quantity_sold numeric,
  pr numeric,
  damages numeric,
  closing_stock numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'sales-returns'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_factory_id IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.unit,
    COALESCE(open_mv.quantity_before, p.current_stock)::numeric AS opening_stock,
    COALESCE(prod.qty, 0)::numeric AS new_production,
    COALESCE(sold.qty, 0)::numeric AS quantity_sold,
    COALESCE(pr.qty, 0)::numeric AS pr,
    COALESCE(dmg.qty, 0)::numeric AS damages,
    COALESCE(close_mv.quantity_after, p.current_stock)::numeric AS closing_stock
  FROM products p
  LEFT JOIN LATERAL (
    SELECT quantity_before FROM inventory_movements im
    WHERE im.product_id = p.id AND im.created_at >= p_start AND im.created_at <= p_end
    ORDER BY im.created_at ASC, im.id ASC LIMIT 1
  ) open_mv ON true
  LEFT JOIN LATERAL (
    SELECT quantity_after FROM inventory_movements im
    WHERE im.product_id = p.id AND im.created_at >= p_start AND im.created_at <= p_end
    ORDER BY im.created_at DESC, im.id DESC LIMIT 1
  ) close_mv ON true
  LEFT JOIN LATERAL (
    SELECT SUM(ABS(im.quantity)) qty FROM inventory_movements im
    WHERE im.product_id = p.id AND im.movement_type = 'produced'
      AND im.created_at >= p_start AND im.created_at <= p_end
  ) prod ON true
  LEFT JOIN LATERAL (
    SELECT SUM(ABS(im.quantity)) qty FROM inventory_movements im
    WHERE im.product_id = p.id AND im.movement_type = 'sold'
      AND COALESCE(im.reason, '') <> 'PR - complimentary, no charge'
      AND im.created_at >= p_start AND im.created_at <= p_end
  ) sold ON true
  LEFT JOIN LATERAL (
    SELECT SUM(ABS(im.quantity)) qty FROM inventory_movements im
    WHERE im.product_id = p.id AND im.movement_type = 'sold'
      AND im.reason = 'PR - complimentary, no charge'
      AND im.created_at >= p_start AND im.created_at <= p_end
  ) pr ON true
  LEFT JOIN LATERAL (
    SELECT SUM(ABS(im.quantity)) qty FROM inventory_movements im
    WHERE im.product_id = p.id AND im.movement_type = 'damaged'
      AND im.created_at >= p_start AND im.created_at <= p_end
  ) dmg ON true
  WHERE p.factory_id = p_factory_id AND p.active = true
  ORDER BY p.name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_stock_movement_summary(uuid, timestamptz, timestamptz) TO authenticated;
