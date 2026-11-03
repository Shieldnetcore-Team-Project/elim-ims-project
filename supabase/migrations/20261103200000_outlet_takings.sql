-- ============================================================================
-- Retail Outlet: the shop's takings by payment method over a period
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "in the retail shop, create a card to show sales via POS
-- and cash". Counted as the day close counts money (_outlet_day_figures):
-- money taken at the till on the shop's posted sales, plus later payments the
-- shop collected (collected_by_rep = the shop), less refunds to customers --
-- over p_from..p_to (Lagos days), per payment method.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.outlet_takings(p_outlet uuid, p_from date, p_to date)
RETURNS TABLE(payment_method text, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._outlet_recon_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sales_reps WHERE id = p_outlet AND kind = 'outlet') THEN
    RAISE EXCEPTION 'Retail outlet not found';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;

  RETURN QUERY
  WITH till AS (
    SELECT p.payment_method::text AS m, p.amount
      FROM payments_received p JOIN sales s ON s.id = p.sale_id
     WHERE s.sales_rep_id = p_outlet AND s.status = 'posted' AND s.deleted_at IS NULL
       AND NOT COALESCE(s.is_pr, false) AND s.sale_date BETWEEN p_from AND p_to
       AND p.at_point_of_sale AND p.status NOT IN ('reversed', 'rejected')
  ), later AS (
    SELECT p.payment_method::text, p.amount
      FROM payments_received p
     WHERE p.collected_by_rep = p_outlet AND NOT p.at_point_of_sale
       AND p.payment_date BETWEEN p_from AND p_to AND p.status NOT IN ('reversed', 'rejected')
  ), refunds AS (
    SELECT CASE WHEN refund_method = 'cash' THEN 'cash' ELSE COALESCE(refund_method::text, 'transfer') END,
           -refund_amount
      FROM sales_returns
     WHERE sales_rep_id = p_outlet AND return_date BETWEEN p_from AND p_to
       AND status = 'completed' AND refund_amount > 0
  )
  SELECT x.m, SUM(x.amount)
    FROM (SELECT * FROM till UNION ALL SELECT * FROM later UNION ALL SELECT * FROM refunds) x(m, amount)
   GROUP BY x.m;
END;
$$;
REVOKE ALL ON FUNCTION public.outlet_takings(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.outlet_takings(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
