-- ============================================================================
-- A corrected posting stays on its own day and reads "corrected"
-- ----------------------------------------------------------------------------
-- User (2026-11-13): H MEDIX's 12 Nov posting was corrected this morning
-- (INV20261112-27151 -> INV20261113-..., Dispenser Water 121). The Warehouse
-- lists showed the corrected one as a new "posted" posting at the time of the
-- correction: "it's a correction I just did, it should not be as posted".
--
-- A correction reverses the old posting and reposts it (remarks
-- "Correction of <old invoice>: <reason>", 20261029170000). In the
-- Warehouse's All transactions / party window (warehouse_transactions) and
-- Activity Log (warehouse_activity) such a posting now:
--   * sits at the time the ORIGINAL posting was made (followed back through
--     corrections of corrections), not the time of the correction, and
--   * reads "corrected" instead of "posted" (Correct / Cancel still work).
-- Display only: no stock, money or posting changes. Everything else in both
-- functions is as 20261109140000.
-- ============================================================================

-- When the first posting of a chain of corrections was made; NULL when the
-- remarks don't name a corrected posting.
CREATE OR REPLACE FUNCTION public._correction_origin_at(p_factory uuid, p_remarks text)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_inv text := substring(p_remarks from '^Correction of ([^: ]+)');
  v_at timestamptz;
  v_remarks text;
  v_n int := 0;
BEGIN
  WHILE v_inv IS NOT NULL AND v_n < 20 LOOP
    SELECT created_at, remarks INTO v_at, v_remarks
      FROM sales WHERE factory_id = p_factory AND invoice_number = v_inv
     ORDER BY created_at LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_inv := substring(v_remarks from '^Correction of ([^: ]+)');
    v_n := v_n + 1;
  END LOOP;
  RETURN v_at;
END;
$fn$;
REVOKE ALL ON FUNCTION public._correction_origin_at(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.warehouse_transactions(p_factory uuid, p_limit int DEFAULT 200, p_party uuid DEFAULT NULL)
RETURNS TABLE(kind text, reference text, at timestamptz, party_type text, party_id uuid, party text,
              items text, quantity numeric, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  RETURN QUERY
  SELECT a.* FROM (
    SELECT CASE WHEN r.status = 'rejected' THEN 'refused' ELSE 'received' END AS k,
           r.release_number AS ref, COALESCE(r.accepted_at, r.released_at) AS t,
           'production'::text AS ptype, NULL::uuid AS pid, 'Production'::text AS who,
           pr.name || ' × ' || trim(to_char(COALESCE(r.accepted_quantity, r.quantity), 'FM999G999G990D###')) AS info,
           COALESCE(r.accepted_quantity, r.quantity) AS qty, r.status::text AS st
      FROM production_releases r
      JOIN products pr ON pr.id = r.product_id
     WHERE r.factory_id = p_factory AND r.status IN ('accepted', 'rejected') AND p_party IS NULL

    UNION ALL
    SELECT CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, d.dispatch_number, d.created_at,
           CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, sr.id, sr.full_name,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = d.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id),
           d.status
      FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id
     WHERE d.factory_id = p_factory AND d.status <> 'reversed' AND (p_party IS NULL OR sr.id = p_party)

    UNION ALL
    SELECT CASE WHEN c.registered THEN 'distributor' ELSE 'sale' END, s.invoice_number, COALESCE(orig.at, s.created_at),
           CASE WHEN c.registered THEN 'distributor' ELSE 'walk_in' END, c.id,
           COALESCE(c.name, s.customer_name, 'Walk-in'),
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = s.id),
           (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i WHERE i.sale_id = s.id),
           CASE WHEN s.status = 'posted' AND orig.at IS NOT NULL THEN 'corrected' ELSE s.status::text END
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN LATERAL public._correction_origin_at(s.factory_id, s.remarks) orig(at) ON true
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NULL AND s.deleted_at IS NULL
       AND (p_party IS NULL OR c.id = p_party)

    UNION ALL
    SELECT 'returned', x.return_number, COALESCE(x.received_at, x.created_at),
           CASE WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END, sr.id, sr.full_name,
           (SELECT string_agg(public._sale_line_name(p.name, i.jar_mode) || ' × ' || trim(to_char(i.quantity_returned, 'FM999G999G990D###')), ', ' ORDER BY p.name)
              FROM rep_return_items i JOIN products p ON p.id = i.product_id WHERE i.rep_return_id = x.id),
           (SELECT COALESCE(SUM(i.quantity_returned), 0) FROM rep_return_items i WHERE i.rep_return_id = x.id),
           x.status
      FROM rep_returns x
      JOIN sales_reps sr ON sr.id = x.sales_rep_id
     WHERE x.factory_id = p_factory AND x.status <> 'cancelled' AND (p_party IS NULL OR sr.id = p_party)

    UNION ALL
    SELECT 'customer_return', r.return_number, COALESCE(r.inspected_at, r.received_at),
           CASE WHEN c.registered THEN 'distributor' ELSE 'walk_in' END, c.id,
           COALESCE(c.name, 'Customer'),
           p.name || ' × ' || trim(to_char(r.quantity_returned, 'FM999G999G990D###')),
           r.quantity_returned, r.status
      FROM sales_returns r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.factory_id = p_factory AND r.sales_rep_id IS NULL AND r.status <> 'cancelled'
       AND (p_party IS NULL OR c.id = p_party)

    UNION ALL
    SELECT 'jugs_returned', j.reference, j.recorded_at,
           CASE WHEN j.customer_id IS NOT NULL THEN 'distributor'
                WHEN sr.kind = 'outlet' THEN 'retail' ELSE 'marketer' END,
           COALESCE(j.sales_rep_id, j.customer_id), COALESCE(sr.full_name, c.name),
           'Empty ' || ct.name || ' × ' || trim(to_char(j.quantity_claimed, 'FM999G999G990'))
             || CASE WHEN j.status = 'verified' THEN ' (QC counted ' || trim(to_char(j.quantity_received, 'FM999G999G990')) || ')'
                     ELSE '' END,
           j.quantity_claimed, j.status
      FROM jug_returns j
      JOIN container_types ct ON ct.id = j.container_type_id
      LEFT JOIN sales_reps sr ON sr.id = j.sales_rep_id
      LEFT JOIN customers c ON c.id = j.customer_id
     WHERE j.factory_id = p_factory AND j.status <> 'cancelled'
       AND (p_party IS NULL OR j.sales_rep_id = p_party OR j.customer_id = p_party)
  ) a
  ORDER BY a.t DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 2000);
END;
$fn$;

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
  ) a(k, ref, ts, pty, its, qty, st, who)
  WHERE (a.ts AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to
  ORDER BY a.ts DESC
  LIMIT 2000;
END;
$fn$;
