-- ============================================================================
-- QC -> Dispenser Jug -> Accountability: day by day, from postings and returns
-- ----------------------------------------------------------------------------
-- User (2026-11-14): "it should be generating from the marketers postings and
-- returns on a daily basis and it should be accurate".
--
-- One daily calculation, _qc_jug_party_days(factory), feeds both screens, so
-- the day-by-day table and the "as of now" table always agree:
--
-- Marketers (from their postings and returns, on the posting / return day):
--   supplied    Dispenser Water posted (no type)      stock_dispatches.dispatch_date
--   opening     jug opening balances ('issue')         ledger day
--   unsold      Dispenser Water returned unsold        rep_returns.return_date
--   empties     empty jugs returned (QC count / Record movement, back-dates kept)
--   lost        jugs written off
--   bought      Jug + Water posted as such, less returned unsold (the jug is
--               theirs -- shown, never owed back)
--   with them   supplied + opening - unsold - empties - lost (full + empty).
--               A marketer answers for every jug posted until it comes back,
--               whether or not Accounts have recorded the sale.
-- Distributors / Office Delivery / marketers' customers (container ledger):
--   supplied    jugs that went to them on invoices, net of corrections
--   opening     opening balances / counts
--   unsold      unsold dispensers they returned
--   empties     empty jugs returned
--   lost        written off
--   sold_out    jugs they held that were billed as sold (kept by their buyers)
--   bought      Empty Jug / Jug + Water sold to them (theirs)
--   with them   supplied + opening - unsold - empties - lost - sold_out
--
-- qc_jug_holders(factory)            as of now (replaces 20261114090000:
--                                    marketers' openings and write-offs count)
-- qc_jug_holder_days(factory, from, to)  one row per person per day with any
--                                    posting / return, b/f and c/f, plus anyone
--                                    still holding jugs on a day nothing moved.
-- Read-only; changes nothing. Paste into the Supabase SQL Editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._qc_jug_party_days(p_factory uuid)
RETURNS TABLE(ht text, hid uuid, d date, supplied numeric, opening numeric, unsold numeric, empties numeric,
              lost numeric, sold_out numeric, bought numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH jt AS (
    SELECT ct.id FROM container_types ct WHERE ct.factory_id = p_factory AND ct.name ~* 'jug|dispenser'
  ), reps AS (
    SELECT sr.id FROM sales_reps sr WHERE sr.factory_id = p_factory AND COALESCE(sr.kind, 'rep') <> 'outlet'
  ), parts AS (
    -- Marketers: postings.
    SELECT 'sales_rep'::text AS ht, sd.sales_rep_id AS hid, sd.dispatch_date AS d,
           COALESCE(SUM(sdi.quantity * pj.per_unit) FILTER (WHERE sdi.jar_mode IS NULL), 0) AS supplied,
           0::numeric AS opening, 0::numeric AS unsold, 0::numeric AS empties, 0::numeric AS lost,
           0::numeric AS sold_out,
           COALESCE(SUM(sdi.quantity * pj.per_unit) FILTER (WHERE sdi.jar_mode = 'permanent'), 0) AS bought
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.factory_id = p_factory AND sd.status = 'posted' AND sd.sales_rep_id IN (SELECT id FROM reps)
     GROUP BY 1, 2, 3
    UNION ALL
    -- Marketers: unsold dispensers returned.
    SELECT 'sales_rep', rr.sales_rep_id, rr.return_date, 0, 0,
           COALESCE(SUM(COALESCE(rri.accepted_quantity, 0) * pj.per_unit) FILTER (WHERE rri.jar_mode IS NULL), 0),
           0, 0, 0,
           -COALESCE(SUM(COALESCE(rri.accepted_quantity, 0) * pj.per_unit) FILTER (WHERE rri.jar_mode = 'permanent'), 0)
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.status = 'completed' AND rr.sales_rep_id IN (SELECT id FROM reps)
     GROUP BY 1, 2, 3
    UNION ALL
    -- Marketers: empties returned, opening balances, write-offs (jug ledger).
    SELECT 'sales_rep', x.rid, public._jug_day(x.at), 0,
           COALESCE(SUM(x.q) FILTER (WHERE x.src = 'issue'), 0),
           0,
           COALESCE(SUM(-x.q) FILTER (WHERE x.src = 'return'), 0),
           COALESCE(SUM(-x.q) FILTER (WHERE x.src = 'lost'), 0),
           0, 0
      FROM (
        SELECT m.to_id AS rid, m.quantity AS q, m.source AS src, m.created_at AS at
          FROM container_movements m
         WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
           AND m.to_type = 'sales_rep' AND m.source IN ('issue', 'return', 'lost')
        UNION ALL
        SELECT m.from_id, -m.quantity, m.source, m.created_at
          FROM container_movements m
         WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
           AND m.from_type = 'sales_rep' AND m.source IN ('issue', 'return', 'lost')
      ) x
     WHERE x.rid IN (SELECT id FROM reps)
     GROUP BY 1, 2, 3
    UNION ALL
    -- Customers: their jug ledger, each movement in one column.
    SELECT 'customer', x.cid, public._jug_day(x.at),
           COALESCE(SUM(x.q) FILTER (WHERE x.cls = 'supplied'), 0),
           COALESCE(SUM(x.q) FILTER (WHERE x.cls = 'opening'), 0),
           COALESCE(SUM(-x.q) FILTER (WHERE x.cls = 'unsold'), 0),
           COALESCE(SUM(-x.q) FILTER (WHERE x.cls = 'empties'), 0),
           COALESCE(SUM(-x.q) FILTER (WHERE x.cls = 'lost'), 0),
           COALESCE(SUM(-x.q) FILTER (WHERE x.cls = 'sold_out'), 0),
           COALESCE(SUM(-x.q) FILTER (WHERE x.cls = 'sold_out'), 0)
      FROM (
        SELECT y.cid, y.q, y.at,
               CASE WHEN y.src = 'return' THEN 'empties'
                    WHEN y.src = 'customer_return' THEN 'unsold'
                    WHEN y.src = 'lost' THEN 'lost'
                    WHEN y.src IN ('jar_sold', 'jar_sold_reversal') THEN 'sold_out'
                    -- A count tied to an invoice belongs to that sale
                    -- (record_sold_dispenser_jugs); any other is an opening.
                    WHEN y.src IN ('issue', 'count') AND y.sale_id IS NULL THEN 'opening'
                    ELSE 'supplied' END AS cls
          FROM (
            SELECT m.to_id AS cid, m.quantity AS q, m.source AS src, m.created_at AS at, m.sale_id
              FROM container_movements m
             WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
               AND m.to_type = 'customer' AND m.to_id IS NOT NULL
            UNION ALL
            SELECT m.from_id, -m.quantity, m.source, m.created_at, m.sale_id
              FROM container_movements m
             WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
               AND m.from_type = 'customer' AND m.from_id IS NOT NULL
          ) y
      ) x
     GROUP BY 1, 2, 3
    UNION ALL
    -- Customers: Jug + Water sold straight to them (Warehouse / marketer ->
    -- outside on their invoice; never on their balance).
    SELECT 'customer', s.customer_id, public._jug_day(m.created_at), 0, 0, 0, 0, 0, 0,
           SUM(CASE WHEN m.to_type = 'external' THEN m.quantity
                    WHEN m.from_type = 'external' THEN -m.quantity ELSE 0 END)
      FROM container_movements m
      JOIN sales s ON s.id = m.sale_id
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.source IN ('jar_sold', 'jar_sold_reversal')
       AND m.from_type IS DISTINCT FROM 'customer' AND m.to_type IS DISTINCT FROM 'customer'
       AND s.customer_id IS NOT NULL
     GROUP BY 1, 2, 3
  )
  SELECT p.ht, p.hid, p.d, SUM(p.supplied), SUM(p.opening), SUM(p.unsold), SUM(p.empties), SUM(p.lost),
         SUM(p.sold_out), SUM(p.bought)
    FROM parts p
   WHERE p.hid IS NOT NULL
   GROUP BY 1, 2, 3;
$fn$;
REVOKE ALL ON FUNCTION public._qc_jug_party_days(uuid) FROM PUBLIC, anon, authenticated;

-- Names for a holder.
CREATE OR REPLACE FUNCTION public._qc_jug_party_names(p_factory uuid)
RETURNS TABLE(ht text, hid uuid, name text, code text, kind text, via text, phone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT 'sales_rep'::text, sr.id, sr.full_name::text, sr.code::text, 'rep'::text, NULL::text, sr.phone::text
    FROM sales_reps sr WHERE sr.factory_id = p_factory AND COALESCE(sr.kind, 'rep') <> 'outlet'
  UNION ALL
  SELECT 'customer', c.id, c.name::text, NULL, CASE WHEN c.sales_rep_id IS NULL THEN 'customer' ELSE 'rep_customer' END,
         vr.full_name::text, c.phone::text
    FROM customers c LEFT JOIN sales_reps vr ON vr.id = c.sales_rep_id
   WHERE c.factory_id = p_factory;
$fn$;
REVOKE ALL ON FUNCTION public._qc_jug_party_names(uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------ as of now --
DROP FUNCTION IF EXISTS public.qc_jug_holders(uuid);
CREATE FUNCTION public.qc_jug_holders(p_factory uuid)
RETURNS TABLE(holder_type text, holder_id uuid, holder_name text, holder_code text, holder_kind text,
              via_name text, phone text,
              jugs_out numeric, unsold_back numeric, empties_back numeric, written_off numeric,
              with_them numeric, full_with_them numeric, waiting_count numeric, empty_not_returned numeric,
              owing_as_sold numeric, jugs_sold numeric, last_out date, last_returned date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_collections_can_view(p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH jt AS (
    SELECT ct.id FROM container_types ct WHERE ct.factory_id = p_factory AND ct.name ~* 'jug|dispenser'
  ), tot AS (
    SELECT x.ht, x.hid,
           SUM(x.supplied + x.opening) AS out_q, SUM(x.unsold) AS unsold_q, SUM(x.empties) AS empties_q,
           SUM(x.lost) AS lost_q, SUM(x.sold_out) AS sold_out_q, SUM(x.bought) AS bought_q,
           SUM(x.supplied + x.opening - x.unsold - x.empties - x.lost - x.sold_out) AS held,
           -- Rule A (Accounts): Dispenser Water posted - unsold back - empties back.
           SUM(x.supplied - x.unsold - x.empties) AS rule_a,
           SUM(x.supplied - x.unsold) AS posted_less_unsold,
           MAX(x.d) FILTER (WHERE x.supplied > 0 OR x.opening > 0) AS last_out,
           MAX(x.d) FILTER (WHERE x.empties <> 0) AS last_ret
      FROM public._qc_jug_party_days(p_factory) x
     GROUP BY 1, 2
  ), jw AS (
    -- Jug + Water posted as such and not returned: the first off the van.
    SELECT x.hid, GREATEST(SUM(x.bought), 0) AS q
      FROM public._qc_jug_party_days(p_factory) x WHERE x.ht = 'sales_rep' GROUP BY 1
  ), van AS (
    SELECT rs.sales_rep_id AS hid, SUM(rs.quantity * pj.per_unit) AS q
      FROM rep_stock rs
      CROSS JOIN LATERAL public._product_jug(rs.product_id) pj
     GROUP BY 1
  ), pend AS (
    SELECT CASE WHEN j.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'customer' END AS ht,
           COALESCE(j.sales_rep_id, j.customer_id) AS hid, SUM(j.quantity_claimed) AS q
      FROM jug_returns j
     WHERE j.factory_id = p_factory AND j.status = 'pending' AND j.container_type_id IN (SELECT id FROM jt)
     GROUP BY 1, 2
  ), r AS (
    SELECT t.*, n.name, n.code, n.kind, n.via, n.phone,
           COALESCE(p.q, 0) AS waiting,
           -- On the van as rep_dispenser_breakdown counts it (Rule A).
           CASE WHEN t.ht = 'sales_rep'
                THEN LEAST(GREATEST(COALESCE(v.q, 0) - COALESCE(j.q, 0), 0), GREATEST(t.posted_less_unsold, 0))
                ELSE 0 END AS van_a,
           CASE WHEN t.ht = 'sales_rep'
                THEN LEAST(GREATEST(COALESCE(v.q, 0) - COALESCE(j.q, 0), 0), GREATEST(t.held, 0))
                ELSE 0 END AS full_q
      FROM tot t
      JOIN public._qc_jug_party_names(p_factory) n ON n.ht = t.ht AND n.hid = t.hid
      LEFT JOIN pend p ON p.ht = t.ht AND p.hid = t.hid
      LEFT JOIN van v ON t.ht = 'sales_rep' AND v.hid = t.hid
      LEFT JOIN jw j ON t.ht = 'sales_rep' AND j.hid = t.hid
  )
  SELECT r.ht, r.hid, r.name, r.code, r.kind, r.via, r.phone,
         r.out_q, r.unsold_q, r.empties_q, r.lost_q, r.held, r.full_q, r.waiting,
         GREATEST(r.held - r.full_q - r.waiting, 0),
         CASE WHEN r.ht = 'sales_rep' THEN GREATEST(r.rule_a - r.van_a, 0) ELSE 0 END,
         GREATEST(r.bought_q, 0),
         r.last_out, r.last_ret
    FROM r
   WHERE r.out_q <> 0 OR r.unsold_q <> 0 OR r.empties_q <> 0 OR r.lost_q <> 0 OR r.held <> 0
      OR r.waiting > 0 OR r.bought_q <> 0
   ORDER BY GREATEST(r.held - r.full_q - r.waiting, 0) DESC, r.name;
END;
$fn$;
REVOKE ALL ON FUNCTION public.qc_jug_holders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_jug_holders(uuid) TO authenticated;

-- ---------------------------------------------------------- day by day --
CREATE OR REPLACE FUNCTION public.qc_jug_holder_days(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(day date, holder_type text, holder_id uuid, holder_name text, holder_code text, holder_kind text,
              via_name text, brought_forward numeric, supplied numeric, opening numeric, unsold_back numeric,
              empties_back numeric, written_off numeric, sold_on numeric, with_them numeric, jugs_sold numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_collections_can_view(p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to - p_from > 92 THEN RAISE EXCEPTION 'Choose 3 months or less'; END IF;
  RETURN QUERY
  WITH x AS (
    SELECT x.*, x.supplied + x.opening - x.unsold - x.empties - x.lost - x.sold_out AS delta
      FROM public._qc_jug_party_days(p_factory) x WHERE x.d <= p_to
  ), bf AS (
    SELECT ht, hid, SUM(delta) AS q FROM x WHERE d < p_from GROUP BY 1, 2
  ), days AS (
    SELECT * FROM x WHERE d >= p_from
  ), run AS (
    -- Every day something moved, with the running balance.
    SELECT dd.*, COALESCE(b.q, 0)
             + SUM(dd.delta) OVER (PARTITION BY dd.ht, dd.hid ORDER BY dd.d) AS closing
      FROM days dd LEFT JOIN bf b ON b.ht = dd.ht AND b.hid = dd.hid
  ), quiet AS (
    -- Still holding jugs, nothing moved in the period: one line on the last day.
    SELECT b.ht, b.hid, b.q FROM bf b
     WHERE b.q <> 0 AND NOT EXISTS (SELECT 1 FROM days dd WHERE dd.ht = b.ht AND dd.hid = b.hid)
  ), rows_ AS (
    SELECT r.d, r.ht, r.hid, r.closing - r.delta AS bf_q, r.supplied, r.opening, r.unsold, r.empties, r.lost,
           r.sold_out, r.closing, r.bought
      FROM run r
    UNION ALL
    SELECT p_to, q.ht, q.hid, q.q, 0, 0, 0, 0, 0, 0, q.q, 0 FROM quiet q
  )
  SELECT r.d, r.ht, r.hid, n.name, n.code, n.kind, n.via, r.bf_q, r.supplied, r.opening, r.unsold, r.empties,
         r.lost, r.sold_out, r.closing, r.bought
    FROM rows_ r
    JOIN public._qc_jug_party_names(p_factory) n ON n.ht = r.ht AND n.hid = r.hid
   ORDER BY r.d DESC, n.kind, n.name;
END;
$fn$;
REVOKE ALL ON FUNCTION public.qc_jug_holder_days(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_jug_holder_days(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
