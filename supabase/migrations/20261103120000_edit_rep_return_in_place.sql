-- ============================================================================
-- The Warehouse edits a return in place -- no reason, no duplicate record
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "remove reason as to why warehouse edit returns ... once
-- warehouse edits returns, it goes into effect immediately and adjusts to the
-- edited one without duplicate of record, but in the audit log it should be
-- recorded".
--
-- correct_rep_return(p_id, payload) now edits the return itself (as of
-- 20261103100000 it cancelled it and recorded a new one under a new number):
--   * the same return (same RRN number) takes the new figures: each line is
--     updated, a new product added, a line set to 0 dropped;
--   * stock moves by the difference only -- off the marketer's / shop's
--     stock and into the Warehouse, or back -- and the jugs with it, all on
--     the return's own day, so the day's figures show the edited total;
--   * payload.return_date moves the whole return to that day as well;
--   * every line at 0 removes the return (cancelled: its goods and jugs go
--     back to them, on its day).
-- A reason is optional (payload.reason). audit_logs keeps who edited it,
-- when, and the figures and date before and after.
-- correct_return_date: the reason is optional too.
-- Unchanged: same right (distribution:submit); only a completed return; a
-- return already added to a live posting is corrected through the posting;
-- a shop day closed with Accounts can't change; the net change must be
-- possible (the Warehouse still has what goes back, they still hold what
-- they return).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.correct_rep_return(p_id uuid, payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_r rep_returns%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_date date;
  v_at timestamptz;
  v_items jsonb := COALESCE(payload->'items', '[]'::jsonb);
  v_old_items jsonb;
  v_line record;
  v_before numeric;
  v_short text;
  v_price numeric;
  v_removed boolean;
  v_diff jsonb;
  v_prev_back uuid[];
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'items must be a list'; END IF;
  SELECT * INTO v_r FROM rep_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_r.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_r.status <> 'completed' THEN RAISE EXCEPTION 'Only a completed return can be edited (this one is %)', v_r.status; END IF;
  IF v_r.carried_dispatch_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM stock_dispatches d WHERE d.id = v_r.carried_dispatch_id AND d.status <> 'reversed') THEN
    RAISE EXCEPTION 'This return was already added to posting % -- correct that posting instead',
      (SELECT dispatch_number FROM stock_dispatches WHERE id = v_r.carried_dispatch_id);
  END IF;
  v_date := COALESCE(NULLIF(payload->>'return_date', '')::date, v_r.return_date);
  PERFORM public._check_return_day(v_r.return_date, v_r.sales_rep_id);
  PERFORM public._check_return_day(v_date, v_r.sales_rep_id);
  v_at := public._return_at(v_r.return_date);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity_returned', quantity_returned)), '[]'::jsonb)
    INTO v_old_items FROM rep_return_items WHERE rep_return_id = p_id;

  -- Old and new per product, and the difference.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', COALESCE(o.product_id, n.product_id),
                                                'old_q', COALESCE(o.q, 0), 'new_q', COALESCE(n.q, 0))), '[]'::jsonb)
    INTO v_diff
    FROM (SELECT product_id, SUM(quantity_returned) AS q FROM rep_return_items
           WHERE rep_return_id = p_id GROUP BY 1) o
    FULL JOIN (SELECT (i->>'product_id')::uuid AS product_id,
                      SUM(GREATEST(COALESCE(NULLIF(i->>'quantity_returned', '')::numeric, 0), 0)) AS q
                 FROM jsonb_array_elements(v_items) i GROUP BY 1) n ON n.product_id = o.product_id;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(v_diff) AS e(product_id uuid, old_q numeric, new_q numeric) LEFT JOIN products p ON p.id = e.product_id AND p.factory_id = v_r.factory_id
              WHERE p.id IS NULL) THEN
    RAISE EXCEPTION 'Product not found';
  END IF;
  v_removed := NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_diff) AS e(product_id uuid, old_q numeric, new_q numeric) WHERE e.new_q > 0);

  SELECT string_agg(p.name, ', ') INTO v_short
    FROM jsonb_to_recordset(v_diff) AS e(product_id uuid, old_q numeric, new_q numeric) JOIN products p ON p.id = e.product_id
    LEFT JOIN rep_stock rs ON rs.sales_rep_id = v_r.sales_rep_id AND rs.product_id = e.product_id
   WHERE (e.new_q < e.old_q AND p.current_stock < e.old_q - e.new_q)             -- Warehouse gives back more than it has
      OR (e.new_q > e.old_q AND COALESCE(rs.quantity, 0) < e.new_q - e.old_q);   -- they return more than they hold
  IF v_short IS NOT NULL THEN
    RAISE EXCEPTION 'The edit isn''t possible for: % (not enough stock left to move)', v_short;
  END IF;

  -- Stock by the difference, on the return's own day, under its number.
  FOR v_line IN SELECT * FROM jsonb_to_recordset(v_diff) AS e(product_id uuid, old_q numeric, new_q numeric) WHERE e.new_q <> e.old_q LOOP
    SELECT quantity INTO v_before FROM rep_stock
     WHERE sales_rep_id = v_r.sales_rep_id AND product_id = v_line.product_id FOR UPDATE;
    IF NOT FOUND THEN
      v_before := 0;
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
      VALUES (v_r.sales_rep_id, v_line.product_id, v_r.factory_id, 0);
    END IF;
    UPDATE rep_stock SET quantity = quantity - (v_line.new_q - v_line.old_q), updated_at = now()
     WHERE sales_rep_id = v_r.sales_rep_id AND product_id = v_line.product_id;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                    user_id, quantity_before, quantity_after, created_at)
    VALUES (v_r.factory_id, v_r.sales_rep_id, v_line.product_id, 'returned_out', -(v_line.new_q - v_line.old_q),
            v_r.return_number, 'Return edited' || COALESCE(': ' || v_reason, ''), v_uid,
            v_before, v_before - (v_line.new_q - v_line.old_q), v_at);

    SELECT current_stock INTO v_before FROM products WHERE id = v_line.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + (v_line.new_q - v_line.old_q), updated_at = now()
     WHERE id = v_line.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                    quantity_before, quantity_after, created_at)
    VALUES (v_r.factory_id, v_line.product_id, 'return_from_rep', v_line.new_q - v_line.old_q, v_r.return_number,
            'Return edited' || COALESCE(': ' || v_reason, ''), v_uid,
            v_before, v_before + (v_line.new_q - v_line.old_q), v_at);
  END LOOP;

  IF v_removed THEN
    -- Nothing came back after all: the return goes (its jugs back to them
    -- through the status trigger, on its day).
    -- The trigger reverses every jug the return ever took in, including
    -- those an earlier edit already gave back; those are put back once more
    -- so the jugs net to nothing.
    SELECT COALESCE(array_agg(id), '{}') INTO v_prev_back FROM container_movements
     WHERE rep_return_id = p_id AND source = 'rep_return_cancelled';
    UPDATE rep_returns SET status = 'cancelled' WHERE id = p_id;
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                    source, reference, rep_return_id, created_by, product_id, created_at, notes)
    SELECT factory_id, container_type_id, to_type, to_id, from_type, from_id, quantity,
           'rep_return', reference, rep_return_id, v_uid, product_id, v_at, 'Return removed: an earlier edit''s jugs'
      FROM container_movements WHERE id = ANY (v_prev_back);
    PERFORM set_config('elim.redating', 'on', true);
    UPDATE container_movements SET created_at = v_at
     WHERE rep_return_id = p_id AND source = 'rep_return_cancelled' AND NOT (id = ANY (v_prev_back));
    PERFORM set_config('elim.redating', 'off', true);
  ELSE
    -- The lines take the new figures; jugs follow the difference.
    FOR v_line IN SELECT * FROM jsonb_to_recordset(v_diff) AS e(product_id uuid, old_q numeric, new_q numeric) WHERE e.new_q <> e.old_q LOOP
      IF v_line.old_q = 0 THEN
        SELECT unit_price INTO v_price FROM products WHERE id = v_line.product_id;
        -- Its jugs move through the line's insert trigger.
        INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price,
                                     accepted_quantity, damaged_quantity, rejected_quantity, charge_rep)
        VALUES (p_id, v_line.product_id, v_line.new_q, v_price, v_line.new_q, 0, 0, true);
      ELSE
        IF v_line.new_q > v_line.old_q THEN
          PERFORM public._container_move_for_product(v_r.factory_id, v_line.product_id, v_line.new_q - v_line.old_q,
            'sales_rep', v_r.sales_rep_id, 'warehouse', NULL, 'rep_return', v_r.return_number, NULL, NULL, p_id, NULL);
        ELSE
          PERFORM public._container_move_for_product(v_r.factory_id, v_line.product_id, v_line.old_q - v_line.new_q,
            'warehouse', NULL, 'sales_rep', v_r.sales_rep_id, 'rep_return_cancelled', v_r.return_number, NULL, NULL, p_id, NULL);
        END IF;
        IF v_line.new_q = 0 THEN
          DELETE FROM rep_return_items WHERE rep_return_id = p_id AND product_id = v_line.product_id;
        ELSE
          -- One line per product from here on.
          DELETE FROM rep_return_items WHERE rep_return_id = p_id AND product_id = v_line.product_id
             AND id <> (SELECT min(id::text)::uuid FROM rep_return_items
                         WHERE rep_return_id = p_id AND product_id = v_line.product_id);
          UPDATE rep_return_items
             SET quantity_returned = v_line.new_q,
                 accepted_quantity = CASE WHEN accepted_quantity IS NULL THEN NULL ELSE v_line.new_q END
           WHERE rep_return_id = p_id AND product_id = v_line.product_id;
        END IF;
      END IF;
    END LOOP;
    PERFORM set_config('elim.redating', 'on', true);
    UPDATE container_movements SET created_at = v_at
     WHERE rep_return_id = p_id AND created_at = now();  -- the moves this edit made
    PERFORM set_config('elim.redating', 'off', true);
    IF v_date <> v_r.return_date THEN PERFORM public._redate_rep_return(p_id, v_date); END IF;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_r.factory_id, CASE WHEN v_removed THEN 'remove_rep_return' ELSE 'edit_rep_return' END,
          'rep_returns', p_id::text,
          jsonb_build_object('return_number', v_r.return_number, 'return_date', v_r.return_date, 'items', v_old_items),
          jsonb_build_object('return_number', v_r.return_number, 'return_date', v_date,
                             'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', product_id,
                                                         'quantity_returned', new_q)), '[]'::jsonb)
                                         FROM jsonb_to_recordset(v_diff) AS e(product_id uuid, old_q numeric, new_q numeric) WHERE e.new_q > 0),
                             'reason', v_reason));
  RETURN jsonb_build_object('return_number', v_r.return_number, 'id', p_id, 'return_date', v_date,
                            'removed', v_removed);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_rep_return(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_rep_return(uuid, jsonb) TO authenticated;

-- As 20261103090000, without the required reason (the audit log keeps the
-- old and new date, and the reason when one is given).
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
