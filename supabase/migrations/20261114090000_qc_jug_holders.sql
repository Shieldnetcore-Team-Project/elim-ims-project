-- ============================================================================
-- Quality Control -> Dispenser Jug -> Accountability: who still holds jugs
-- ----------------------------------------------------------------------------
-- User (2026-11-14): "track who is with empty jug; marketers, distributors and
-- office delivery in quality control ... so that qc can check to know who is
-- still with empty jug that have not return it and also who is owing empty
-- sold and the qty".
--
-- qc_jug_holders(factory) -- as of now, one row per marketer, Distributor /
-- Office Delivery customer and marketer's customer that has had dispenser
-- jugs. Quantities only (no money: QC does not see account balances).
--
-- Marketers (the same figures as rep_dispenser_breakdown / rep_account_summary,
-- Rule A):
--   jugs_out        Dispenser Water posted to them (no type)
--   unsold_back     of it, returned unsold to the Warehouse
--   full_with_them  dispensers still on their van (not sold yet)
--   empties_back    empty jugs returned (QC's count / Record movement)
--   waiting_count   empties handed to the Warehouse, QC has not counted yet
--   empty_not_returned  sold - empties back - waiting: empties still out.
--                   Accounts charges these (and the waiting ones, until QC
--                   counts them) as Empty Jug sold.
--   owing_as_sold   sold - empties back: what Accounts charges as Empty Jug now
--   jugs_sold       Jug + Water posted as such, less returned unsold (the jug
--                   is theirs, nothing to bring back)
-- Distributors / Office Delivery / marketers' customers (container ledger):
--   jugs_out        every jug that went to them (supplies, openings), net of
--                   reversals; Jug + Water sold straight out never counts here
--   unsold_back     unsold dispensers they returned
--   empties_back    empty jugs returned
--   waiting_count   as above
--   empty_not_returned  jugs still with them less the waiting ones (full or
--                   empty -- the ledger can't tell which)
--   owing_as_sold   0 (no jug charge on their accounts)
--   jugs_sold       Empty Jug / Jug + Water sold to them (theirs to keep)
-- Read-only; changes nothing. Paste into the Supabase SQL Editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.qc_jug_holders(p_factory uuid)
RETURNS TABLE(holder_type text, holder_id uuid, holder_name text, holder_code text, holder_kind text,
              via_name text, phone text,
              jugs_out numeric, unsold_back numeric, full_with_them numeric, empties_back numeric,
              waiting_count numeric, empty_not_returned numeric, owing_as_sold numeric, jugs_sold numeric,
              last_out date, last_returned date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_collections_can_view(p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH jt AS (
    SELECT ct.id FROM container_types ct WHERE ct.factory_id = p_factory AND ct.name ~* 'jug|dispenser'
  ),
  -- ------------------------------------------------------------ marketers --
  reps AS (
    SELECT sr.id, sr.full_name, sr.code, sr.phone FROM sales_reps sr
     WHERE sr.factory_id = p_factory AND COALESCE(sr.kind, 'rep') <> 'outlet'
  ), posted AS (
    SELECT sd.sales_rep_id AS rid,
           SUM(sdi.quantity * pj.per_unit) FILTER (WHERE sdi.jar_mode IS NULL) AS water,
           SUM(sdi.quantity * pj.per_unit) FILTER (WHERE sdi.jar_mode = 'permanent') AS jw,
           MAX(sd.dispatch_date) AS last_day
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.factory_id = p_factory AND sd.status = 'posted' AND sd.sales_rep_id IN (SELECT id FROM reps)
     GROUP BY 1
  ), back AS (
    SELECT rr.sales_rep_id AS rid,
           SUM(COALESCE(rri.accepted_quantity, 0) * pj.per_unit) FILTER (WHERE rri.jar_mode IS NULL) AS water,
           SUM(COALESCE(rri.accepted_quantity, 0) * pj.per_unit) FILTER (WHERE rri.jar_mode = 'permanent') AS jw
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.status = 'completed' AND rr.sales_rep_id IN (SELECT id FROM reps)
     GROUP BY 1
  ), rep_empties AS (
    SELECT m.from_id AS rid, SUM(m.quantity) AS q, MAX(public._jug_day(m.created_at)) AS last_day
      FROM container_movements m
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.from_type = 'sales_rep' AND m.source = 'return'
     GROUP BY 1
  ), van AS (
    SELECT rs.sales_rep_id AS rid, SUM(rs.quantity * pj.per_unit) AS q
      FROM rep_stock rs
      CROSS JOIN LATERAL public._product_jug(rs.product_id) pj
     WHERE rs.sales_rep_id IN (SELECT id FROM reps)
     GROUP BY 1
  ), pend AS (
    SELECT CASE WHEN j.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'customer' END AS ht,
           COALESCE(j.sales_rep_id, j.customer_id) AS hid, SUM(j.quantity_claimed) AS q
      FROM jug_returns j
     WHERE j.factory_id = p_factory AND j.status = 'pending' AND j.container_type_id IN (SELECT id FROM jt)
     GROUP BY 1, 2
  ), rep_calc AS (
    SELECT r.id, r.full_name, r.code, r.phone,
           COALESCE(p.water, 0) AS posted,
           COALESCE(b.water, 0) AS unsold,
           GREATEST(COALESCE(p.jw, 0) - COALESCE(b.jw, 0), 0) AS jw_net,
           COALESCE(e.q, 0) AS empties,
           COALESCE(pd.q, 0) AS pending,
           -- On the van now: the Jug + Water posted as such comes off first.
           LEAST(GREATEST(COALESCE(v.q, 0) - GREATEST(COALESCE(p.jw, 0) - COALESCE(b.jw, 0), 0), 0),
                 GREATEST(COALESCE(p.water, 0) - COALESCE(b.water, 0), 0)) AS on_van,
           p.last_day AS last_out, e.last_day AS last_ret
      FROM reps r
      LEFT JOIN posted p ON p.rid = r.id
      LEFT JOIN back b ON b.rid = r.id
      LEFT JOIN rep_empties e ON e.rid = r.id
      LEFT JOIN van v ON v.rid = r.id
      LEFT JOIN pend pd ON pd.ht = 'sales_rep' AND pd.hid = r.id
  ), rep_rows AS (
    SELECT 'sales_rep'::text AS ht, c.id AS hid, c.full_name::text AS name, c.code::text AS code,
           'rep'::text AS kind, NULL::text AS via, c.phone::text AS phone,
           c.posted AS out_q, c.unsold AS unsold_q, c.on_van AS full_q, c.empties AS empties_q,
           c.pending AS waiting_q,
           GREATEST(c.posted - c.unsold - c.on_van - c.empties - c.pending, 0) AS not_ret,
           GREATEST(c.posted - c.unsold - c.on_van - c.empties, 0) AS owing,
           c.jw_net AS sold_q,
           c.last_out, c.last_ret
      FROM rep_calc c
  ),
  -- ---------------------------------- Distributors / customers (ledger) --
  cmv AS (
    SELECT m.to_id AS cid, m.quantity AS q, m.source AS src, m.created_at AS at, true AS inbound
      FROM container_movements m
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.to_type = 'customer' AND m.to_id IS NOT NULL
    UNION ALL
    SELECT m.from_id, -m.quantity, m.source, m.created_at, false
      FROM container_movements m
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.from_type = 'customer' AND m.from_id IS NOT NULL
  ), cbal AS (
    SELECT cid,
           SUM(q) AS held,
           COALESCE(SUM(q) FILTER (WHERE inbound AND src NOT IN ('jar_sold', 'jar_sold_reversal')), 0)
             + COALESCE(SUM(q) FILTER (WHERE NOT inbound AND src IN ('sale_reversal', 'dispatch_reversal')), 0) AS out_q,
           SUM(-q) FILTER (WHERE src = 'return') AS empties_q,
           SUM(-q) FILTER (WHERE src = 'customer_return') AS unsold_q,
           -SUM(q) FILTER (WHERE src IN ('jar_sold', 'jar_sold_reversal')) AS sold_from_them,
           MAX(public._jug_day(at)) FILTER (WHERE inbound AND src NOT IN ('jar_sold', 'jar_sold_reversal', 'count')) AS last_out,
           MAX(public._jug_day(at)) FILTER (WHERE src = 'return') AS last_ret
      FROM cmv GROUP BY cid
  ), sold_direct AS (
    -- Jug + Water sold straight to them: the jug went Warehouse / marketer ->
    -- outside on their invoice and never sat on their balance.
    SELECT s.customer_id AS cid,
           SUM(CASE WHEN m.to_type = 'external' THEN m.quantity
                    WHEN m.from_type = 'external' THEN -m.quantity ELSE 0 END) AS q
      FROM container_movements m
      JOIN sales s ON s.id = m.sale_id
     WHERE m.factory_id = p_factory AND m.container_type_id IN (SELECT id FROM jt)
       AND m.source IN ('jar_sold', 'jar_sold_reversal')
       AND m.from_type IS DISTINCT FROM 'customer' AND m.to_type IS DISTINCT FROM 'customer'
       AND s.customer_id IS NOT NULL
     GROUP BY 1
  ), ckeys AS (
    SELECT cid FROM cbal UNION SELECT cid FROM sold_direct
    UNION SELECT hid FROM pend WHERE ht = 'customer' AND hid IS NOT NULL
  ), cust_rows AS (
    SELECT 'customer'::text AS ht, k.cid AS hid, COALESCE(cu.name, '(unknown)')::text AS name, NULL::text AS code,
           CASE WHEN cu.sales_rep_id IS NULL THEN 'customer' ELSE 'rep_customer' END::text AS kind,
           vr.full_name::text AS via, cu.phone::text AS phone,
           GREATEST(COALESCE(b.out_q, 0), 0) AS out_q,
           GREATEST(COALESCE(b.unsold_q, 0), 0) AS unsold_q,
           0::numeric AS full_q,
           GREATEST(COALESCE(b.empties_q, 0), 0) AS empties_q,
           COALESCE(pd.q, 0) AS waiting_q,
           GREATEST(COALESCE(b.held, 0) - COALESCE(pd.q, 0), 0) AS not_ret,
           0::numeric AS owing,
           GREATEST(COALESCE(b.sold_from_them, 0) + COALESCE(sd.q, 0), 0) AS sold_q,
           b.last_out, b.last_ret
      FROM ckeys k
      LEFT JOIN cbal b ON b.cid = k.cid
      LEFT JOIN sold_direct sd ON sd.cid = k.cid
      LEFT JOIN pend pd ON pd.ht = 'customer' AND pd.hid = k.cid
      LEFT JOIN customers cu ON cu.id = k.cid
      LEFT JOIN sales_reps vr ON vr.id = cu.sales_rep_id
     WHERE cu.id IS NULL OR cu.factory_id = p_factory
  ), allr AS (
    SELECT * FROM rep_rows UNION ALL SELECT * FROM cust_rows
  )
  SELECT a.ht, a.hid, a.name, a.code, a.kind, a.via, a.phone,
         a.out_q, a.unsold_q, a.full_q, a.empties_q, a.waiting_q, a.not_ret, a.owing, a.sold_q,
         a.last_out, a.last_ret
    FROM allr a
   WHERE a.out_q > 0 OR a.unsold_q > 0 OR a.full_q > 0 OR a.empties_q > 0 OR a.waiting_q > 0
      OR a.not_ret > 0 OR a.owing > 0 OR a.sold_q > 0
   ORDER BY a.not_ret DESC, a.name;
END;
$fn$;
REVOKE ALL ON FUNCTION public.qc_jug_holders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_jug_holders(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
