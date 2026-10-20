-- ============================================================================
-- Dispenser Production & Jug Accountability
-- ----------------------------------------------------------------------------
-- Daily empty-jug accountability per marketer / outlet, built on the
-- container ledger of 20260928140000_container_tracking.sql (append-only
-- container_movements; a holder's balance is what came in minus what went
-- out). Production, warehouse receipt, dispatch and sales stay as they are:
--   production -> release_to_warehouse -> accept_production_release   (filled
--   jugs into finished goods, unchanged); create_stock_dispatch moves jugs
--   warehouse -> marketer; an approved sale moves them marketer -> customer;
--   a marketer's unsold-stock return moves them back.
--
-- Factory rules (confirmed 2026-10-20):
--   * Returns are two steps. The marketer / sales records what was brought
--     back ("Returned", a claim); the Warehouse counts and confirms
--     ("Received"). Only Received moves jugs back into the Warehouse and
--     reduces what the marketer owes; a shortfall stays outstanding.
--   * A refill sale is a swap: the customer hands over an empty, so the
--     marketer still owes that jug. A "Jug + Water" sale leaves the jug with
--     the customer; an "Empty jug" sale sells an empty for a price.
--   * Opening = the previous day's Outstanding: every jug, full or empty,
--     the marketer still owes, carried forward until a verified return, a jug
--     sale or an approved write-off.
--
-- Added here:
--   product_containers.jug_role   'refill' | 'with_water' | 'empty' (NULL =
--                                 ordinary returnable container, unchanged)
--   container_movements.product_id  which product moved the jug (to tell Jug
--                                 + Water sales from empty-jug sales)
--   jug_returns                   the claim -> verification of empties brought
--                                 back; verification writes the ledger move
--   set_product_jug_role, record_jug_return, verify_jug_return,
--   cancel_jug_return, jug_accountability_report, jug_overview
--
-- ------------------------------------------------------------- calculation
-- Per marketer, jug type and day (Africa/Lagos), from posted ledger rows:
--   Opening          ledger balance at the start of the day
--   Loaded           dispatches + issues - dispatch reversals
--   Total            Opening + Loaded
--   Jug + Water Sold jugs sold with water (net of deleted sales)
--   Empties Sold     empty jugs sold (net of deleted sales); Empties Cost =
--                    their invoice value
--   Returned         empties the marketer says they brought back (claims
--                    recorded that day; not a ledger move)
--   Expected Empties Total - Jug + Water Sold - Empties Sold
--   Received         empties verified by the Warehouse + unsold full jugs
--                    returned with a marketer stock return
--   Written off      jugs written off as lost (approved)
--   Outstanding      Expected Empties - Received - Written off
--                    = the ledger balance at the end of the day, which is
--                    the next day's Opening. Never clipped at zero: a
--                    negative figure means more came back than was owed and
--                    is shown for investigation.
-- Refill sales do not move a jug (swap), so they never change Outstanding;
-- they are listed for information.
-- ============================================================================

-- ============ 1. Jug roles and product on each movement ============
ALTER TABLE public.product_containers
  ADD COLUMN IF NOT EXISTS jug_role text
  CHECK (jug_role IS NULL OR jug_role IN ('refill', 'with_water', 'empty'));

ALTER TABLE public.container_movements ADD COLUMN IF NOT EXISTS product_id uuid;
CREATE INDEX IF NOT EXISTS idx_cm_type_created ON public.container_movements (container_type_id, created_at);

