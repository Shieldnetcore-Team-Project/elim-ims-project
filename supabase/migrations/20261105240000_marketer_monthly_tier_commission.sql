-- Monthly marketer commission tiers.
-- Status A: NGN 22,000,000 target / NGN 200,000 commission.
-- Status B: NGN 11,000,000 target / NGN 90,000 commission.
ALTER TABLE public.sales_reps
  ADD COLUMN IF NOT EXISTS commission_tier text
    CHECK (
      commission_tier IS NULL
      OR (kind = 'rep' AND commission_tier IN ('A', 'B'))
    );

-- Per-unit commissions are replaced for new sales. Existing captured values
-- remain intact for historical records.
CREATE OR REPLACE FUNCTION public._sales_capture_commission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted'
     AND NEW.sales_rep_id IS NOT NULL AND NOT COALESCE(NEW.is_pr, false)
     AND EXISTS (
       SELECT 1 FROM public.sales_reps r
        WHERE r.id = NEW.sales_rep_id AND r.kind = 'rep'
     ) THEN
    UPDATE sale_items
       SET commission_per_unit = 0
     WHERE sale_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.marketer_monthly_tier_commission(
  p_factory uuid,
  p_from date,
  p_to date
)
RETURNS TABLE(
  month date,
  sales_rep_id uuid,
  marketer text,
  code text,
  tier text,
  target numeric,
  posted numeric,
  returned numeric,
  net_posted numeric,
  remitted numeric,
  eligible_value numeric,
  achievement numeric,
  commission numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (
    public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'payments'::module_key, 'view'::action_key)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Choose a valid date range';
  END IF;
  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Choose at most one year';
  END IF;

  RETURN QUERY
  WITH months AS (
    SELECT m.month_start::date AS month
      FROM generate_series(
        date_trunc('month', p_from)::date,
        date_trunc('month', p_to)::date,
        interval '1 month'
      ) AS m(month_start)
  ), reps AS (
    SELECT r.id, r.full_name, r.code, r.status, r.commission_tier
      FROM public.sales_reps r
     WHERE r.factory_id = p_factory AND r.kind = 'rep'
  ), posted_by_month AS (
    SELECT date_trunc('month', d.dispatch_date)::date AS month,
           d.sales_rep_id AS rep_id,
           SUM(d.total_value) AS value
      FROM public.stock_dispatches d
     WHERE d.factory_id = p_factory
       AND d.status::text <> 'reversed'
       AND d.dispatch_date >= date_trunc('month', p_from)::date
       AND d.dispatch_date < (date_trunc('month', p_to) + interval '1 month')::date
     GROUP BY 1, 2
  ), returned_by_month AS (
    SELECT date_trunc('month', rr.return_date)::date AS month,
           rr.sales_rep_id AS rep_id,
           SUM(COALESCE(ri.accepted_quantity, ri.quantity_returned) * ri.unit_price) AS value
      FROM public.rep_returns rr
      JOIN public.rep_return_items ri ON ri.rep_return_id = rr.id
     WHERE rr.factory_id = p_factory
       AND rr.status::text = 'completed'
       AND rr.return_date >= date_trunc('month', p_from)::date
       AND rr.return_date < (date_trunc('month', p_to) + interval '1 month')::date
     GROUP BY 1, 2
  ), remitted_by_month AS (
    SELECT date_trunc('month', rm.remittance_date)::date AS month,
           rm.sales_rep_id AS rep_id,
           SUM(rm.amount) AS value
      FROM public.rep_remittances rm
     WHERE rm.factory_id = p_factory
       AND rm.remittance_date >= date_trunc('month', p_from)::date
       AND rm.remittance_date < (date_trunc('month', p_to) + interval '1 month')::date
     GROUP BY 1, 2
  ), result AS (
    SELECT mo.month, r.id AS rep_id, r.full_name, r.code, r.commission_tier,
           CASE r.commission_tier WHEN 'A' THEN 22000000::numeric
                                  WHEN 'B' THEN 11000000::numeric ELSE 0::numeric END AS target_value,
           COALESCE(p.value, 0)::numeric AS posted_value,
           COALESCE(ret.value, 0)::numeric AS returned_value,
           GREATEST(COALESCE(p.value, 0) - COALESCE(ret.value, 0), 0)::numeric AS net_posted_value,
           COALESCE(rm.value, 0)::numeric AS remitted_value
      FROM months mo
      CROSS JOIN reps r
      LEFT JOIN posted_by_month p ON p.month = mo.month AND p.rep_id = r.id
      LEFT JOIN returned_by_month ret ON ret.month = mo.month AND ret.rep_id = r.id
      LEFT JOIN remitted_by_month rm ON rm.month = mo.month AND rm.rep_id = r.id
     WHERE r.status = 'active'
        OR p.rep_id IS NOT NULL
        OR ret.rep_id IS NOT NULL
        OR rm.rep_id IS NOT NULL
  )
  SELECT result.month, result.rep_id, result.full_name::text, result.code::text,
         result.commission_tier::text, result.target_value,
         result.posted_value, result.returned_value, result.net_posted_value,
         result.remitted_value,
         LEAST(result.net_posted_value, result.remitted_value),
         CASE WHEN result.target_value > 0
              THEN ROUND(LEAST(result.net_posted_value, result.remitted_value) / result.target_value * 100, 2)
              ELSE NULL END,
         CASE WHEN result.target_value > 0
                    AND LEAST(result.net_posted_value, result.remitted_value) >= result.target_value
              THEN CASE result.commission_tier WHEN 'A' THEN 200000::numeric
                                               WHEN 'B' THEN 90000::numeric ELSE 0::numeric END
              ELSE 0::numeric END
    FROM result
   ORDER BY result.month, result.full_name;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_monthly_tier_commission(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_monthly_tier_commission(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
