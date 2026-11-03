-- ============================================================================
-- Retail Shop: end of day in one step; Accounts confirm the goods too
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "at the end of the day, a button she can just post all
-- her sales money to the Accountant ... enter the unsold as return, the
-- return goes back to the Warehouse, so that when the Warehouse is posting
-- to retail they see what was returned (as with marketers and
-- distributors), including damaged products. Then in the Accountant page
-- (Retail daily) the physical products are entered to confirm and reconcile
-- the account."
--
-- close_shop_day(payload) -- the shop, one press:
--   1. the unsold go back to the Warehouse (a completed return, as
--      return_shop_stock_to_warehouse: off the shop, into Warehouse stock;
--      the Warehouse's next posting to the shop lists it);
--   2. damaged products come off the shop's stock on the same return
--      (damaged_quantity, accepted 0) -- not into sellable Warehouse stock;
--   3. the day goes to Accounts (submit_outlet_day) with the money handed
--      over; what is left at the shop is the day's closing count.
--   payload: outlet_id, close_date (today if left out), declared_cash,
--            declared_other, notes, items: [{product_id, unsold, damaged}]
--   A difference between the money handed over and the day's takings needs a
--   note (as submit_outlet_day). Same right as submitting the day (sales
--   write); the day must still be open.
-- confirm_outlet_day_goods(p_id, cash, other, goods, notes) -- Accounts:
--   as confirm_outlet_day, plus the physical count of every product the shop
--   returned or wrote off that day (goods: [{product_id, counted}]); a count
--   that differs needs a note. Kept on outlet_day_reconciliations.accounts_goods.
-- ============================================================================

ALTER TABLE public.outlet_day_reconciliations ADD COLUMN IF NOT EXISTS accounts_goods jsonb;

CREATE OR REPLACE FUNCTION public.close_shop_day(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_outlet uuid := NULLIF(payload->>'outlet_id', '')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'close_date', '')::date, (now() AT TIME ZONE 'Africa/Lagos')::date);
  v_cash numeric := COALESCE(NULLIF(payload->>'declared_cash', '')::numeric, -1);
  v_other numeric := COALESCE(NULLIF(payload->>'declared_other', '')::numeric, -1);
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_items jsonb := COALESCE(payload->'items', '[]'::jsonb);
  v_rep sales_reps%ROWTYPE;
  v_line record;
  v_held numeric;
  v_before numeric;
  v_at timestamptz;
  v_number text;
  v_rid uuid;
  v_price numeric;
  v_fig jsonb;
  v_counts jsonb;
  v_sub jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = v_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail outlet not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_date > (now() AT TIME ZONE 'Africa/Lagos')::date THEN RAISE EXCEPTION 'A day in the future cannot be closed'; END IF;
  IF v_cash < 0 OR v_other < 0 THEN RAISE EXCEPTION 'Enter the cash and transfer/POS handed over (0 if none)'; END IF;
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'items must be a list'; END IF;
  IF EXISTS (SELECT 1 FROM outlet_day_reconciliations
              WHERE sales_rep_id = v_outlet AND close_date = v_date AND status IN ('submitted', 'confirmed')) THEN
    RAISE EXCEPTION '% is already with Accounts', to_char(v_date, 'DD Mon YYYY');
  END IF;
  v_at := CASE WHEN v_date >= (now() AT TIME ZONE 'Africa/Lagos')::date THEN now()
               ELSE (v_date + time '17:00') AT TIME ZONE 'Africa/Lagos' END;

  -- 1-2. Unsold and damaged back on one return.
  FOR v_line IN
    SELECT (i->>'product_id')::uuid AS product_id,
           SUM(GREATEST(COALESCE(NULLIF(i->>'unsold', '')::numeric, 0), 0)) AS unsold,
           SUM(GREATEST(COALESCE(NULLIF(i->>'damaged', '')::numeric, 0), 0)) AS damaged
      FROM jsonb_array_elements(v_items) i GROUP BY 1
  LOOP
    CONTINUE WHEN v_line.unsold + v_line.damaged = 0;
    SELECT quantity INTO v_held FROM rep_stock
     WHERE sales_rep_id = v_outlet AND product_id = v_line.product_id FOR UPDATE;
    IF COALESCE(v_held, 0) < v_line.unsold + v_line.damaged THEN
      RAISE EXCEPTION 'The shop holds only % of %', COALESCE(v_held, 0),
        (SELECT name FROM products WHERE id = v_line.product_id);
    END IF;
    IF v_rid IS NULL THEN
      v_number := 'RRN-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
      INSERT INTO rep_returns(factory_id, return_number, sales_rep_id, return_date, received_by, notes, received_at)
      VALUES (v_rep.factory_id, v_number, v_outlet, v_date, v_uid, 'End of day: unsold and damaged', v_at)
      RETURNING id INTO v_rid;
    END IF;
    SELECT unit_price INTO v_price FROM products WHERE id = v_line.product_id;
    -- The line's jugs go back with it (trigger on rep_return_items).
    INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price,
                                 accepted_quantity, damaged_quantity, rejected_quantity, charge_rep)
    VALUES (v_rid, v_line.product_id, v_line.unsold + v_line.damaged, v_price,
            v_line.unsold, v_line.damaged, 0, false);

    v_before := v_held;
    UPDATE rep_stock SET quantity = quantity - (v_line.unsold + v_line.damaged), updated_at = now()
     WHERE sales_rep_id = v_outlet AND product_id = v_line.product_id;
    IF v_line.unsold > 0 THEN
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                      user_id, quantity_before, quantity_after, created_at)
      VALUES (v_rep.factory_id, v_outlet, v_line.product_id, 'returned_out', -v_line.unsold, v_number,
              'Unsold, back to the Warehouse (end of day)', v_uid, v_before, v_before - v_line.unsold, v_at);
      v_before := v_before - v_line.unsold;
      -- Into Warehouse stock now: the next posting to the shop shows it.
      SELECT current_stock INTO v_held FROM products WHERE id = v_line.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock + v_line.unsold, updated_at = now() WHERE id = v_line.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after, created_at)
      VALUES (v_rep.factory_id, v_line.product_id, 'return_from_rep', v_line.unsold, v_number,
              'Returned by ' || v_rep.full_name || ' (unsold, end of day)', v_uid, v_held, v_held + v_line.unsold, v_at);
    END IF;
    IF v_line.damaged > 0 THEN
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                      user_id, quantity_before, quantity_after, created_at)
      VALUES (v_rep.factory_id, v_outlet, v_line.product_id, 'damaged_out', -v_line.damaged, v_number,
              'Damaged (end of day)', v_uid, v_before, v_before - v_line.damaged, v_at);
    END IF;
  END LOOP;
  IF v_rid IS NOT NULL THEN
    UPDATE rep_returns SET status = 'completed', inspected_by = v_uid, inspected_at = now() WHERE id = v_rid;
    PERFORM set_config('elim.redating', 'on', true);
    UPDATE container_movements SET created_at = v_at WHERE rep_return_id = v_rid;
    PERFORM set_config('elim.redating', 'off', true);
  END IF;

  -- 3. The day to Accounts; what is left at the shop is the closing count.
  v_fig := public._outlet_day_figures(v_outlet, v_date);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', x->>'product_id', 'counted', (x->>'closing')::numeric)), '[]'::jsonb)
    INTO v_counts FROM jsonb_array_elements(v_fig->'products') x;
  v_sub := public.submit_outlet_day(v_outlet, v_date, v_cash, v_other, v_counts, v_notes);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_rep.factory_id, 'close_shop_day', 'outlet_day_reconciliations', v_sub->>'id',
          jsonb_build_object('close_date', v_date, 'return_number', v_number, 'items', v_items,
                             'declared_cash', v_cash, 'declared_other', v_other));
  RETURN jsonb_build_object('reconciliation_id', v_sub->>'id', 'return_number', v_number,
                            'cash_expected', v_fig->'money'->'cash_expected',
                            'other_expected', v_fig->'money'->'other_expected');
