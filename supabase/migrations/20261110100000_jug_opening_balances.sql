-- ============================================================================
-- Dispenser jugs: opening balances for everyone showing a minus
-- ----------------------------------------------------------------------------
-- User (2026-11-10), QC -> Dispenser -> "Who is holding dispensers": customers
-- and marketers show minus figures because empties were recorded back from
-- them with no record of the jugs going out (held before tracking started).
-- Decision: give each one an opening balance dated the day before their first
-- return, as Abiodun's (20261104160000), which brings them to 0 -- EXCEPT
-- marketers supplied Dispenser Water on 9 Nov whose returned jugs were not
-- entered: those wait until their returns are in.
--
-- _jug_opening_balances(supply_day, apply)
--   One row per person whose Dispenser figure (Old + New Jug together, as the
--   screen shows it) is below 0:
--     OPENING BALANCE  an 'issue' from outside for exactly the shortfall,
--                      on the jug type(s) below 0, dated noon (Lagos) the day
--                      before their first return. Audit-logged.
--     HOLD             nothing is written:
--                      * a marketer (not the shop) supplied a dispenser on
--                        supply_day with no empties entered from that day on;
--                      * anyone with a jug return still waiting for the QC
--                        count -- their final figure isn't known yet.
--   apply = false only reports. Only 'issue' is used because the jug report
--   ignores 'count'. Nothing goes to or from the Warehouse.
--
-- Safe to run again: only people still below 0 are touched. After the held
-- marketers' returns are entered, run it again to clear them.
--
-- Paste this whole file into the Supabase SQL Editor, then:
--   Preview:
--     SELECT * FROM public._jug_opening_balances('2026-11-09', false) ORDER BY decision, who;
--   Apply:
--     SELECT * FROM public._jug_opening_balances('2026-11-09', true) ORDER BY decision, who;
-- SQL Editor only: no app user can call it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._jug_opening_balances(p_supply_day date, p_apply boolean DEFAULT false)
RETURNS TABLE(who text, holder text, decision text, jugs numeric, dated date, note text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
DECLARE
  h record;
  t record;
  v_kind text;
  v_first timestamptz;
  v_day date;
  v_left numeric;
  v_take numeric;
  v_hold text;
BEGIN
  IF p_supply_day IS NULL THEN RAISE EXCEPTION 'Give the supply day'; END IF;

  FOR h IN
    SELECT b.factory_id, b.holder_type, b.holder_id, -SUM(b.balance) AS short
      FROM container_balances b
      JOIN container_types ct ON ct.id = b.container_type_id
     WHERE b.holder_type IN ('customer', 'sales_rep') AND b.holder_id IS NOT NULL
       AND ct.name ~* 'jug|dispenser'
     GROUP BY b.factory_id, b.holder_type, b.holder_id
    HAVING SUM(b.balance) < 0
  LOOP
    v_kind := NULL;
    IF h.holder_type = 'customer' THEN
      SELECT c.name::text INTO who FROM customers c WHERE c.id = h.holder_id;
      holder := 'Customer';
    ELSE
      SELECT r.full_name::text, r.kind INTO who, v_kind FROM sales_reps r WHERE r.id = h.holder_id;
      holder := CASE WHEN v_kind = 'outlet' THEN 'Shop' ELSE 'Marketer' END;
    END IF;
    jugs := h.short;

    -- Their first return (any jug going back if no empties were ever entered).
    SELECT COALESCE(MIN(m.created_at) FILTER (WHERE m.source = 'return'), MIN(m.created_at))
      INTO v_first
      FROM container_movements m
      JOIN container_types ct ON ct.id = m.container_type_id
     WHERE m.from_type = h.holder_type AND m.from_id = h.holder_id AND ct.name ~* 'jug|dispenser';
    v_day := public._jug_day(v_first) - 1;

    v_hold := NULL;
    IF EXISTS (SELECT 1 FROM jug_returns j
                WHERE j.status = 'pending'
                  AND ((h.holder_type = 'sales_rep' AND j.sales_rep_id = h.holder_id)
                    OR (h.holder_type = 'customer' AND j.customer_id = h.holder_id))) THEN
      v_hold := 'A jug return is waiting for the QC count';
    ELSIF v_kind = 'rep'
      AND EXISTS (SELECT 1 FROM stock_dispatches d
                    JOIN stock_dispatch_items i ON i.dispatch_id = d.id
                   WHERE d.sales_rep_id = h.holder_id AND d.dispatch_date = p_supply_day
                     AND d.status::text <> 'reversed'
                     AND EXISTS (SELECT 1 FROM product_containers pc
                                   JOIN container_types ct ON ct.id = pc.container_type_id
                                  WHERE pc.product_id = i.product_id AND ct.name ~* 'jug|dispenser'
                                    AND pc.jug_role IS DISTINCT FROM 'empty'))
      AND NOT EXISTS (SELECT 1 FROM container_movements m
                        JOIN container_types ct ON ct.id = m.container_type_id
                       WHERE m.from_type = 'sales_rep' AND m.from_id = h.holder_id
                         AND m.source = 'return' AND ct.name ~* 'jug|dispenser'
                         AND public._jug_day(m.created_at) >= p_supply_day) THEN
      v_hold := format('Supplied dispensers on %s -- returned jugs not entered yet', p_supply_day);
    END IF;

    IF v_hold IS NOT NULL THEN
      decision := 'HOLD';
      dated := NULL;
      note := v_hold;
      RETURN NEXT;
      CONTINUE;
    END IF;

    decision := 'OPENING BALANCE';
    dated := v_day;
    note := 'Jugs held before tracking started';
    IF p_apply THEN
      -- Only the shortfall, so Old + New together land on 0.
      v_left := h.short;
      FOR t IN
        SELECT b.container_type_id, -b.balance AS below
          FROM container_balances b
          JOIN container_types ct ON ct.id = b.container_type_id
         WHERE b.holder_type = h.holder_type AND b.holder_id = h.holder_id
           AND b.balance < 0 AND ct.name ~* 'jug|dispenser'
         ORDER BY b.balance, b.container_type_id
      LOOP
        EXIT WHEN v_left <= 0;
        v_take := LEAST(v_left, t.below);
        INSERT INTO container_movements(factory_id, container_type_id, from_type, to_type, to_id, quantity, source,
                                        reference, notes, created_at)
        VALUES (h.factory_id, t.container_type_id, 'external', h.holder_type, h.holder_id, v_take, 'issue',
                'OPENING-BALANCE', 'Jugs held before tracking started (opening balance, entered 2026-11-10)',
                (v_day::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Lagos');
        v_left := v_left - v_take;
      END LOOP;

      INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
      VALUES (auth.uid(), h.factory_id, 'jug_opening_balance',
              CASE WHEN h.holder_type = 'customer' THEN 'customers' ELSE 'sales_reps' END, h.holder_id::text,
              jsonb_build_object('who', who, 'loaded', h.short, 'dated', v_day,
                                 'reason', 'Returned jugs held before tracking started'));
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$fn$;
REVOKE ALL ON FUNCTION public._jug_opening_balances(date, boolean) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