-- As 20260928140000, plus: records the product, and a refill (jug_role
-- 'refill') moves no jug when sold or returned by a customer -- the
-- customer swapped an empty for it.
CREATE OR REPLACE FUNCTION public._container_move_for_product(
  p_factory uuid, p_product uuid, p_units numeric,
  p_from_type text, p_from_id uuid, p_to_type text, p_to_id uuid,
  p_source text, p_reference text, p_sale uuid, p_dispatch uuid, p_rep_return uuid, p_sales_return uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, sale_id, dispatch_id, rep_return_id, sales_return_id, created_by,
                                  product_id)
  SELECT p_factory, pc.container_type_id, p_from_type, p_from_id, p_to_type, p_to_id, p_units * pc.quantity_per_unit,
         p_source, p_reference, p_sale, p_dispatch, p_rep_return, p_sales_return, auth.uid(), p_product
    FROM product_containers pc
    JOIN container_types ct ON ct.id = pc.container_type_id AND ct.active
   WHERE pc.product_id = p_product AND p_units > 0
     AND NOT (pc.jug_role IS NOT DISTINCT FROM 'refill' AND p_source IN ('sale', 'sales_return'));
END;
$$;
REVOKE ALL ON FUNCTION public._container_move_for_product(uuid,uuid,numeric,text,uuid,text,uuid,text,text,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;

-- As 20260928140000, plus the product.
CREATE OR REPLACE FUNCTION public._container_undo(p_column text, p_id uuid, p_source text, p_new_source text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  EXECUTE format(
    'INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                     source, reference, sale_id, dispatch_id, rep_return_id, sales_return_id, created_by,
                                     product_id)
     SELECT factory_id, container_type_id, to_type, to_id, from_type, from_id, quantity,
            $2, reference, sale_id, dispatch_id, rep_return_id, sales_return_id, auth.uid(), product_id
       FROM container_movements WHERE %I = $1 AND source = $3', p_column)
  USING p_id, p_new_source, p_source;
END;
$$;
REVOKE ALL ON FUNCTION public._container_undo(text, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Which jug a product carries, how many, and how its sale treats the jug.
-- p_quantity 0 removes the link (as set_product_container).
CREATE OR REPLACE FUNCTION public.set_product_jug_role(
  p_product uuid, p_container_type uuid, p_quantity numeric, p_role text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_factory uuid;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('refill', 'with_water', 'empty') THEN
    RAISE EXCEPTION 'Unknown jug role %', p_role;
  END IF;
  PERFORM public.set_product_container(p_product, p_container_type, p_quantity);
  IF COALESCE(p_quantity, 0) > 0 THEN
    SELECT factory_id INTO v_factory FROM container_types WHERE id = p_container_type;
    UPDATE product_containers SET jug_role = p_role
     WHERE product_id = p_product AND container_type_id = p_container_type;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'set_product_jug_role', 'products', p_product::text,
            jsonb_build_object('container_type_id', p_container_type, 'quantity_per_unit', p_quantity, 'jug_role', p_role));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_product_jug_role(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_product_jug_role(uuid, uuid, numeric, text) TO authenticated;

-- ============ 2. Helpers ============
CREATE OR REPLACE FUNCTION public._jug_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._can_view_containers()
      OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key);
$$;
REVOKE ALL ON FUNCTION public._jug_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._jug_can_view() TO authenticated;

CREATE OR REPLACE FUNCTION public._jug_day(p timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE AS $$ SELECT (p AT TIME ZONE 'Africa/Lagos')::date; $$;

-- Jugs a marketer holds now (full or empty), per the ledger.
CREATE OR REPLACE FUNCTION public._jug_rep_balance(p_rep uuid, p_type uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(CASE WHEN to_type = 'sales_rep' AND to_id = p_rep THEN quantity ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN from_type = 'sales_rep' AND from_id = p_rep THEN quantity ELSE 0 END), 0)
    FROM container_movements
   WHERE container_type_id = p_type
     AND ((to_type = 'sales_rep' AND to_id = p_rep) OR (from_type = 'sales_rep' AND from_id = p_rep));
$$;
REVOKE ALL ON FUNCTION public._jug_rep_balance(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Of those, how many are still full (unsold filled products on their stock).
CREATE OR REPLACE FUNCTION public._jug_rep_full(p_rep uuid, p_type uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(rs.quantity * pc.quantity_per_unit), 0)
    FROM rep_stock rs
    JOIN product_containers pc ON pc.product_id = rs.product_id AND pc.container_type_id = p_type
   WHERE rs.sales_rep_id = p_rep AND COALESCE(pc.jug_role, 'with_water') <> 'empty' AND rs.quantity > 0;
$$;
REVOKE ALL ON FUNCTION public._jug_rep_full(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ============ 3. Empty-jug returns: claim, then Warehouse verification ============
CREATE SEQUENCE IF NOT EXISTS public.jug_return_seq;

CREATE TABLE IF NOT EXISTS public.jug_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  client_ref uuid UNIQUE,
  sales_rep_id uuid NOT NULL REFERENCES public.sales_reps(id),
  container_type_id uuid NOT NULL REFERENCES public.container_types(id),
  quantity_claimed numeric(14,3) NOT NULL CHECK (quantity_claimed > 0 AND quantity_claimed = trunc(quantity_claimed)),
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'cancelled')),
  recorded_by uuid NOT NULL REFERENCES auth.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  quantity_received numeric(14,3) CHECK (quantity_received IS NULL OR (quantity_received >= 0 AND quantity_received = trunc(quantity_received))),
  verified_by uuid REFERENCES auth.users(id),
  verified_at timestamptz,
  verify_note text,
  cancelled_by uuid REFERENCES auth.users(id),
  cancelled_at timestamptz,
  cancel_reason text,
  CHECK ((status = 'verified') = (quantity_received IS NOT NULL AND verified_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jug_returns_rep_idx ON public.jug_returns (sales_rep_id, recorded_at);
CREATE INDEX IF NOT EXISTS jug_returns_pending_idx ON public.jug_returns (factory_id) WHERE status = 'pending';

ALTER TABLE public.jug_returns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "jug returns read" ON public.jug_returns;
CREATE POLICY "jug returns read" ON public.jug_returns FOR SELECT TO authenticated USING (public._jug_can_view());
REVOKE ALL ON public.jug_returns FROM anon, authenticated;
GRANT SELECT ON public.jug_returns TO authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'jug_returns') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.jug_returns;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'container_movements') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.container_movements;
  END IF;
END $$;

-- Marketer / sales / warehouse records what the marketer brought back. A
-- claim cannot exceed the empties the marketer can owe: jugs held per the
-- ledger, less those still full on their stock, less claims not yet verified.
-- Dated when recorded -- no back-dating into earlier reports.
CREATE OR REPLACE FUNCTION public.record_jug_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep uuid := NULLIF(payload->>'sales_rep_id', '')::uuid;
  v_type uuid := NULLIF(payload->>'container_type_id', '')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_r sales_reps%ROWTYPE;
  v_existing jug_returns%ROWTYPE;
  v_returnable numeric;
  v_ref text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'sales'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM jug_returns WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  -- Serialise claims per marketer so two at once cannot both pass the check.
  SELECT * INTO v_r FROM sales_reps WHERE id = v_rep FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = v_type AND factory_id = v_r.factory_id) THEN
    RAISE EXCEPTION 'Jug type not found for this factory';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN
    RAISE EXCEPTION 'Enter a whole number of jugs above 0';
  END IF;
  v_returnable := public._jug_rep_balance(v_rep, v_type) - public._jug_rep_full(v_rep, v_type)
                - COALESCE((SELECT SUM(quantity_claimed) FROM jug_returns
                             WHERE sales_rep_id = v_rep AND container_type_id = v_type AND status = 'pending'), 0);
  IF v_qty > GREATEST(v_returnable, 0) THEN
    RAISE EXCEPTION '% can return at most % empty jugs (the rest are full on their stock, already claimed, or not owed). Record a write-off or opening balance first if the figures are wrong.',
      v_r.full_name, trim_scale(GREATEST(v_returnable, 0));
  END IF;

  v_ref := 'JR-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-' || lpad(nextval('public.jug_return_seq')::text, 5, '0');
  INSERT INTO jug_returns(factory_id, reference, client_ref, sales_rep_id, container_type_id, quantity_claimed, notes, recorded_by)
  VALUES (v_r.factory_id, v_ref, v_client, v_rep, v_type, v_qty, v_notes, v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_r.factory_id, 'record_jug_return', 'jug_returns', v_id::text,
          jsonb_build_object('reference', v_ref, 'sales_rep_id', v_rep, 'quantity', v_qty));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.record_jug_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_jug_return(jsonb) TO authenticated;

-- The Warehouse counts what physically arrived. Only that count moves jugs
-- marketer -> Warehouse. A count different from the claim needs a note; the
-- difference stays with the marketer. Whoever recorded the claim cannot
-- verify it (unless super_admin / chairman). A return is verified once.
CREATE OR REPLACE FUNCTION public.verify_jug_return(p_id uuid, p_received numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_j jug_returns%ROWTYPE;
  v_rep sales_reps%ROWTYPE;
  v_can_hold numeric;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'confirm'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_j FROM jug_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  IF v_j.status <> 'pending' THEN RAISE EXCEPTION 'Return % is already %', v_j.reference, v_j.status; END IF;
  IF v_j.recorded_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Someone other than the person who recorded % must count and confirm it', v_j.reference;
  END IF;
  IF p_received IS NULL OR p_received < 0 OR p_received <> trunc(p_received) THEN
    RAISE EXCEPTION 'Enter the whole number of jugs counted (0 if none arrived)';
  END IF;
  IF p_received <> v_j.quantity_claimed AND v_note IS NULL THEN
    RAISE EXCEPTION 'The count differs from the % claimed -- say why', trim_scale(v_j.quantity_claimed);
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = v_j.sales_rep_id FOR UPDATE;
  v_can_hold := public._jug_rep_balance(v_j.sales_rep_id, v_j.container_type_id)
              - public._jug_rep_full(v_j.sales_rep_id, v_j.container_type_id);
  IF p_received > GREATEST(v_can_hold, 0) THEN
    RAISE EXCEPTION '% owes only % empty jugs -- more than that cannot be received from them. Record an opening balance first if they really held more.',
      v_rep.full_name, trim_scale(GREATEST(v_can_hold, 0));
  END IF;

  IF p_received > 0 THEN
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                    source, reference, notes, created_by)
    VALUES (v_j.factory_id, v_j.container_type_id, 'sales_rep', v_j.sales_rep_id, 'warehouse', NULL, p_received,
            'return', v_j.reference, COALESCE(v_note, v_j.notes), v_uid);
  END IF;
  UPDATE jug_returns SET status = 'verified', quantity_received = p_received, verified_by = v_uid,
         verified_at = now(), verify_note = v_note
   WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_j.factory_id, 'verify_jug_return', 'jug_returns', p_id::text,
          jsonb_build_object('claimed', v_j.quantity_claimed),
          jsonb_build_object('received', p_received, 'note', v_note));
  RETURN jsonb_build_object('reference', v_j.reference, 'received', p_received,
                            'short', v_j.quantity_claimed - p_received);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_jug_return(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_jug_return(uuid, numeric, text) TO authenticated;

-- A claim recorded in error, before it is counted.
CREATE OR REPLACE FUNCTION public.cancel_jug_return(p_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_j jug_returns%ROWTYPE;
BEGIN
  SELECT * INTO v_j FROM jug_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  IF NOT ((v_j.recorded_by = v_uid AND (public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key)
                                        OR public.has_permission(v_uid, 'sales'::module_key, 'create'::action_key)))
          OR public.has_permission(v_uid, 'distribution'::module_key, 'cancel'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_j.status <> 'pending' THEN RAISE EXCEPTION 'Only a return awaiting the Warehouse count can be cancelled'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  UPDATE jug_returns SET status = 'cancelled', cancelled_by = v_uid, cancelled_at = now(), cancel_reason = btrim(p_reason)
   WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_j.factory_id, 'cancel_jug_return', 'jug_returns', p_id::text, jsonb_build_object('reason', p_reason));
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_jug_return(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_jug_return(uuid, text) TO authenticated;

-- ============ 4. Daily accountability report ============
-- One row per marketer / outlet, jug type and day with an opening balance or
-- any activity. Everything is recomputed from the ledger, so a day's
-- Outstanding is always the next day's Opening.
CREATE OR REPLACE FUNCTION public.jug_accountability_report(
  p_factory uuid, p_from date, p_to date, p_container_type uuid DEFAULT NULL
) RETURNS TABLE (
  report_date date, sales_rep_id uuid, rep_code text, rep_name text, rep_kind text,
  container_type_id uuid, container_name text,
  opening numeric, loaded numeric, total numeric, jug_water_sold numeric, refills_sold numeric,
  empties_sold numeric, empties_value numeric, returned numeric, pending_claims numeric,
  expected_empties numeric, received numeric, written_off numeric, outstanding numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._jug_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to < p_from THEN RAISE EXCEPTION 'The end date is before the start date'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;

  RETURN QUERY
  WITH mv AS (
    SELECT CASE WHEN m.to_type = 'sales_rep' THEN m.to_id ELSE m.from_id END AS rep_id,
           m.container_type_id AS type_id, public._jug_day(m.created_at) AS d, m.source,
           CASE WHEN m.to_type = 'sales_rep' THEN m.quantity ELSE -m.quantity END AS delta,
           m.quantity AS qty, pc.jug_role
      FROM container_movements m
      LEFT JOIN product_containers pc ON pc.product_id = m.product_id AND pc.container_type_id = m.container_type_id
     WHERE m.factory_id = p_factory
       AND (p_container_type IS NULL OR m.container_type_id = p_container_type)
       AND (m.to_type = 'sales_rep' OR m.from_type = 'sales_rep')
       AND public._jug_day(m.created_at) <= p_to
  ), opening AS (
    SELECT rep_id, type_id, SUM(delta) AS bal FROM mv WHERE d < p_from GROUP BY 1, 2
  ), day_mv AS (
    SELECT rep_id, type_id, d,
           SUM(CASE WHEN source IN ('dispatch', 'issue') THEN qty WHEN source = 'dispatch_reversal' THEN -qty ELSE 0 END) AS loaded,
           SUM(CASE WHEN source = 'sale' AND COALESCE(jug_role, 'with_water') <> 'empty' THEN qty
                    WHEN source = 'sale_reversal' AND COALESCE(jug_role, 'with_water') <> 'empty' THEN -qty ELSE 0 END) AS jw,
           SUM(CASE WHEN source = 'sale' AND jug_role = 'empty' THEN qty
                    WHEN source = 'sale_reversal' AND jug_role = 'empty' THEN -qty ELSE 0 END) AS es,
           SUM(CASE WHEN source IN ('return', 'rep_return') THEN qty WHEN source = 'rep_return_cancelled' THEN -qty ELSE 0 END) AS rcv,
           SUM(CASE WHEN source = 'lost' THEN qty ELSE 0 END) AS wo,
           SUM(delta) AS net
      FROM mv WHERE d BETWEEN p_from AND p_to GROUP BY 1, 2, 3
  ), claims AS (
    SELECT j.sales_rep_id AS rep_id, j.container_type_id AS type_id, public._jug_day(j.recorded_at) AS d,
           SUM(j.quantity_claimed) AS claimed,
           SUM(j.quantity_claimed) FILTER (WHERE j.status = 'pending') AS pending
      FROM jug_returns j
     WHERE j.factory_id = p_factory AND j.status <> 'cancelled'
       AND (p_container_type IS NULL OR j.container_type_id = p_container_type)
       AND public._jug_day(j.recorded_at) BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3
  ), sales_info AS (
    -- Refills (swaps) and the value of empty jugs sold, from posted invoices.
    SELECT s.sales_rep_id AS rep_id, pc.container_type_id AS type_id, public._jug_day(COALESCE(s.approved_at, s.created_at)) AS d,
           SUM(CASE WHEN pc.jug_role = 'refill' THEN si.quantity * pc.quantity_per_unit ELSE 0 END) AS refills,
           SUM(CASE WHEN pc.jug_role = 'empty' THEN si.line_total ELSE 0 END) AS empties_value
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN product_containers pc ON pc.product_id = si.product_id AND pc.jug_role IS NOT NULL
     WHERE s.factory_id = p_factory AND s.sales_rep_id IS NOT NULL AND s.status = 'posted' AND s.deleted_at IS NULL
       AND (p_container_type IS NULL OR pc.container_type_id = p_container_type)
       AND public._jug_day(COALESCE(s.approved_at, s.created_at)) BETWEEN p_from AND p_to
     GROUP BY 1, 2, 3
  ), grid AS (
    SELECT r.id AS rep_id, ct.id AS type_id, g.d::date AS d
      FROM sales_reps r
      CROSS JOIN container_types ct
      CROSS JOIN generate_series(p_from, p_to, interval '1 day') g(d)
     WHERE r.factory_id = p_factory AND ct.factory_id = p_factory
       AND (p_container_type IS NULL OR ct.id = p_container_type)
  ), calc AS (
    SELECT g.d, g.rep_id, g.type_id,
           COALESCE(o.bal, 0)
             + COALESCE((SELECT SUM(x.net) FROM day_mv x
                          WHERE x.rep_id = g.rep_id AND x.type_id = g.type_id AND x.d < g.d), 0) AS opening,
           COALESCE(dm.loaded, 0) AS loaded, COALESCE(dm.jw, 0) AS jw, COALESCE(si.refills, 0) AS refills,
           COALESCE(dm.es, 0) AS es, COALESCE(si.empties_value, 0) AS ev,
           COALESCE(c.claimed, 0) AS claimed, COALESCE(c.pending, 0) AS pending,
           COALESCE(dm.rcv, 0) AS rcv, COALESCE(dm.wo, 0) AS wo,
           (dm.rep_id IS NOT NULL OR c.rep_id IS NOT NULL OR si.rep_id IS NOT NULL) AS active
      FROM grid g
      LEFT JOIN opening o ON o.rep_id = g.rep_id AND o.type_id = g.type_id
      LEFT JOIN day_mv dm ON dm.rep_id = g.rep_id AND dm.type_id = g.type_id AND dm.d = g.d
      LEFT JOIN claims c ON c.rep_id = g.rep_id AND c.type_id = g.type_id AND c.d = g.d
      LEFT JOIN sales_info si ON si.rep_id = g.rep_id AND si.type_id = g.type_id AND si.d = g.d
  )
  SELECT c.d, r.id, r.code, r.full_name, r.kind, ct.id, ct.name,
         c.opening, c.loaded, c.opening + c.loaded, c.jw, c.refills, c.es, c.ev, c.claimed, c.pending,
         c.opening + c.loaded - c.jw - c.es,
         c.rcv, c.wo,
         c.opening + c.loaded - c.jw - c.es - c.rcv - c.wo
    FROM calc c
    JOIN sales_reps r ON r.id = c.rep_id
    JOIN container_types ct ON ct.id = c.type_id
   WHERE c.active OR c.opening <> 0
   ORDER BY c.d, r.code, ct.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_accountability_report(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_accountability_report(uuid, date, date, uuid) TO authenticated;

-- ============ 5. Jug pool overview ============
-- Where every jug of each type is now, plus activity in a period. Filled jugs
-- in the Warehouse = finished-goods stock of the filled jug products; empties
-- = the Warehouse's ledger balance less those. A negative "empties" figure
-- means filled stock exists for jugs the ledger never received (opening jugs
-- not recorded) -- flagged as a discrepancy, not hidden.
CREATE OR REPLACE FUNCTION public.jug_overview(p_factory uuid, p_from date, p_to date)
RETURNS TABLE (
  container_type_id uuid, container_name text,
  in_circulation numeric, in_warehouse numeric, filled_in_warehouse numeric, empty_in_warehouse numeric,
  with_marketers numeric, full_with_marketers numeric, with_customers numeric, written_off_total numeric,
  pending_returns numeric, produced_approved numeric, issued numeric, sold_with_water numeric,
  empties_sold numeric, refills_sold numeric, received numeric, empties_value numeric, written_off numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._jug_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH bal AS (
    SELECT b.container_type_id AS type_id, b.holder_type, SUM(b.balance) AS qty
      FROM container_balances b WHERE b.factory_id = p_factory GROUP BY 1, 2
  ), per AS (
    SELECT ct.id AS type_id, ct.name,
           COALESCE((SELECT SUM(qty) FROM bal WHERE type_id = ct.id AND holder_type <> 'external'), 0) AS circ,
           COALESCE((SELECT qty FROM bal WHERE type_id = ct.id AND holder_type = 'warehouse'), 0) AS wh,
           COALESCE((SELECT SUM(p.current_stock * pc.quantity_per_unit) FROM product_containers pc
                      JOIN products p ON p.id = pc.product_id
                     WHERE pc.container_type_id = ct.id AND COALESCE(pc.jug_role, 'with_water') <> 'empty'), 0) AS filled,
           COALESCE((SELECT qty FROM bal WHERE type_id = ct.id AND holder_type = 'sales_rep'), 0) AS reps,
           COALESCE((SELECT SUM(rs.quantity * pc.quantity_per_unit) FROM rep_stock rs
                      JOIN product_containers pc ON pc.product_id = rs.product_id AND pc.container_type_id = ct.id
                     WHERE rs.factory_id = p_factory AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
                       AND rs.quantity > 0), 0) AS reps_full,
           COALESCE((SELECT SUM(qty) FROM bal WHERE type_id = ct.id AND holder_type IN ('customer', 'walk_in')), 0) AS cust,
           COALESCE((SELECT SUM(m.quantity) FROM container_movements m
                      WHERE m.container_type_id = ct.id AND m.to_type = 'external'), 0)
             - COALESCE((SELECT SUM(m.quantity) FROM container_movements m
                          WHERE m.container_type_id = ct.id AND m.from_type = 'external' AND m.source <> 'purchase'), 0) AS wo_total,
           COALESCE((SELECT SUM(j.quantity_claimed) FROM jug_returns j
                      WHERE j.container_type_id = ct.id AND j.status = 'pending'), 0) AS pend,
           COALESCE((SELECT SUM(pr.accepted_quantity * pc.quantity_per_unit) FROM production_releases pr
                      JOIN product_containers pc ON pc.product_id = pr.product_id AND pc.container_type_id = ct.id
                     WHERE pr.factory_id = p_factory AND pr.status = 'accepted'
                       AND COALESCE(pc.jug_role, 'with_water') <> 'empty'
                       AND public._jug_day(COALESCE(pr.accepted_at, pr.created_at)) BETWEEN p_from AND p_to), 0) AS produced
      FROM container_types ct WHERE ct.factory_id = p_factory
  ), act AS (
    SELECT r.container_type_id AS type_id,
           SUM(r.loaded) AS issued, SUM(r.jug_water_sold) AS jw, SUM(r.empties_sold) AS es,
           SUM(r.refills_sold) AS refills, SUM(r.received) AS rcv, SUM(r.empties_value) AS ev, SUM(r.written_off) AS wo
      FROM public.jug_accountability_report(p_factory, p_from, p_to, NULL) r
     GROUP BY 1
  )
  SELECT per.type_id, per.name, per.circ, per.wh, per.filled, per.wh - per.filled, per.reps, per.reps_full,
         per.cust, per.wo_total, per.pend, per.produced,
         COALESCE(act.issued, 0), COALESCE(act.jw, 0), COALESCE(act.es, 0), COALESCE(act.refills, 0),
         COALESCE(act.rcv, 0), COALESCE(act.ev, 0), COALESCE(act.wo, 0)
    FROM per LEFT JOIN act ON act.type_id = per.type_id
   ORDER BY per.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_overview(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_overview(uuid, date, date) TO authenticated;
