-- ============================================================================
-- Accounts' customer / marketer window: Jug + Water shown as Jug + Water
-- ----------------------------------------------------------------------------
-- User (2026-11-12), H MEDIX's window (Accountant > All activity > name):
-- a Jug + Water posting showed as "Dispenser Water x 19 Piece @ N4,200" next
-- to real Dispenser Water lines @ N1,200, and its quantity was added into the
-- Dispenser Water total at the top. Each type must show on its own.
--
-- The posting is stored right: create_sale saves the line with
-- jar_mode 'permanent' and the Jug + Water price (water + jug, N4,200), and it
-- comes out of the one filled-dispenser stock -- the same stock a Dispenser
-- Water line takes from, as decided on 9 Nov. Printed invoices already name it
-- Jug + Water. The window reads party_postings_and_returns (and All activity
-- reads day_postings); their naming version (20261109150000,
-- RUN_THIS_SECOND_IN_SQL_EDITOR.sql) evidently never reached the live
-- database, so they listed the bare product name.
--
-- This installs that naming again, on its own: the two functions are exactly
-- as in 20261109150000. Nothing is posted, moved or repriced. The last result
-- is a read-only list of H MEDIX's dispenser lines since 9 Nov with the type
-- stored on each, to check against the window.
-- Safe to run again. Paste into the Supabase SQL Editor (run without RLS).
-- ============================================================================

-- Columns 20261109140000 adds; already there if it ran.
ALTER TABLE public.stock_dispatch_items
  ADD COLUMN IF NOT EXISTS jar_mode text CHECK (jar_mode IS NULL OR jar_mode = 'permanent');
ALTER TABLE public.rep_return_items
  ADD COLUMN IF NOT EXISTS jar_mode text CHECK (jar_mode IS NULL OR jar_mode = 'permanent');

