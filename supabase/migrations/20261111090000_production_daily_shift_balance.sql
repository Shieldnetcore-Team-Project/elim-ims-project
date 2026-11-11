-- ============================================================================
-- Production: daily and shift opening / closing balances, carried forward
-- ----------------------------------------------------------------------------
-- User (2026-11-11): Sachet Water production must open each day at the
-- previous day's closing balance, as Bottle Water does, with each shift's
-- opening, production, issues, damages and closing shown, and production
-- that runs past 6 p.m. kept on its own production day.
--
-- Every product already shares one production hall (20261014190000):
--   in hall = opening row + batches - releases - clearances.
-- That running total was right, but the Production page only showed "in hall
-- now": nothing showed what a day or shift opened and closed with, and a
-- release (the hall's issue) carried no production day or shift -- only the
-- clock time. Releasing last night's sachet after midnight, or recording it
-- the next morning, left the PM to work out yesterday's closing from the
-- Products Report by hand.
--
-- What this adds (nothing is stored twice; balances are always worked out
-- from the ledger, so a correction re-flows into every later day):
--
--   1. production_releases.production_date / shift: the production day and
--      shift an issue belongs to. Earlier releases take their Lagos calendar
--      day (exactly what the Products Report already used) and the shift of
--      their clock time. release_to_warehouse takes both from the payload,
--      defaulting to the same, so it can be put on the right day when it is
--      entered late -- up to 7 days back, never before the hall's opening
--      balance, never in the future. Late releases are flagged in the audit
--      log.
--   2. production_daily_balance(factory, product|null, from, to): for every
--      day and shift (Day, then Night, then Over-Time): opening, produced,
--      damaged, issued (released), cleared, closing and who produced.
--      A shift opens at the previous shift's closing; a day opens at the
--      previous day's closing; a production_hall_openings row resets the
--      balance on its day (same rules as _production_hall_available).
--      Today's last closing equals what is in the hall now.
--   3. Audit: every batch recorded is written to audit_logs with its
--      production date, shift and whether it was entered late (dated before
--      the day it was entered).
--   4. Duplicate guard: the same person recording the same product, date,
--      shift and quantity again within 2 minutes is refused (double click /
--      resend). Batches and releases of one product are serialised on the
--      same lock, so simultaneous shift postings can't interleave.
--
-- The hall's own figures (_production_hall_available, production_hall_stock,
-- release checks) and the Bottle Water flow are unchanged.
-- Safe to run again.
-- ============================================================================

-- ---- 1. Production day and shift of a release ----
CREATE OR REPLACE FUNCTION public._production_shift_at(p_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN extract(dow FROM (p_at AT TIME ZONE 'Africa/Lagos')) = 0 THEN 'overtime'
    WHEN extract(hour FROM (p_at AT TIME ZONE 'Africa/Lagos')) >= 18 THEN 'night'
    ELSE 'day' END;
$$;

ALTER TABLE public.production_releases ADD COLUMN IF NOT EXISTS production_date date;
ALTER TABLE public.production_releases ADD COLUMN IF NOT EXISTS shift text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.production_releases'::regclass
                    AND conname = 'production_releases_shift_check') THEN
    ALTER TABLE public.production_releases ADD CONSTRAINT production_releases_shift_check
      CHECK (shift IS NULL OR shift IN ('day', 'night', 'overtime'));
  END IF;
END $$;

UPDATE public.production_releases
   SET production_date = COALESCE(production_date, (released_at AT TIME ZONE 'Africa/Lagos')::date),
       shift = COALESCE(shift, public._production_shift_at(released_at))
 WHERE production_date IS NULL OR shift IS NULL;

CREATE INDEX IF NOT EXISTS production_releases_product_day_idx
  ON public.production_releases (factory_id, product_id, production_date);

