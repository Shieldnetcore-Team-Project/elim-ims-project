-- ============================================================================
-- Warehouse returns: back-dated entry, and correcting a wrong date
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "a return for yesterday that is inputted today -- the
-- user should be able to back-date the return ... in every marketer's,
-- distributor's or retail account", and "where a wrong date is entered for
-- a return, the Warehouse should be able to correct the date".
--
-- The return functions kept the chosen date on the return only; the stock
-- moves were stamped with the time of entry, and the day figures, the
-- Warehouse Activity Log / Products Report and a marketer's or the shop's
-- account count stock by that stamp. Now a return dated an earlier day puts
-- its goods on that day (at 5 p.m. Lagos time, as record_jug_return does):
--   the return itself      rep_returns.return_date / received_at,
--                          sales_returns.return_date
--   the stock moves        rep_stock_movements, inventory_movements
--   the jugs               container_movements
-- What stays at the real time: audit_logs (who entered it, when), and a
-- distributor's money entry (customer_account_transactions: its running
-- balances are in entry order, so it is not moved).
--
--   create_rep_return / return_shop_stock_to_warehouse /
--   warehouse_receive_customer_return   as before (renamed *_core), then
--                          re-stamped when dated before today
--   correct_return_date(kind, reference, new_date, reason)
--                          the Warehouse moves a return to another day:
--                          reason required, audit-logged with old and new
--                          date; 'rep' = a marketer's / the shop's return
--                          (RRN-...), 'customer' = a customer's return
--                          (SR-..., all its lines and the marketer / shop
--                          returns it made)
-- Rules: never a future date; a shop day already handed to Accounts
-- (submitted / confirmed) can't gain or lose a return.
--
-- container_movements stays append-only, except that these functions may
-- change created_at alone (elim.redating, set for the moment and reset).
-- ============================================================================

