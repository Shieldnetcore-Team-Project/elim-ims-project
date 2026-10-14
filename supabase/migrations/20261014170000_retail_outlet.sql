-- ============================================================================
-- Retail outlet: the company's own shop, stocked from the Warehouse
-- ----------------------------------------------------------------------------
-- The Warehouse posts finished products to four places: walk-in customers and
-- registered customers/distributors (a direct sale), sales reps (dispatch to
-- van stock), and the company's own retail outlet. The outlet holds its own
-- stock and sells it to walk-in customers.
--
-- An outlet behaves exactly like a sales rep's van as a stock holder, so it
-- reuses that machinery instead of a parallel one: dispatch (warehouse stock
-- down, outlet stock up), sales from the holder's stock, inspected returns
-- back to the warehouse, dispatch reversal, and the cash reconciliation
-- account. sales_reps gains a `kind`:
--   'rep'     a field sales rep / marketer (the default; all existing rows)
--   'outlet'  a company retail outlet
--
-- Outlets are not marketers, so:
--   * outlet sales earn no commission (_sales_capture_commission)
--   * outlets are left out of marketer_performance (Performance & commission)
-- The app also keeps outlets out of customer assignment and collections.
--
-- seed_retail_outlet() creates one active "Retail Outlet" in the water factory
-- if the factory has no outlet yet; go_live_reset.sql runs it after wiping.
-- ============================================================================

ALTER TABLE public.sales_reps
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'rep' CHECK (kind IN ('rep', 'outlet'));

-- ============ Commission: reps only ============
CREATE OR REPLACE FUNCTION public._sales_capture_commission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' AND NEW.sales_rep_id IS NOT NULL
     AND NOT COALESCE(NEW.is_pr, false)
     AND EXISTS (SELECT 1 FROM sales_reps r WHERE r.id = NEW.sales_rep_id AND r.kind = 'rep') THEN
    UPDATE sale_items si
       SET commission_per_unit = COALESCE(
             (SELECT r.amount_per_unit FROM product_commission_rates r WHERE r.product_id = si.product_id), 0)
     WHERE si.sale_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- ============ Performance & commission: reps only ============
-- Same as 20260928130000 except the final WHERE keeps r.kind = 'rep'.
CREATE OR REPLACE FUNCTION public.marketer_performance(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(
  sales_rep_id uuid, full_name text, rep_status text,
  sales_count bigint, units_sold numeric, sales_value numeric,
  commission_earned numeric, units_returned numeric, commission_reversed numeric,
  net_commission numeric, cash_remitted numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  WITH s AS (
    SELECT sa.id, sa.sales_rep_id
      FROM sales sa
     WHERE sa.factory_id = p_factory AND sa.sales_rep_id IS NOT NULL
       AND sa.status = 'posted' AND sa.deleted_at IS NULL AND NOT COALESCE(sa.is_pr, false)
       AND sa.sale_date BETWEEN p_from AND p_to
  ), lines AS (
    SELECT s.sales_rep_id, count(DISTINCT s.id) AS n,
           SUM(si.quantity) AS units, SUM(si.line_total) AS value,
           SUM(si.quantity * si.commission_per_unit) AS commission
      FROM s JOIN sale_items si ON si.sale_id = s.id
     GROUP BY s.sales_rep_id
  ), ret AS (
    SELECT s.sales_rep_id,
           SUM(sr.accepted_quantity) AS units,
           SUM(sr.accepted_quantity * COALESCE(
                 (SELECT max(si.commission_per_unit) FROM sale_items si
                   WHERE si.sale_id = sr.sale_id AND si.product_id = sr.product_id), 0)) AS commission
      FROM sales_returns sr JOIN s ON s.id = sr.sale_id
     WHERE sr.status = 'completed' AND COALESCE(sr.accepted_quantity, 0) > 0
     GROUP BY s.sales_rep_id
  ), rem AS (
    SELECT rr.sales_rep_id, SUM(rr.amount) AS amount
      FROM rep_remittances rr
     WHERE rr.factory_id = p_factory AND rr.remittance_date BETWEEN p_from AND p_to
     GROUP BY rr.sales_rep_id
  )
  SELECT r.id, r.full_name, r.status,
         COALESCE(l.n, 0), COALESCE(l.units, 0), COALESCE(l.value, 0),
         round(COALESCE(l.commission, 0), 2), COALESCE(t.units, 0), round(COALESCE(t.commission, 0), 2),
         round(GREATEST(COALESCE(l.commission, 0) - COALESCE(t.commission, 0), 0), 2),
         COALESCE(m.amount, 0)
    FROM sales_reps r
    LEFT JOIN lines l ON l.sales_rep_id = r.id
    LEFT JOIN ret t ON t.sales_rep_id = r.id
    LEFT JOIN rem m ON m.sales_rep_id = r.id
   WHERE r.factory_id = p_factory AND r.kind = 'rep'
     AND (r.status = 'active' OR l.n IS NOT NULL OR m.amount IS NOT NULL)
   ORDER BY COALESCE(l.value, 0) DESC, r.full_name;
END;
$$;

-- ============ Default outlet ============
CREATE OR REPLACE FUNCTION public.seed_retail_outlet()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_factory uuid;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN RETURN 0; END IF;
  IF EXISTS (SELECT 1 FROM sales_reps WHERE factory_id = v_factory AND kind = 'outlet') THEN
    RETURN 0;
  END IF;
  INSERT INTO sales_reps (factory_id, code, full_name, status, kind, remarks)
  VALUES (v_factory, 'OUTLET-01', 'Retail Outlet', 'active', 'outlet',
          'Company retail outlet — stocked from the Warehouse, sells to walk-in customers.');
  RETURN 1;
END;
$$;
REVOKE ALL ON FUNCTION public.seed_retail_outlet() FROM PUBLIC, anon, authenticated;

SELECT public.seed_retail_outlet();