-- Same body as 20261014220000, plus the production day / shift.
CREATE OR REPLACE FUNCTION public.release_to_warehouse(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_product uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_request uuid := NULLIF(payload->>'production_request_id', '')::uuid;
  v_notes text := NULLIF(btrim(payload->>'notes'), '');
  v_name text := NULLIF(btrim(payload->>'released_by_name'), '');
  v_today date := (now() AT TIME ZONE 'Africa/Lagos')::date;
  v_day date := COALESCE(NULLIF(payload->>'production_date', '')::date, v_today);
  v_shift text := COALESCE(NULLIF(payload->>'shift', ''), public._production_shift_at(now()));
  v_open date;
  v_unit text;
  v_available numeric;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'production'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'production'::module_key, 'submit'::action_key)
          OR public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL OR v_product IS NULL THEN RAISE EXCEPTION 'factory_id and product_id are required'; END IF;
  IF NOT public.has_production_scope_access(v_uid, v_factory) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity to release must be > 0'; END IF;
  IF v_shift NOT IN ('day', 'night', 'overtime') THEN RAISE EXCEPTION 'Shift must be Day, Night or Over-Time'; END IF;
  -- Anything on a Sunday is Over-Time (20261109110000).
  IF extract(dow FROM v_day) = 0 THEN v_shift := 'overtime'; END IF;
  IF v_day > v_today THEN RAISE EXCEPTION 'A release cannot be dated after today'; END IF;
  IF v_day < v_today - 7 THEN
    RAISE EXCEPTION 'A release can be put on a production day up to 7 days back only';
  END IF;

  SELECT unit INTO v_unit FROM products WHERE id = v_product AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found in this factory'; END IF;
  IF v_request IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM production_requests WHERE id = v_request AND factory_id = v_factory
  ) THEN
    RAISE EXCEPTION 'Request not found in this factory';
  END IF;
  v_open := (SELECT max(opening_date) FROM production_hall_openings
              WHERE factory_id = v_factory AND product_id = v_product);
  IF v_open IS NOT NULL AND v_day < v_open THEN
    RAISE EXCEPTION 'The production hall opened at its opening balance on % -- a release cannot be dated before it',
      to_char(v_open, 'DD Mon YYYY');
  END IF;

  -- One release per product at a time, so two people can't both release the
  -- same hall stock.
  PERFORM pg_advisory_xact_lock(hashtext('production_hall:' || v_factory::text || ':' || v_product::text));
  v_available := public._production_hall_available(v_factory, v_product);
  IF v_qty > v_available THEN
    RAISE EXCEPTION 'Only % % of this product is in the production hall', v_available, COALESCE(v_unit, '');
  END IF;

  v_number := 'REL-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  INSERT INTO production_releases (factory_id, release_number, product_id, quantity, unit,
                                   production_request_id, notes, released_by, released_by_name,
                                   production_date, shift)
  VALUES (v_factory, v_number, v_product, v_qty, v_unit, v_request, v_notes, v_uid,
          COALESCE(v_name, (SELECT full_name FROM profiles WHERE id = v_uid)), v_day, v_shift)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'release_to_warehouse', 'production_releases', v_id::text,
          jsonb_build_object('release_number', v_number, 'product_id', v_product, 'quantity', v_qty,
                             'production_date', v_day, 'shift', v_shift, 'late_entry', v_day < v_today));

  RETURN jsonb_build_object('id', v_id, 'release_number', v_number, 'in_hall_after', v_available - v_qty,
                            'production_date', v_day, 'shift', v_shift);