-- ============ 1. The jug ledger allows a re-stamp, nothing else ============
CREATE OR REPLACE FUNCTION public._container_movements_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('elim.redating', true) = 'on'
     AND (to_jsonb(NEW) - 'created_at') = (to_jsonb(OLD) - 'created_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'container_movements is append-only; record a correcting movement instead';
END;
$$;

-- ============ 2. Helpers ============
CREATE OR REPLACE FUNCTION public._lagos_today()
RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Africa/Lagos')::date; $$;

-- When a return dated p_date counts: now for today, 5 p.m. that day before.
CREATE OR REPLACE FUNCTION public._return_at(p_date date)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_date >= public._lagos_today() THEN now()
              ELSE (p_date + time '17:00') AT TIME ZONE 'Africa/Lagos' END;
$$;

-- A return's date: not in the future; a shop day handed to Accounts is closed.
CREATE OR REPLACE FUNCTION public._check_return_day(p_date date, p_holder uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_date IS NULL THEN RAISE EXCEPTION 'Choose the return date'; END IF;
  IF p_date > public._lagos_today() THEN RAISE EXCEPTION 'A return can''t be dated in the future'; END IF;
  IF p_holder IS NOT NULL AND EXISTS (
       SELECT 1 FROM outlet_day_reconciliations
        WHERE sales_rep_id = p_holder AND close_date = p_date AND status IN ('submitted', 'confirmed')) THEN
    RAISE EXCEPTION 'The shop''s day % is already closed with Accounts -- choose another day, or ask Accounts to query it back.',
      to_char(p_date, 'DD Mon YYYY');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._check_return_day(date, uuid) FROM PUBLIC, anon, authenticated;

-- Put a marketer's / the shop's return (rep_returns) and all it moved on p_date.
CREATE OR REPLACE FUNCTION public._redate_rep_return(p_id uuid, p_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r rep_returns%ROWTYPE;
  v_at timestamptz := public._return_at(p_date);
BEGIN
  SELECT * INTO v_r FROM rep_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  UPDATE rep_returns SET return_date = p_date, received_at = v_at WHERE id = p_id;
  UPDATE rep_stock_movements SET created_at = v_at
   WHERE sales_rep_id = v_r.sales_rep_id AND reference = v_r.return_number;
  UPDATE inventory_movements SET created_at = v_at
   WHERE factory_id = v_r.factory_id AND reference = v_r.return_number;
  PERFORM set_config('elim.redating', 'on', true);
  UPDATE container_movements SET created_at = v_at WHERE rep_return_id = p_id;
  PERFORM set_config('elim.redating', 'off', true);
END;
$$;
REVOKE ALL ON FUNCTION public._redate_rep_return(uuid, date) FROM PUBLIC, anon, authenticated;

-- A customer's return: every line (SR-...-n), its moves, and the marketer /
-- shop returns it made (their notes name it).
CREATE OR REPLACE FUNCTION public._redate_customer_return(p_number text, p_date date)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_at timestamptz := public._return_at(p_date);
  v_like text := replace(replace(replace(p_number, '\', '\\'), '%', '\%'), '_', '\_') || '-%';
  v_n int;
  v_rr uuid;
BEGIN
  UPDATE sales_returns SET return_date = p_date
   WHERE return_number = p_number OR return_number LIKE v_like;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE rep_stock_movements SET created_at = v_at WHERE reference = p_number OR reference LIKE v_like;
  UPDATE inventory_movements SET created_at = v_at WHERE reference = p_number OR reference LIKE v_like;
  PERFORM set_config('elim.redating', 'on', true);
  UPDATE container_movements SET created_at = v_at
   WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE return_number = p_number OR return_number LIKE v_like);
  PERFORM set_config('elim.redating', 'off', true);
  FOR v_rr IN SELECT id FROM rep_returns WHERE notes LIKE '%(' || p_number || ')' LOOP
    PERFORM public._redate_rep_return(v_rr, p_date);
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public._redate_customer_return(text, date) FROM PUBLIC, anon, authenticated;

-- ============ 3. The return functions, back-dated ============
-- Each keeps its body under *_core; the public name checks the day, calls it,
-- and re-stamps a return dated before today.
DO $$
BEGIN
  IF to_regprocedure('public._create_rep_return_core(jsonb)') IS NULL THEN
    ALTER FUNCTION public.create_rep_return(jsonb) RENAME TO _create_rep_return_core;
  END IF;
  IF to_regprocedure('public._return_shop_stock_core(jsonb)') IS NULL THEN
    ALTER FUNCTION public.return_shop_stock_to_warehouse(jsonb) RENAME TO _return_shop_stock_core;
  END IF;
  IF to_regprocedure('public._warehouse_customer_return_core(jsonb)') IS NULL THEN
    ALTER FUNCTION public.warehouse_receive_customer_return(jsonb) RENAME TO _warehouse_customer_return_core;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._create_rep_return_core(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._return_shop_stock_core(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._warehouse_customer_return_core(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_rep_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, public._lagos_today());
  v jsonb;
BEGIN
  -- The core's own rights first, so a day's status isn't told to anyone else.
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  PERFORM public._check_return_day(v_date, NULLIF(payload->>'sales_rep_id', '')::uuid);
  v := public._create_rep_return_core(payload || jsonb_build_object('return_date', v_date));
  IF v_date < public._lagos_today() THEN PERFORM public._redate_rep_return((v->>'id')::uuid, v_date); END IF;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.create_rep_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_rep_return(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.return_shop_stock_to_warehouse(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, public._lagos_today());
  v jsonb;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'create'::action_key)
       OR public.has_permission(auth.uid(), 'sales'::module_key, 'write'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  PERFORM public._check_return_day(v_date, NULLIF(payload->>'outlet_id', '')::uuid);
  v := public._return_shop_stock_core(payload || jsonb_build_object('return_date', v_date));
  IF v_date < public._lagos_today() THEN PERFORM public._redate_rep_return((v->>'id')::uuid, v_date); END IF;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.return_shop_stock_to_warehouse(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_shop_stock_to_warehouse(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.warehouse_receive_customer_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := COALESCE(NULLIF(payload->>'return_date', '')::date, public._lagos_today());
  v jsonb;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales-returns'::module_key, 'submit'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  PERFORM public._check_return_day(v_date, NULL);
  -- The marketer / shop returns it makes go through create_rep_return,
  -- which checks their day and re-stamps them.
  v := public._warehouse_customer_return_core(payload || jsonb_build_object('return_date', v_date));
  IF v_date < public._lagos_today() THEN PERFORM public._redate_customer_return(v->>'return_number', v_date); END IF;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.warehouse_receive_customer_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_receive_customer_return(jsonb) TO authenticated;

-- ============ 4. Correcting a return's date ============
-- p_kind 'rep' (p_reference = RRN-..., a marketer's / the shop's return) or
-- 'customer' (SR-..., a customer's return). Same rights as recording one.
CREATE OR REPLACE FUNCTION public.correct_return_date(p_kind text, p_reference text, p_date date, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ref text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_r rep_returns%ROWTYPE;
  v_old date;
  v_factory uuid;
  v_holder uuid;
  v_base text;
  v_like text;
  v_n int := 0;
  v_rr rep_returns%ROWTYPE;
BEGIN
  -- The rights create_rep_return / warehouse_receive_customer_return check.
  IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'submit'::action_key)
       OR public.has_permission(v_uid, 'sales-returns'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Which return?'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Say why the date is being corrected'; END IF;

  IF p_kind = 'rep' THEN
    SELECT * INTO v_r FROM rep_returns WHERE return_number = v_ref FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Return % not found', v_ref; END IF;
    IF v_r.status <> 'completed' THEN RAISE EXCEPTION 'Only a completed return can be re-dated'; END IF;
    v_old := v_r.return_date; v_factory := v_r.factory_id; v_holder := v_r.sales_rep_id;
    IF NOT public._works_in_factory(v_uid, v_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    IF v_old = p_date THEN RAISE EXCEPTION 'The return is already dated %', to_char(p_date, 'DD Mon YYYY'); END IF;
    PERFORM public._check_return_day(v_old, v_holder);
    PERFORM public._check_return_day(p_date, v_holder);
    PERFORM public._redate_rep_return(v_r.id, p_date);
    v_n := 1;
  ELSIF p_kind = 'customer' THEN
    -- A line number (SR-...-2) means its whole return (SR-...).
    v_base := CASE WHEN EXISTS (SELECT 1 FROM sales_returns WHERE return_number LIKE
                                  replace(replace(replace(v_ref, '\', '\\'), '%', '\%'), '_', '\_') || '-%')
                   THEN v_ref ELSE regexp_replace(v_ref, '-\d+$', '') END;
    v_like := replace(replace(replace(v_base, '\', '\\'), '%', '\%'), '_', '\_') || '-%';
    SELECT max(return_date), max(factory_id::text)::uuid INTO v_old, v_factory FROM sales_returns
     WHERE (return_number = v_base OR return_number LIKE v_like) AND status = 'completed';
    IF v_factory IS NULL THEN RAISE EXCEPTION 'Return % not found', v_ref; END IF;
    IF NOT public._works_in_factory(v_uid, v_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    IF v_old = p_date THEN RAISE EXCEPTION 'The return is already dated %', to_char(p_date, 'DD Mon YYYY'); END IF;
    PERFORM public._check_return_day(v_old, NULL);
    PERFORM public._check_return_day(p_date, NULL);
    -- The shop's days, where the goods went back through the shop.
    FOR v_rr IN SELECT * FROM rep_returns WHERE notes LIKE '%(' || v_base || ')' LOOP
      PERFORM public._check_return_day(v_rr.return_date, v_rr.sales_rep_id);
      PERFORM public._check_return_day(p_date, v_rr.sales_rep_id);
    END LOOP;
    v_n := public._redate_customer_return(v_base, p_date);
    v_ref := v_base;
  ELSE
    RAISE EXCEPTION 'Unknown kind of return %', p_kind;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'correct_return_date', CASE WHEN p_kind = 'rep' THEN 'rep_returns' ELSE 'sales_returns' END,
          v_ref, jsonb_build_object('return_date', v_old),
          jsonb_build_object('return_date', p_date, 'reason', v_reason, 'lines', v_n));
  RETURN jsonb_build_object('reference', v_ref, 'old_date', v_old, 'return_date', p_date, 'lines', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_return_date(text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_return_date(text, text, date, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
