-- Warehouse Activity Log shows returns (user, 2026-11-19: "H Medix return
-- 18/11/2026, 75cl - 50 is not displaying in the activity log").
-- warehouse_activity listed receipts, postings, sales, corrections and gifts
-- but never any return. It now also lists, like All transactions:
--   * marketer / Retail Shop returns (rep_returns)          -> 'returned'
--   * distributor / customer returns (sales_returns)        -> 'customer_return'
--     one row per return, all its products together
--   * empty dispenser jugs handed in (jug_returns)          -> 'jugs_returned'
-- Each return sits on its return day: one keyed in on the 19th for the 18th
-- shows on the 18th (_gift_at keeps the time it was keyed in).
-- Read-only list: no stock or account changes.

CREATE OR REPLACE FUNCTION public.warehouse_activity(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(kind text, reference text, at timestamptz, party text, items text,
              quantity numeric, status text, posted_by text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Pick a from and to date';
  END IF;

  RETURN QUERY
  SELECT a.* FROM (
    SELECT CASE WHEN r.status = 'rejected' THEN 'refused' ELSE 'received' END,
           r.release_number,
           COALESCE(r.accepted_at, r.released_at),
           'Production'::text,
           pr.name || ' × ' || trim(to_char(COALESCE(r.accepted_quantity, r.quantity), 'FM999G999G990D###')),
           COALESCE(r.accepted_quantity, r.quantity),
           r.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = r.accepted_by)
      FROM production_releases r
      JOIN products pr ON pr.id = r.product_id
     WHERE r.factory_id = p_factory AND r.status IN ('accepted', 'rejected')

    UNION ALL
    SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END,
           d.dispatch_number,
           d.created_at,
           sr.full_name,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
             WHERE i.dispatch_id = d.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
           d.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = d.created_by)
      FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id
     WHERE d.factory_id = p_factory AND d.status <> 'reversed'

    UNION ALL
    SELECT CASE WHEN c.registered THEN 'distributor' ELSE 'sale' END,
           s.invoice_number,
           COALESCE(orig.at, s.created_at),
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id
             WHERE i.sale_id = s.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i WHERE i.sale_id = s.id),
           CASE WHEN s.status = 'posted' AND orig.at IS NOT NULL THEN 'corrected' ELSE s.status::text END,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = s.created_by)
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN LATERAL public._correction_origin_at(s.factory_id, s.remarks) orig(at) ON true
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL

    UNION ALL
    -- Stock corrections and counts on finished goods: one row per reference
    -- and person (a count touching several products is one row).
    SELECT 'adjusted',
           COALESCE(m.reference, 'Adjustment'),
           MIN(m.created_at),
           CASE WHEN bool_and(m.movement_type = 'opening_balance') THEN 'Balance brought forward'
                ELSE 'Stock correction' END,
           string_agg(p.name || ' ' || CASE WHEN m.quantity > 0 THEN '+' ELSE '' END
                      || trim(to_char(m.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name),
           SUM(m.quantity),
           'posted'::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = m.user_id)
      FROM inventory_movements m
      JOIN products p ON p.id = m.product_id AND p.product_type = 'finished'
     WHERE m.factory_id = p_factory
       AND m.movement_type IN ('adjusted', 'damaged', 'opening_balance')
     GROUP BY COALESCE(m.reference, 'Adjustment'), m.user_id,
              (m.created_at AT TIME ZONE 'Africa/Lagos')::date

    UNION ALL
    -- Chairman's gifts (2026-11-14).
    SELECT 'gift',
           g.gift_number,
           public._gift_at(g.gift_date, g.created_at),
           'Chairman''s gift' || COALESCE(' — ' || NULLIF(btrim(g.recipient), ''), ''),
           (SELECT string_agg(p.name || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM chairmans_gift_items i JOIN products p ON p.id = i.product_id WHERE i.gift_id = g.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM chairmans_gift_items i WHERE i.gift_id = g.id),
           g.status,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = g.created_by)
      FROM chairmans_gifts g
     WHERE g.factory_id = p_factory

    UNION ALL
    -- Marketer / Retail Shop returns (2026-11-19).
    SELECT 'returned',
           x.return_number,
           public._gift_at(x.return_date, COALESCE(x.received_at, x.created_at)),
           sr.full_name,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity_returned, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM rep_return_items i JOIN products p ON p.id = i.product_id WHERE i.rep_return_id = x.id),
           (SELECT COALESCE(SUM(i.quantity_returned), 0) FROM rep_return_items i WHERE i.rep_return_id = x.id),
           x.status::text,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = x.received_by)
      FROM rep_returns x
      JOIN sales_reps sr ON sr.id = x.sales_rep_id
     WHERE x.factory_id = p_factory AND x.status::text <> 'cancelled'

    UNION ALL
    -- Distributor / customer returns (2026-11-19): one row per return
    -- (SR-...-1, SR-...-2 are the lines of one SR-...).
    SELECT 'customer_return',
           regexp_replace(r.return_number, '^(SR-[0-9]{8}-[0-9]+)-[0-9]+$', '\1'),
           MIN(public._gift_at(r.return_date, COALESCE(r.inspected_at, r.received_at, r.created_at))),
           COALESCE(c.name, MAX(s.customer_name), 'Customer'),
           string_agg(p.name || ' × ' || trim(to_char(r.quantity_returned, 'FM999G999G990D###')), ', ' ORDER BY p.name),
           SUM(r.quantity_returned),
           MIN(r.status::text),
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = MIN(r.received_by::text)::uuid)
      FROM sales_returns r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN sales s ON s.id = r.sale_id
     WHERE r.factory_id = p_factory AND r.sales_rep_id IS NULL AND r.status::text <> 'cancelled'
     GROUP BY 2, r.customer_id, c.name

    UNION ALL
    -- Empty dispenser jugs handed in (2026-11-19).
    SELECT 'jugs_returned',
           j.reference,
           j.recorded_at,
           COALESCE(sr.full_name, c.name),
           'Empty ' || ct.name || ' × ' || trim(to_char(j.quantity_claimed, 'FM999G999G990'))
             || CASE WHEN j.status = 'verified' THEN ' (QC counted ' || trim(to_char(j.quantity_received, 'FM999G999G990')) || ')'
                     ELSE '' END,
           j.quantity_claimed,
           j.status,
           (SELECT COALESCE(NULLIF(pf.full_name, ''), pf.email) FROM profiles pf WHERE pf.id = j.recorded_by)
      FROM jug_returns j
      JOIN container_types ct ON ct.id = j.container_type_id
      LEFT JOIN sales_reps sr ON sr.id = j.sales_rep_id
      LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.factory_id = p_factory AND j.status <> 'cancelled'
  ) a(k, ref, ts, pty, its, qty, st, who)
  WHERE (a.ts AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to
  ORDER BY a.ts DESC
  LIMIT 2000;
END;
$fn$;

NOTIFY pgrst, 'reload schema';

-- Read-only check: every return entered for H Medix since 17 Nov, with its
-- day and who keyed it in. No row with 75cl × 50 = the return was never saved.
SELECT r.return_date, r.return_number, COALESCE(c.name, s.customer_name) AS customer,
       p.name AS product, r.quantity_returned, r.status,
       (r.received_at AT TIME ZONE 'Africa/Lagos') AS keyed_in_at
  FROM sales_returns r
  JOIN products p ON p.id = r.product_id
  LEFT JOIN customers c ON c.id = r.customer_id
  LEFT JOIN sales s ON s.id = r.sale_id
 WHERE (c.name ILIKE '%medix%' OR s.customer_name ILIKE '%medix%')
   AND (r.return_date >= DATE '2026-11-17' OR r.received_at >= TIMESTAMPTZ '2026-11-17')
 ORDER BY r.received_at DESC;