END;
$$;
REVOKE ALL ON FUNCTION public.close_shop_day(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_shop_day(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_outlet_day_goods(
  p_id uuid, p_received_cash numeric, p_received_other numeric, p_goods jsonb, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row outlet_day_reconciliations%ROWTYPE;
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_goods jsonb;
  v_missing text;
  v_off boolean;
  v_res jsonb;
BEGIN
  IF NOT public._outlet_recon_is_accounts() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM outlet_day_reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation not found'; END IF;

  -- Every product the shop sent back or wrote off that day, counted.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', x->>'product_id', 'name', x->>'name', 'unit', x->>'unit',
           'returned', (x->>'returned')::numeric, 'damaged', (x->>'damaged')::numeric,
           'expected', (x->>'returned')::numeric + (x->>'damaged')::numeric,
           'counted', (SELECT (g->>'counted')::numeric FROM jsonb_array_elements(COALESCE(p_goods, '[]'::jsonb)) g
                        WHERE g->>'product_id' = x->>'product_id' LIMIT 1))
         ORDER BY x->>'name'), '[]'::jsonb)
    INTO v_goods
    FROM jsonb_array_elements(v_row.figures->'products') x
   WHERE (x->>'returned')::numeric + (x->>'damaged')::numeric > 0;
  SELECT string_agg(g->>'name', ', ') INTO v_missing FROM jsonb_array_elements(v_goods) g
   WHERE g->>'counted' IS NULL OR (g->>'counted')::numeric < 0;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Enter the physical count for: %', v_missing; END IF;
  SELECT bool_or((g->>'counted')::numeric <> (g->>'expected')::numeric) INTO v_off FROM jsonb_array_elements(v_goods) g;
  IF COALESCE(v_off, false) AND v_notes IS NULL THEN
    RAISE EXCEPTION 'The goods counted differ from what the shop sent back. Add a note before confirming.';
  END IF;

  v_res := public.confirm_outlet_day(p_id, p_received_cash, p_received_other, v_notes);
  UPDATE outlet_day_reconciliations SET accounts_goods = v_goods WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_outlet_day_goods', 'outlet_day_reconciliations', p_id::text,
          jsonb_build_object('close_date', v_row.close_date, 'goods', v_goods));
  RETURN v_res || jsonb_build_object('goods', v_goods);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_outlet_day_goods(uuid, numeric, numeric, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_outlet_day_goods(uuid, numeric, numeric, jsonb, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
