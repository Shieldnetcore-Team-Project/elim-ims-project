-- ============================================================================
-- Marketer commission on what they remit, by achievement band
-- ----------------------------------------------------------------------------
-- User (2026-11-04): "add commission rate to every marketer ... his
-- commission is on the amount he remitted and the commission rate is amount
-- remitted / target amount x 100", bands 50-59.99% ... 100%. Decisions:
--   * each marketer has a commission rate: a % of what they remit;
--   * target = the value of goods posted to them that day, less what they
--     returned that day (never below 0);
--   * achievement = remitted / target x 100, worked out per marketer per day;
--   * the band pays its floor: 50-59.99% achieved pays 50% of the commission,
--     60-69.99% pays 60%, 70-79.99% 70%, 80-89.99% 80%, 90-99.99% 90%,
--     100% or more 100%; below 50% pays nothing;
--   * commission = remitted x rate% x band%.
-- Example: posted 22,000,000, remitted 1,200,000 -> 5.45% -> no commission;
-- remitted 14,000,000 at 5% -> 63.6% -> band 60% -> 14,000,000 x 5% x 60%
-- = 420,000.
--
--   sales_reps.commission_rate          the marketer's rate (% of remitted)
--   set_marketer_commission_rate(rep, rate)   Accounts (payments / debts
--                 write) or distribution approve; audited
--   marketer_daily_commission(factory, from, to)   per marketer per day
-- The per-product commission on sales (20260928130000) is left as it is.
-- ============================================================================

ALTER TABLE public.sales_reps
  ADD COLUMN IF NOT EXISTS commission_rate numeric(5,2) NOT NULL DEFAULT 0
    CHECK (commission_rate >= 0 AND commission_rate <= 100);

CREATE OR REPLACE FUNCTION public.set_marketer_commission_rate(p_rep uuid, p_rate numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_rep sales_reps%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key)
          OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)
          OR public.has_permission(v_uid, 'distribution'::module_key, 'approve'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_rep FOR UPDATE;
  IF NOT FOUND OR v_rep.kind <> 'rep' THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_rate IS NULL OR p_rate < 0 OR p_rate > 100 THEN RAISE EXCEPTION 'Enter a rate from 0 to 100%%'; END IF;
  UPDATE sales_reps SET commission_rate = p_rate WHERE id = p_rep;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_rep.factory_id, 'set_commission_rate', 'sales_reps', p_rep::text,
          jsonb_build_object('commission_rate', v_rep.commission_rate),
          jsonb_build_object('commission_rate', p_rate, 'who', v_rep.full_name));
  RETURN jsonb_build_object('rate', p_rate);
END;
$$;
REVOKE ALL ON FUNCTION public.set_marketer_commission_rate(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_marketer_commission_rate(uuid, numeric) TO authenticated;

-- The band a day's achievement earns (0, 50, 60, 70, 80, 90, 100).
CREATE OR REPLACE FUNCTION public._commission_band(p_achievement numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_achievement IS NULL OR p_achievement < 50 THEN 0
              WHEN p_achievement >= 100 THEN 100
              ELSE floor(p_achievement / 10) * 10 END;
$$;

CREATE OR REPLACE FUNCTION public.marketer_daily_commission(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(day date, sales_rep_id uuid, marketer text, code text, rate numeric, posted numeric,
              returned numeric, target numeric, remitted numeric, achievement numeric, band numeric,
              full_commission numeric, commission numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
          OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)
          OR public.has_permission(auth.uid(), 'payments'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose at most one year'; END IF;
  RETURN QUERY
  WITH reps AS (
    SELECT r.id, r.full_name, r.code, r.commission_rate FROM sales_reps r
     WHERE r.factory_id = p_factory AND r.kind = 'rep'
  ), p AS (
    SELECT d.sales_rep_id AS rep, d.dispatch_date AS dy, SUM(d.total_value) AS v
      FROM stock_dispatches d
     WHERE d.factory_id = p_factory AND d.status::text <> 'reversed' AND d.dispatch_date BETWEEN p_from AND p_to
     GROUP BY 1, 2
  ), b AS (
    SELECT r.sales_rep_id AS rep, r.return_date AS dy,
           SUM(COALESCE(i.accepted_quantity, i.quantity_returned) * i.unit_price) AS v
      FROM rep_returns r JOIN rep_return_items i ON i.rep_return_id = r.id
     WHERE r.factory_id = p_factory AND r.status::text = 'completed' AND r.return_date BETWEEN p_from AND p_to
     GROUP BY 1, 2
  ), m AS (
    SELECT x.sales_rep_id AS rep, x.remittance_date AS dy, SUM(x.amount) AS v
      FROM rep_remittances x
     WHERE x.factory_id = p_factory AND x.remittance_date BETWEEN p_from AND p_to
     GROUP BY 1, 2
  ), days AS (
    SELECT rep, dy FROM p UNION SELECT rep, dy FROM b UNION SELECT rep, dy FROM m
  ), t AS (
    SELECT dd.dy, r.id AS rep, r.full_name, r.code, r.commission_rate AS rate,
           COALESCE(p.v, 0) AS posted, COALESCE(b.v, 0) AS returned,
           GREATEST(COALESCE(p.v, 0) - COALESCE(b.v, 0), 0) AS target, COALESCE(m.v, 0) AS remitted
      FROM days dd JOIN reps r ON r.id = dd.rep
      LEFT JOIN p ON p.rep = dd.rep AND p.dy = dd.dy
      LEFT JOIN b ON b.rep = dd.rep AND b.dy = dd.dy
      LEFT JOIN m ON m.rep = dd.rep AND m.dy = dd.dy
  ), a AS (
    SELECT t.*, CASE WHEN t.target > 0 THEN round(t.remitted / t.target * 100, 2) END AS ach FROM t
  )
  SELECT a.dy, a.rep, a.full_name::text, a.code::text, a.rate, a.posted, a.returned, a.target, a.remitted,
         a.ach, public._commission_band(a.ach),
         round(a.remitted * a.rate / 100, 2),
         round(a.remitted * a.rate / 100 * public._commission_band(a.ach) / 100, 2)
    FROM a
   ORDER BY a.dy, a.full_name;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_daily_commission(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_daily_commission(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
