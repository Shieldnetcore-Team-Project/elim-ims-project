-- ============================================================================
-- Migration from the old system: its 30 Oct 2026 Products Report, as is
-- ----------------------------------------------------------------------------
-- User decision (2026-10-30): the Warehouse's Products Report for 30 Oct
-- shows the old system's "All Products Reports" exactly -- Opening, Qty In,
-- Total, Qty Out, Returned, Gift/Sample, Balance -- as the total migration
-- into this system. From 31 Oct the report is this system's own, opening at
-- those balances (the balance brought forward, 20261030120000).
--
-- warehouse_report_snapshots holds such fixed rows, one per product and
-- day; warehouse_products_report (20261030140000) returns them for that day
-- instead of working the day out. Products not in the old report (1Ltr,
-- 1.5Ltr, Dispenser New Jug) are worked out as usual. Safe to run again.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.warehouse_report_snapshots (
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  report_date date NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  opening numeric NOT NULL,
  qty_in numeric NOT NULL,
  qty_out numeric NOT NULL,
  returned numeric NOT NULL DEFAULT 0,
  gift numeric NOT NULL DEFAULT 0,
  balance numeric NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, report_date)
);
-- Read only through warehouse_products_report (SECURITY DEFINER).
ALTER TABLE public.warehouse_report_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warehouse_report_snapshots FROM anon, authenticated;
GRANT ALL ON public.warehouse_report_snapshots TO service_role;

-- The old system's rows, matched to this system's products by name.
DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_row record;
  v_n int;
  v_pid uuid;
BEGIN
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;
  FOR v_row IN SELECT * FROM (VALUES
      ('75cl Bottle Water', '^75 ?cl bottle',                          13661::numeric, 819::numeric, 1116::numeric, 13364::numeric),
      ('50cl Bottle Water', '^50 ?cl bottle',                            302,  615,  500,   417),
      ('Sachet Water',      '^(sachet|satchet) water',                   126, 2566, 2147,   545),
      ('Dispenser Water',   '^dispenser( water$|/jug water \(old jug\))', 152,  300,  359,    93),
      ('35cl Bottle Water', '^35 ?cl bottle',                            960,    0,  200,   760)
    ) AS t(label, pattern, opening, qty_in, qty_out, balance)
  LOOP
    v_n := (SELECT count(*) FROM products
             WHERE factory_id = v_factory AND product_type = 'finished' AND active
               AND btrim(name) ~* v_row.pattern);
    IF v_n <> 1 THEN
      RAISE NOTICE '%: % matching products -- not stored', v_row.label, v_n;
      CONTINUE;
    END IF;
    v_pid := (SELECT id FROM products
               WHERE factory_id = v_factory AND product_type = 'finished' AND active
                 AND btrim(name) ~* v_row.pattern);
    INSERT INTO warehouse_report_snapshots(factory_id, report_date, product_id, opening, qty_in, qty_out,
                                           returned, gift, balance, source)
    VALUES (v_factory, '2026-10-30', v_pid, v_row.opening, v_row.qty_in, v_row.qty_out, 0, 0, v_row.balance,
            'Old system: All Products Reports, 30 Oct 2026')
    -- Stored once: a later correction (e.g. 20261030170000) is never undone
    -- by running this again.
    ON CONFLICT (product_id, report_date) DO NOTHING;
    RAISE NOTICE '%: old-system row stored (balance %)', v_row.label, v_row.balance;
  END LOOP;
END $$;

-- The report: a stored row for the day is shown as is; otherwise worked out
-- from the ledger as in 20261030140000.
CREATE OR REPLACE FUNCTION public.warehouse_products_report(p_factory uuid, p_date date)
RETURNS TABLE(product_id uuid, product text, unit text, opening numeric, qty_in numeric,
              total numeric, qty_out numeric, returned numeric, gift numeric,
              adjusted numeric, balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_date IS NULL THEN RAISE EXCEPTION 'Pick a day'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT m.product_id AS pid,
           COALESCE(m.quantity_after - m.quantity_before,
                    CASE WHEN m.movement_type::text IN ('sold', 'issued', 'transferred', 'damaged', 'used_for_production')
                         THEN -abs(m.quantity) ELSE m.quantity END) AS delta,
           m.movement_type::text AS mtype,
           COALESCE(m.reason, '') AS reason,
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM inventory_movements m
     WHERE m.factory_id = p_factory
       AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date >= p_date
  ), day AS (
    SELECT pid,
      COALESCE(SUM(delta) FILTER (WHERE d > p_date), 0) AS after_day,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date), 0) AS on_day,
      COALESCE(SUM(-delta) FILTER (WHERE d = p_date AND reason ILIKE 'PR - complimentary%'), 0) AS gift,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND mtype = 'returned'
                                    AND reason NOT ILIKE 'PR - complimentary%'), 0) AS returned,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND mtype IN ('adjusted', 'opening_balance')
                                    AND reason NOT ILIKE 'PR - complimentary%'), 0) AS adjusted,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND delta > 0
                                    AND mtype NOT IN ('returned', 'adjusted', 'opening_balance')
                                    AND reason NOT ILIKE 'PR - complimentary%'), 0) AS qty_in,
      COALESCE(SUM(-delta) FILTER (WHERE d = p_date AND delta < 0
                                     AND mtype NOT IN ('returned', 'adjusted', 'opening_balance')
                                     AND reason NOT ILIKE 'PR - complimentary%'), 0) AS qty_out
      FROM mv GROUP BY pid
  ), calc AS (
    SELECT p.id, p.name, p.unit,
           p.current_stock - COALESCE(dy.after_day, 0) - COALESCE(dy.on_day, 0) AS opening,
           COALESCE(dy.qty_in, 0) AS qty_in,
           COALESCE(dy.qty_out, 0) AS qty_out,
           COALESCE(dy.returned, 0) AS returned,
           COALESCE(dy.gift, 0) AS gift,
           COALESCE(dy.adjusted, 0) AS adjusted,
           p.current_stock - COALESCE(dy.after_day, 0) AS balance
      FROM products p
      LEFT JOIN day dy ON dy.pid = p.id
     WHERE p.factory_id = p_factory AND p.product_type = 'finished' AND p.active
  )
  SELECT c.id, c.name, c.unit,
         COALESCE(sn.opening, c.opening),
         COALESCE(sn.qty_in, c.qty_in),
         COALESCE(sn.opening + sn.qty_in, c.opening + c.qty_in),
         COALESCE(sn.qty_out, c.qty_out),
         COALESCE(sn.returned, c.returned),
         COALESCE(sn.gift, c.gift),
         CASE WHEN sn.product_id IS NULL THEN c.adjusted ELSE 0 END,
         COALESCE(sn.balance, c.balance)
    FROM calc c
    LEFT JOIN warehouse_report_snapshots sn ON sn.product_id = c.id AND sn.report_date = p_date
   ORDER BY c.name;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_products_report(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_products_report(uuid, date) TO authenticated;
