-- ============================================================================
-- Record sold Jug + Water: empties handed in no longer shrink the limit
-- ----------------------------------------------------------------------------
-- User (2026-11-18): H MEDIX got 50 Dispenser Water and had only 49 empties to
-- swap, so 1 is a complete Jug + Water. Recording it failed with "H MEDIX has
-- only 0 dispenser jug(s) out".
--
-- Why: 20261118090000 took every empty jug the customer ever returned off the
-- dispensers supplied. But a Dispenser Water supply is a swap -- the empties
-- handed in are the exchange for the full ones, and some are jugs from before
-- tracking started -- so they wiped out the limit.
-- Now: dispensers supplied (not already Jug + Water) - unsold dispensers
-- returned - jugs already recorded sold. Accounts still confirms the invoice.
-- Paste into the Supabase SQL Editor. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._customer_jugs_sellable(p_customer uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH supplied AS (
    SELECT COALESCE(SUM(si.quantity * j.per_unit), 0) AS q
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      CROSS JOIN LATERAL public._product_jug(si.product_id) j
     WHERE s.customer_id = p_customer AND s.status = 'posted' AND s.deleted_at IS NULL
       AND NOT COALESCE(s.is_pr, false)
       AND si.jar_mode IS DISTINCT FROM 'permanent'
  ), back AS (
    SELECT COALESCE(SUM(r.quantity_returned * j.per_unit), 0) AS q
      FROM sales_returns r
      JOIN sales s ON s.id = r.sale_id
      CROSS JOIN LATERAL public._product_jug(r.product_id) j
     WHERE s.customer_id = p_customer AND r.status <> 'cancelled'
       AND EXISTS (SELECT 1 FROM sale_items si
                    WHERE si.sale_id = r.sale_id AND si.product_id = r.product_id
                      AND si.jar_mode IS DISTINCT FROM 'permanent')
  ), sold AS (
    SELECT COALESCE(SUM((a.new_value->>'quantity')::numeric), 0) AS q
      FROM audit_logs a
      JOIN sales s ON s.id::text = a.entity_id
     WHERE a.action = 'record_sold_dispenser_jugs' AND s.customer_id = p_customer
       AND s.deleted_at IS NULL AND s.status = 'posted'
  )
  SELECT GREATEST(supplied.q - back.q - sold.q, 0)
    FROM supplied, back, sold;
$$;
REVOKE ALL ON FUNCTION public._customer_jugs_sellable(uuid) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