END;
$$;
REVOKE ALL ON FUNCTION public.release_to_warehouse(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_to_warehouse(jsonb) TO authenticated;

-- The hall's count as 20261031130000, except that a release is "before the
-- opening" by its production day rather than its clock day. Every release
-- made so far has production_date = its Lagos clock day (backfilled above),
-- so no figure changes today; it keeps the hall and the daily ledger equal
-- when a release is put on an earlier production day.
CREATE OR REPLACE FUNCTION public._production_hall_available(p_factory uuid, p_product uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH o AS (
    SELECT h.opening_date, h.quantity, h.created_at FROM production_hall_openings h
     WHERE h.factory_id = p_factory AND h.product_id = p_product
     ORDER BY h.opening_date DESC LIMIT 1
  )
  SELECT
    COALESCE((SELECT quantity FROM o), 0)
  + COALESCE((SELECT SUM(p.quantity_produced - COALESCE(p.damaged_quantity, 0))
                FROM production p
               WHERE p.factory_id = p_factory AND p.product_id = p_product
                 AND p.status = 'pending_confirmation'
                 AND (NOT EXISTS (SELECT 1 FROM o)
                      OR p.production_date >= (SELECT opening_date FROM o)
                      OR p.created_at > (SELECT created_at FROM o))), 0)
  - COALESCE((SELECT SUM(r.quantity)
                FROM production_releases r
               WHERE r.factory_id = p_factory AND r.product_id = p_product
                 AND r.status IN ('pending','accepted')
                 AND (NOT EXISTS (SELECT 1 FROM o)
                      OR COALESCE(r.production_date, (r.released_at AT TIME ZONE 'Africa/Lagos')::date)
                           >= (SELECT opening_date FROM o))), 0)
  - COALESCE((SELECT SUM(c.quantity)
                FROM production_hall_clearances c
               WHERE c.factory_id = p_factory AND c.product_id = p_product
                 AND (NOT EXISTS (SELECT 1 FROM o)
                      OR (c.cleared_at AT TIME ZONE 'Africa/Lagos')::date >= (SELECT opening_date FROM o))), 0);
$$;
REVOKE ALL ON FUNCTION public._production_hall_available(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---- 3 + 4. Batches: duplicate guard, one lock per product, audit ----
CREATE OR REPLACE FUNCTION public._production_before_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('production_hall:' || NEW.factory_id::text || ':' || NEW.product_id::text));
  IF EXISTS (
    SELECT 1 FROM production p
     WHERE p.factory_id = NEW.factory_id AND p.product_id = NEW.product_id
       AND p.production_date = NEW.production_date
       AND p.shift IS NOT DISTINCT FROM NEW.shift
       AND p.quantity_produced = NEW.quantity_produced
       AND p.created_by IS NOT DISTINCT FROM NEW.created_by
       AND COALESCE(p.status::text, '') NOT IN ('cancelled', 'rejected')
       AND p.created_at > now() - interval '2 minutes'
  ) THEN
    RAISE EXCEPTION 'This batch (% on % %) was already recorded a moment ago -- check the list before entering it again',
      NEW.quantity_produced, to_char(NEW.production_date, 'DD Mon YYYY'), COALESCE(NEW.shift, '');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_production_before_insert ON public.production;
CREATE TRIGGER trg_production_before_insert BEFORE INSERT ON public.production
  FOR EACH ROW EXECUTE FUNCTION public._production_before_insert();

CREATE OR REPLACE FUNCTION public._production_audit_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_entered date := (NEW.created_at AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (COALESCE(auth.uid(), NEW.created_by), NEW.factory_id, 'record_production', 'production', NEW.id::text,
          jsonb_build_object('production_number', NEW.production_number, 'product_id', NEW.product_id,
                             'quantity', NEW.quantity_produced, 'production_date', NEW.production_date,
                             'shift', NEW.shift, 'supervisor', NEW.supervisor,
                             'entered_on', v_entered,
                             -- Entered after its production day (e.g. the night's
                             -- run keyed in next morning, or a correction).
                             'late_entry', NEW.production_date < v_entered));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_production_audit_insert ON public.production;
CREATE TRIGGER trg_production_audit_insert AFTER INSERT ON public.production
  FOR EACH ROW EXECUTE FUNCTION public._production_audit_insert();

-- ---- 2. The daily / shift ledger ----
-- Shifts run Day, then Night (which goes on past 6 p.m., still on its own
-- production day), then Over-Time. Worked out in one pass over the whole
-- history: a production_hall_openings row starts a new segment at its
-- quantity; within a segment the balance is the running sum of
-- produced - damaged - issued - cleared.
CREATE OR REPLACE FUNCTION public.production_daily_balance(
  p_factory uuid, p_product uuid, p_from date, p_to date)
RETURNS TABLE(product_id uuid, product_name text, unit text,
              production_date date, shift text,
              prev_closing numeric, opening numeric, opening_reset boolean,
              produced numeric, damaged numeric, issued numeric, cleared numeric,
              closing numeric, operators text, batches int, releases int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  IF p_to - p_from > 400 THEN RAISE EXCEPTION 'Pick a range of at most 400 days'; END IF;

  RETURN QUERY
  WITH opn AS (
    SELECT o.product_id AS pid, o.opening_date AS d, o.quantity AS qty, o.created_at
      FROM production_hall_openings o
     WHERE o.factory_id = p_factory AND (p_product IS NULL OR o.product_id = p_product)
       AND o.opening_date <= p_to
  ), ev AS (
    -- Batches; one entered after a later opening was counted counts from
    -- that opening's day (20261031130000).
    SELECT p.product_id AS pid,
           GREATEST(p.production_date,
                    COALESCE((SELECT max(o.d) FROM opn o
                               WHERE o.pid = p.product_id AND o.created_at < p.created_at),
                             p.production_date)) AS d,
           COALESCE(p.shift, 'day') AS s,
           p.quantity_produced AS made, COALESCE(p.damaged_quantity, 0) AS dmg,
           0::numeric AS iss, 0::numeric AS clr,
           NULLIF(btrim(p.supervisor), '') AS op, 1 AS nb, 0 AS nr
      FROM production p
     WHERE p.factory_id = p_factory AND (p_product IS NULL OR p.product_id = p_product)
       AND p.status::text IN ('pending_confirmation', 'confirmed', 'posted')
    UNION ALL
    -- Accepted whole by the Warehouse before releases existed: out that day.
    SELECT p.product_id, (p.confirmed_at AT TIME ZONE 'Africa/Lagos')::date,
           public._production_shift_at(p.confirmed_at),
           0, 0, p.quantity_produced - COALESCE(p.damaged_quantity, 0), 0, NULL, 0, 0
      FROM production p
     WHERE p.factory_id = p_factory AND (p_product IS NULL OR p.product_id = p_product)
       AND p.status::text IN ('confirmed', 'posted') AND p.confirmed_at IS NOT NULL
    UNION ALL
    -- Releases still out of the hall; refused / withdrawn / reversed ones went
    -- back in, so they never count.
    SELECT r.product_id,
           COALESCE(r.production_date, (r.released_at AT TIME ZONE 'Africa/Lagos')::date),
           COALESCE(r.shift, public._production_shift_at(r.released_at)),
           0, 0, r.quantity, 0, NULL, 0, 1
      FROM production_releases r
     WHERE r.factory_id = p_factory AND (p_product IS NULL OR r.product_id = p_product)
       AND r.status IN ('pending', 'accepted')
    UNION ALL
    SELECT c.product_id, (c.cleared_at AT TIME ZONE 'Africa/Lagos')::date,
           public._production_shift_at(c.cleared_at), 0, 0, 0, c.quantity, NULL, 0, 0
      FROM production_hall_clearances c
     WHERE c.factory_id = p_factory AND (p_product IS NULL OR c.product_id = p_product)
  ), agg AS (
    SELECT ev.pid, ev.d, ev.s, sum(ev.made) AS made, sum(ev.dmg) AS dmg, sum(ev.iss) AS iss,
           sum(ev.clr) AS clr, string_agg(DISTINCT ev.op, ', ') AS ops,
           sum(ev.nb)::int AS nb, sum(ev.nr)::int AS nr
      FROM ev WHERE ev.d <= p_to
     GROUP BY ev.pid, ev.d, ev.s
  ), prods AS (
    SELECT pr.id, pr.name, pr.unit,
           LEAST(p_from,
                 COALESCE((SELECT min(a.d) FROM agg a WHERE a.pid = pr.id), p_from),
                 COALESCE((SELECT min(o.d) FROM opn o WHERE o.pid = pr.id), p_from)) AS start
      FROM products pr
     WHERE pr.factory_id = p_factory
       AND (p_product IS NULL OR pr.id = p_product)
       AND (p_product IS NOT NULL
            OR EXISTS (SELECT 1 FROM agg a WHERE a.pid = pr.id)
            OR EXISTS (SELECT 1 FROM opn o WHERE o.pid = pr.id))
  ), grid AS (
    SELECT pp.id, pp.name, pp.unit, g::date AS d, sh.s, sh.ord
      FROM prods pp
     CROSS JOIN generate_series(pp.start::timestamp, p_to::timestamp, interval '1 day') g
     CROSS JOIN (VALUES ('day', 1), ('night', 2), ('overtime', 3)) sh(s, ord)
  ), lines AS (
    SELECT gr.*, COALESCE(a.made, 0) AS made, COALESCE(a.dmg, 0) AS dmg,
           COALESCE(a.iss, 0) AS iss, COALESCE(a.clr, 0) AS clr,
           COALESCE(a.made, 0) - COALESCE(a.dmg, 0) - COALESCE(a.iss, 0) - COALESCE(a.clr, 0) AS net,
           a.ops, COALESCE(a.nb, 0) AS nb, COALESCE(a.nr, 0) AS nr,
           CASE WHEN gr.ord = 1 THEN (SELECT o.qty FROM opn o WHERE o.pid = gr.id AND o.d = gr.d) END AS reset_qty
      FROM grid gr
      LEFT JOIN agg a ON a.pid = gr.id AND a.d = gr.d AND a.s = gr.s
  ), seg AS (
    SELECT l.*, count(l.reset_qty) OVER (PARTITION BY l.id ORDER BY l.d, l.ord) AS seg_no
      FROM lines l
  ), bal AS (
    SELECT s.*,
           COALESCE(max(s.reset_qty) OVER (PARTITION BY s.id, s.seg_no), 0)
             + sum(s.net) OVER (PARTITION BY s.id, s.seg_no ORDER BY s.d, s.ord) AS close_bal
      FROM seg s
  ), fin AS (
    SELECT b.*, COALESCE(lag(b.close_bal) OVER (PARTITION BY b.id ORDER BY b.d, b.ord), 0) AS prev_bal
      FROM bal b
  )
  SELECT f.id, f.name, f.unit, f.d, f.s,
         f.prev_bal, f.close_bal - f.net, f.reset_qty IS NOT NULL,
         f.made, f.dmg, f.iss, f.clr, f.close_bal, f.ops, f.nb, f.nr
    FROM fin f
   WHERE f.d >= p_from
   ORDER BY f.name, f.d, f.ord;
END;
$$;
REVOKE ALL ON FUNCTION public.production_daily_balance(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_daily_balance(uuid, uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
