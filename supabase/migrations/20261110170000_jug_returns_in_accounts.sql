-- ============================================================================
-- Every recorded empty-jug return shows on the Accounts side
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "all recorded return of empty jugs as qc enters them into
-- the system by marketers name, it should reflect on the marketers,
-- distributors and retail account in the account department".
--
-- Before, a marketer's / the shop's account (rep_account_summary) took off
-- only returns the Warehouse recorded and QC then counted (jug_returns). Empties
-- QC entered herself (Record movement) never cleared the jugs owed, and the
-- distributors' accounts showed no jugs at all.
-- Now:
--   * rep_account_summary  jugs owed = jugs posted - unsold dispensers back -
--     EVERY empty returned on the ledger (source 'return': QC's count of a
--     Warehouse return, or QC's own Record movement), Old and New Jug as one.
--     jugs_returned = empties returned in the period (all of them).
--   * account_jugs(factory, from, to)  per marketer / the shop / distributor:
--     jugs given, empties returned in the period, last return, and jugs still
--     with them now -- for the Accounts tables. Read only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rep_account_summary(p_sales_rep_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_goods_out numeric := 0;
  v_accepted numeric := 0;
  v_written_off numeric := 0;
  v_damaged numeric := 0;
  v_rejected numeric := 0;
  v_cash numeric := 0;
  v_credit numeric := 0;
  v_collected numeric := 0;
  v_van_value numeric := 0;
  v_sales_count int := 0;
  v_sales_value numeric := 0;
  v_jugs_back numeric := 0;
  v_jugs_value numeric := 0;
  v_jugs_owed numeric := 0;
  v_jugs_owed_value numeric := 0;
  v_jugs_returned numeric := 0;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT COALESCE(SUM(sdi.line_value), 0) INTO v_goods_out
  FROM stock_dispatch_items sdi
  JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
  WHERE sd.sales_rep_id = p_sales_rep_id AND sd.status = 'posted'
    AND (p_from IS NULL OR sd.dispatch_date >= p_from)
    AND (p_to   IS NULL OR sd.dispatch_date <= p_to);

  SELECT
    COALESCE(SUM(COALESCE(rri.accepted_quantity,0) * rri.unit_price), 0),
    COALESCE(SUM(CASE WHEN NOT rri.charge_rep THEN (rri.damaged_quantity + rri.rejected_quantity) * rri.unit_price ELSE 0 END), 0),
    COALESCE(SUM(rri.damaged_quantity * rri.unit_price), 0),
    COALESCE(SUM(rri.rejected_quantity * rri.unit_price), 0)
  INTO v_accepted, v_written_off, v_damaged, v_rejected
  FROM rep_return_items rri
  JOIN rep_returns rr ON rr.id = rri.rep_return_id
  WHERE rr.sales_rep_id = p_sales_rep_id AND rr.status = 'completed'
    AND (p_from IS NULL OR rr.return_date >= p_from)
    AND (p_to   IS NULL OR rr.return_date <= p_to);

  SELECT COALESCE(SUM(amount), 0) INTO v_cash
  FROM rep_remittances
  WHERE sales_rep_id = p_sales_rep_id
    AND (p_from IS NULL OR remittance_date >= p_from)
    AND (p_to   IS NULL OR remittance_date <= p_to);

  SELECT COALESCE(SUM(outstanding), 0) INTO v_credit
  FROM debts
  WHERE sales_rep_id = p_sales_rep_id AND status <> 'paid';

  v_collected := public._rep_credit_collected(p_sales_rep_id);

  -- Old money credits for jugs (before 2026-11-03), only where there are any.
  SELECT COALESCE(SUM(j.quantity_received), 0), COALESCE(SUM(j.quantity_received * j.credit_price), 0)
    INTO v_jugs_back, v_jugs_value
    FROM jug_returns j
   WHERE j.sales_rep_id = p_sales_rep_id AND j.status = 'verified' AND j.credit_price IS NOT NULL
     AND (p_from IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
     AND (p_to   IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date <= p_to);

  -- Every empty jug returned, however it was entered (2026-11-10).
  SELECT COALESCE(SUM(m.quantity), 0) INTO v_jugs_returned
    FROM container_movements m
    JOIN container_types ct ON ct.id = m.container_type_id
   WHERE m.from_type = 'sales_rep' AND m.from_id = p_sales_rep_id AND m.source = 'return'
     AND ct.name ~* 'jug|dispenser'
     AND (p_from IS NULL OR public._jug_day(m.created_at) >= p_from)
     AND (p_to   IS NULL OR public._jug_day(m.created_at) <= p_to);

  -- Rule A (2026-11-03): every jug that went out with a posting and has not
  -- come back -- in an unsold dispenser or as an empty returned -- is owed at
  -- the jug's price. Old and New Dispenser Jug are one (2026-11-10).
  WITH moves AS (
    SELECT pj.container_type_id AS t, sdi.quantity * pj.per_unit AS q
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_sales_rep_id AND sd.status = 'posted' AND sdi.jar_mode IS NULL
       AND (p_from IS NULL OR sd.dispatch_date >= p_from)
       AND (p_to   IS NULL OR sd.dispatch_date <= p_to)
    UNION ALL
    SELECT pj.container_type_id, -COALESCE(rri.accepted_quantity, 0) * pj.per_unit
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.sales_rep_id = p_sales_rep_id AND rr.status = 'completed' AND rri.jar_mode IS NULL
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_to   IS NULL OR rr.return_date <= p_to)
    UNION ALL
    SELECT m.container_type_id, -m.quantity
      FROM container_movements m
     WHERE m.from_type = 'sales_rep' AND m.from_id = p_sales_rep_id AND m.source = 'return'
       AND (p_from IS NULL OR public._jug_day(m.created_at) >= p_from)
       AND (p_to   IS NULL OR public._jug_day(m.created_at) <= p_to)
  ), priced AS (
    SELECT CASE WHEN ct.name ~* 'jug|dispenser' THEN 'jug' ELSE ct.id::text END AS g,
           moves.q, COALESCE(e.unit_price, ct.jar_price, 0) AS price
      FROM moves
      JOIN container_types ct ON ct.id = moves.t
      LEFT JOIN LATERAL public._jug_empty_product(ct.id, ct.factory_id) e ON true
  ), per AS (
    SELECT g, GREATEST(SUM(q), 0) AS owed, MAX(price) AS price FROM priced GROUP BY g
  )
  SELECT COALESCE(SUM(owed), 0), COALESCE(SUM(owed * price), 0)
    INTO v_jugs_owed, v_jugs_owed_value
    FROM per;

  SELECT COALESCE(SUM(rs.quantity * p.unit_price), 0) INTO v_van_value
  FROM rep_stock rs JOIN products p ON p.id = rs.product_id
  WHERE rs.sales_rep_id = p_sales_rep_id;

  SELECT COUNT(*), COALESCE(SUM(grand_total), 0) INTO v_sales_count, v_sales_value
  FROM sales
  WHERE sales_rep_id = p_sales_rep_id
    AND status = 'posted' AND deleted_at IS NULL AND NOT COALESCE(is_pr, false)
    AND (p_from IS NULL OR sale_date >= p_from)
    AND (p_to   IS NULL OR sale_date <= p_to);

  RETURN jsonb_build_object(
    'goods_out_value', v_goods_out,
    'accepted_returns_value', v_accepted + v_written_off,
    'accepted_only_value', v_accepted,
    'written_off_value', v_written_off,
    'damaged_value', v_damaged,
    'rejected_value', v_rejected,
    'cash_remitted', v_cash,
    'credit_outstanding', v_credit,
    'credit_collected', v_collected,
    'van_stock_value', v_van_value,
    'sales_count', v_sales_count,
    'sales_value', v_sales_value,
    'empty_jugs_returned', v_jugs_back,
    'empty_jugs_value', v_jugs_value,
    'jugs_returned', v_jugs_returned,
    'jugs_owed', v_jugs_owed,
    'jugs_owed_value', v_jugs_owed_value,
    'net_balance_owed', v_goods_out - (v_accepted + v_written_off) - v_jugs_value + v_jugs_owed_value
                        - v_cash - v_credit - v_collected
  );
END;
$fn$;

-- ---------------------------------------------------------------- per account
CREATE OR REPLACE FUNCTION public.account_jugs(p_factory uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE(holder_type text, holder_id uuid, holder_name text, holder_kind text,
              given numeric, returned numeric, last_returned date, with_them numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF NOT (public.has_permission(v_uid, 'finance'::module_key, 'view'::action_key)
          OR public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key)
          OR public.has_permission(v_uid, 'marketer-accounts'::module_key, 'view'::action_key)
          OR public.has_permission(v_uid, 'distributor-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(v_uid, p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH jt AS (
    SELECT ct.id FROM container_types ct WHERE ct.factory_id = p_factory AND ct.name ~* 'jug|dispenser'
  ), mv AS (
    SELECT m.to_type AS ht, m.to_id AS hid, m.quantity AS q, m.source AS src, m.created_at AS at, true AS inbound
      FROM container_movements m
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.to_type IN ('sales_rep', 'customer') AND m.to_id IS NOT NULL
    UNION ALL
    SELECT m.from_type, m.from_id, -m.quantity, m.source, m.created_at, false
      FROM container_movements m
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.from_type IN ('sales_rep', 'customer') AND m.from_id IS NOT NULL
  ), g AS (
    SELECT ht, hid,
           SUM(q) FILTER (WHERE inbound AND src NOT IN ('count', 'issue')
                            AND (p_from IS NULL OR public._jug_day(at) >= p_from)
                            AND (p_to IS NULL OR public._jug_day(at) <= p_to)) AS given,
           SUM(-q) FILTER (WHERE src = 'return'
                             AND (p_from IS NULL OR public._jug_day(at) >= p_from)
                             AND (p_to IS NULL OR public._jug_day(at) <= p_to)) AS returned,
           MAX(public._jug_day(at)) FILTER (WHERE src = 'return') AS last_ret,
           SUM(q) AS held
      FROM mv GROUP BY ht, hid
  )
  SELECT g.ht, g.hid, COALESCE(sr.full_name, c.name, '(unknown)')::text,
         CASE WHEN g.ht = 'customer' THEN 'customer' ELSE COALESCE(sr.kind, 'rep') END::text,
         COALESCE(g.given, 0), COALESCE(g.returned, 0), g.last_ret, GREATEST(COALESCE(g.held, 0), 0)
    FROM g
    LEFT JOIN sales_reps sr ON g.ht = 'sales_rep' AND sr.id = g.hid
    LEFT JOIN customers c ON g.ht = 'customer' AND c.id = g.hid
   ORDER BY 3;
END;
$fn$;
REVOKE ALL ON FUNCTION public.account_jugs(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_jugs(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