-- As 20261109120000.
CREATE OR REPLACE FUNCTION public._sale_line_name(p_name text, p_jar_mode text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN p_jar_mode = 'permanent' THEN 'Jug + Water' ELSE p_name END;
$fn$;

CREATE OR REPLACE FUNCTION public.day_postings(p_factory uuid, p_from date, p_to date DEFAULT NULL)
RETURNS TABLE(party_type text, party text, party_code text, id uuid, reference text, day date,
              at timestamptz, status text, product_name text, unit text, quantity numeric,
              unit_price numeric, line_total numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE
  v_to date := COALESCE(p_to, p_from);
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL THEN RAISE EXCEPTION 'Pick a day'; END IF;
  IF v_to < p_from THEN RAISE EXCEPTION 'The end date is before the start date'; END IF;
  IF v_to - p_from > 92 THEN RAISE EXCEPTION 'Pick at most three months'; END IF;

  RETURN QUERY
  SELECT CASE WHEN r.kind::text = 'outlet' THEN 'retail' ELSE 'marketer' END,
         COALESCE(r.full_name, '-')::text, r.code::text,
         d.id, d.dispatch_number, d.dispatch_date, d.created_at, d.status::text,
         public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
         COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price)
    FROM stock_dispatches d
    JOIN stock_dispatch_items i ON i.dispatch_id = d.id
    LEFT JOIN sales_reps r ON r.id = d.sales_rep_id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE d.factory_id = p_factory AND d.status::text <> 'reversed'
     AND d.dispatch_date BETWEEN p_from AND v_to
  UNION ALL
  SELECT 'distributor', COALESCE(NULLIF(btrim(s.customer_name), ''), c.name, '-')::text, NULL::text,
         s.id, s.invoice_number, s.sale_date, s.created_at, s.status::text,
         public._sale_line_name(COALESCE(p.name, '-'), si.jar_mode)::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN products p ON p.id = si.product_id
   WHERE s.factory_id = p_factory AND s.deleted_at IS NULL
     AND s.status::text NOT IN ('rejected', 'cancelled')
     AND public.is_warehouse_posting(s)
     AND s.sale_date BETWEEN p_from AND v_to
   ORDER BY 1, 2, 7, 9;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.party_postings_and_returns(
  p_factory uuid, p_rep uuid DEFAULT NULL, p_customer_name text DEFAULT NULL
) RETURNS TABLE(kind text, id uuid, reference text, day date, at timestamptz, status text,
                product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric,
                note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE
  v_name text := lower(btrim(COALESCE(p_customer_name, '')));
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF (p_rep IS NULL) = (v_name = '') THEN RAISE EXCEPTION 'Choose a marketer or a customer'; END IF;

  IF p_rep IS NOT NULL THEN
    RETURN QUERY
    SELECT 'posting'::text, d.id, d.dispatch_number, d.dispatch_date, d.created_at, d.status::text,
           public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price,
           COALESCE(NULLIF(i.line_value, 0), i.quantity * i.unit_price), NULL::text
      FROM stock_dispatches d
      JOIN stock_dispatch_items i ON i.dispatch_id = d.id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE d.factory_id = p_factory AND d.sales_rep_id = p_rep
    UNION ALL
    SELECT 'return', r.id, r.return_number, r.return_date, COALESCE(r.received_at, r.created_at), r.status::text,
           public._sale_line_name(COALESCE(p.name, '-'), i.jar_mode)::text, COALESCE(p.unit, '')::text, i.quantity_returned, i.unit_price,
           i.quantity_returned * i.unit_price,
           CASE WHEN cd.dispatch_number IS NOT NULL AND cd.status <> 'reversed'
                THEN 'Added to ' || cd.dispatch_number END
      FROM rep_returns r
      JOIN rep_return_items i ON i.rep_return_id = r.id
      LEFT JOIN products p ON p.id = i.product_id
      LEFT JOIN stock_dispatches cd ON cd.id = r.carried_dispatch_id
     WHERE r.factory_id = p_factory AND r.sales_rep_id = p_rep AND r.status::text <> 'cancelled'
     ORDER BY 5 DESC, 7;
  ELSE
    RETURN QUERY
    SELECT 'posting'::text, s.id, s.invoice_number, s.sale_date, s.created_at, s.status::text,
           public._sale_line_name(COALESCE(p.name, '-'), si.jar_mode)::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total,
           CASE WHEN COALESCE(s.is_pr, false) THEN 'PR' END
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE s.factory_id = p_factory AND s.deleted_at IS NULL
       AND lower(btrim(s.customer_name)) = v_name
       AND s.status::text NOT IN ('rejected', 'cancelled')
    UNION ALL
    SELECT 'return', sr.id, sr.return_number, sr.return_date, COALESCE(sr.received_at, sr.created_at), sr.status::text,
           COALESCE(p.name, '-')::text, COALESCE(p.unit, sr.unit, '')::text, sr.quantity_returned,
           CASE WHEN sr.quantity_returned > 0 THEN sr.value / sr.quantity_returned END, sr.value,
           (SELECT 'On ' || s2.invoice_number FROM sales s2 WHERE s2.id = sr.sale_id)
      FROM sales_returns sr
      LEFT JOIN products p ON p.id = sr.product_id
      LEFT JOIN customers c ON c.id = sr.customer_id
      LEFT JOIN sales s ON s.id = sr.sale_id
     WHERE sr.factory_id = p_factory AND sr.status::text <> 'cancelled'
       AND (lower(btrim(c.name)) = v_name OR lower(btrim(s.customer_name)) = v_name)
     ORDER BY 5 DESC, 7;
  END IF;
END;
$fn$;

NOTIFY pgrst, 'reload schema';

-- Read-only check: what is stored on H MEDIX's dispenser lines since 9 Nov.
-- "Shows as" is what the window lists from now on.
SELECT s.sale_date, s.invoice_number, p.name AS product, si.jar_mode AS type_stored,
       public._sale_line_name(p.name, si.jar_mode) AS shows_as,
       si.quantity, si.unit_price
  FROM sales s
  JOIN sale_items si ON si.sale_id = s.id
  JOIN products p ON p.id = si.product_id
 WHERE lower(s.customer_name) LIKE '%medix%'
   AND s.sale_date >= '2026-11-09' AND s.deleted_at IS NULL
   AND p.name ~* '(dispenser|jug)'
 ORDER BY s.created_at DESC;
