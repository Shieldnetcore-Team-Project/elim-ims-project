-- ============================================================================
-- Warehouse marks a marketer's Dispenser Water as Jug + Water sold
-- ----------------------------------------------------------------------------
-- User (2026-11-16): "when a product is posted like Dispenser Water, let say
-- 100 piece is being posted and 40 Jug + Water was sold, let there be where
-- warehouse can tick whether Jug + Water sold and 60 Empty Jug to return in
-- their return page and also accountant should see it like that".
--
-- set_rep_jug_water_sold(p_rep, p_product, p_day, p_quantity, p_note)
--   Sets how many of the Dispenser Water posted to the marketer on p_day
--   were sold as Jug + Water (the customer kept the jug). The SAME postings
--   change: that many move from the Dispenser Water line(s) to a Jug + Water
--   line (jar_mode 'permanent', jw_marked) at the line's own price plus the
--   jug price -- the price Rule A charges a jug not brought back. So the
--   marketer's balance does not move; it only reads "40 Jug + Water, 60
--   Dispenser Water with 60 empty jugs to return" instead of "100 jugs not
--   back". Setting a lower figure moves them back. No stock moves (one
--   filled stock, the van holds the same); the jug ledger doesn't move either
--   (a new line is entered without the posting's jug entry).
--   Up: never more than that day's Dispenser Water, nor more jugs than are
--   still out with them (Rule A: posted - unsold back - empties back).
--   Down: only what was marked here, and not below Jug + Water already
--   returned unsold.
--   Who: anyone who takes marketer returns (distribution submit) and handles
--   the product. Audit-logged.
-- rep_jug_water_day(p_rep, p_day)  per dispenser product that day: Dispenser
--   Water posted, Jug + Water posted as such, marked here, jugs still out.
-- rep_dispenser_breakdown: Jug + Water sold is now what was posted or marked
--   as Jug + Water (no longer guessed from the jugs not back); the Dispenser
--   Water's empty jugs are "returned" or "to return".
-- Paste the whole file into the Supabase SQL Editor. Safe to run again.
-- ============================================================================

ALTER TABLE public.stock_dispatch_items
  ADD COLUMN IF NOT EXISTS jw_marked boolean NOT NULL DEFAULT false;

-- A new line entered by set_rep_jug_water_sold carries no jug entry: its jugs
-- went out with the posting's original line.
CREATE OR REPLACE FUNCTION public._containers_on_dispatch_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_d stock_dispatches%ROWTYPE;
BEGIN
  IF current_setting('app.skip_jug_move', true) = 'on' THEN RETURN NEW; END IF;
  SELECT * INTO v_d FROM stock_dispatches WHERE id = NEW.dispatch_id;
  IF FOUND AND v_d.status = 'posted' THEN
    PERFORM public._container_move_for_product(v_d.factory_id, NEW.product_id, NEW.quantity,
      'warehouse', NULL, 'sales_rep', v_d.sales_rep_id, 'dispatch', v_d.dispatch_number, NULL, v_d.id, NULL, NULL);
  END IF;
  RETURN NEW;
END;
$$;

-- Jugs still out with a marketer under Rule A (as rep_account_summary,
-- all time): Dispenser Water posted - unsold returned - empties returned.
CREATE OR REPLACE FUNCTION public._rep_jugs_out(p_rep uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT GREATEST(COALESCE(SUM(q), 0), 0) FROM (
    SELECT sdi.quantity * pj.per_unit AS q
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_rep AND sd.status = 'posted' AND sdi.jar_mode IS NULL
       AND pj.name ~* 'jug|dispenser'
    UNION ALL
    SELECT -COALESCE(rri.accepted_quantity, 0) * pj.per_unit
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.sales_rep_id = p_rep AND rr.status = 'completed' AND rri.jar_mode IS NULL
       AND pj.name ~* 'jug|dispenser'
    UNION ALL
    SELECT -m.quantity
      FROM container_movements m
      JOIN container_types ct ON ct.id = m.container_type_id
     WHERE m.from_type = 'sales_rep' AND m.from_id = p_rep AND m.source = 'return'
       AND ct.name ~* 'jug|dispenser'
  ) x;
$fn$;
REVOKE ALL ON FUNCTION public._rep_jugs_out(uuid) FROM PUBLIC, anon, authenticated;

-- The jug's price per dispenser, as Rule A charges it (Empty Jug on Costing,
-- else the jug type's price).
CREATE OR REPLACE FUNCTION public._dispenser_jug_price(p_product uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE(e.unit_price, ct.jar_price, 0) * pj.per_unit
    FROM public._product_jug(p_product) pj
    JOIN container_types ct ON ct.id = pj.container_type_id
    LEFT JOIN LATERAL public._jug_empty_product(ct.id, ct.factory_id) e ON true
   LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public._dispenser_jug_price(uuid) FROM PUBLIC, anon, authenticated;

-- A line entered without its jug entry (see the trigger above).
CREATE OR REPLACE FUNCTION public._insert_dispatch_line_no_jugs(
  p_dispatch uuid, p_product uuid, p_qty numeric, p_price numeric, p_discount numeric,
  p_mode text, p_marked boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  PERFORM set_config('app.skip_jug_move', 'on', true);
  INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, unit_discount, line_value,
                                   jar_mode, jw_marked)
  VALUES (p_dispatch, p_product, p_qty, p_price, COALESCE(p_discount, 0),
          round(p_qty * GREATEST(p_price - COALESCE(p_discount, 0), 0), 2), p_mode, p_marked);
  PERFORM set_config('app.skip_jug_move', 'off', true);
END;
$fn$;
REVOKE ALL ON FUNCTION public._insert_dispatch_line_no_jugs(uuid, uuid, numeric, numeric, numeric, text, boolean)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_rep_jug_water_sold(
  p_rep uuid, p_product uuid, p_day date, p_quantity numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_rep sales_reps%ROWTYPE;
  v_name text;
  v_per numeric;
  v_jp numeric;
  v_now numeric;
  v_d numeric;
  v_left numeric;
  v_take numeric;
  v_avail numeric;
  v_out numeric;
  v_held numeric;
  v_price numeric;
  v_l record;
  v_t stock_dispatch_items%ROWTYPE;
  v_dispatches uuid[] := '{}';
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_rep FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_rep.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  v_name := (SELECT name FROM products WHERE id = p_product);
  IF v_name IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF NOT public._user_may_handle_product(v_uid, p_product) THEN
    RAISE EXCEPTION '% is not one of your products -- it is handled by another Warehouse officer', v_name;
  END IF;
  IF NOT public._is_supply_dispenser(p_product) THEN
    RAISE EXCEPTION '% isn''t a dispenser -- only Dispenser Water can be sold as Jug + Water', v_name;
  END IF;
  IF p_day IS NULL THEN RAISE EXCEPTION 'Pick the posting day'; END IF;
  IF p_quantity IS NULL OR p_quantity < 0 OR p_quantity <> trunc(p_quantity) THEN
    RAISE EXCEPTION 'Enter how many were sold as Jug + Water (a whole number, 0 or more)';
  END IF;
  v_per := COALESCE((SELECT per_unit FROM public._product_jug(p_product) LIMIT 1), 1);
  v_jp := public._dispenser_jug_price(p_product);
  IF COALESCE(v_jp, 0) <= 0 THEN
    RAISE EXCEPTION 'Set the Empty Jug price first (Costing → Product Prices)';
  END IF;

  v_now := COALESCE((SELECT SUM(i.quantity) FROM stock_dispatch_items i
                       JOIN stock_dispatches d ON d.id = i.dispatch_id
                      WHERE d.sales_rep_id = p_rep AND d.status = 'posted' AND d.dispatch_date = p_day
                        AND i.product_id = p_product AND i.jw_marked), 0);
  v_d := p_quantity - v_now;
  IF v_d = 0 THEN
    RETURN jsonb_build_object('changed', 0, 'jug_water', v_now);
  END IF;

  IF v_d > 0 THEN
    v_avail := COALESCE((SELECT SUM(i.quantity) FROM stock_dispatch_items i
                           JOIN stock_dispatches d ON d.id = i.dispatch_id
                          WHERE d.sales_rep_id = p_rep AND d.status = 'posted' AND d.dispatch_date = p_day
                            AND i.product_id = p_product AND i.jar_mode IS NULL), 0);
    IF v_d > v_avail THEN
      RAISE EXCEPTION 'Only % % was posted to % on % (% already Jug + Water)',
        trim_scale(v_avail + v_now), v_name, v_rep.full_name, to_char(p_day, 'DD Mon YYYY'), trim_scale(v_now);
    END IF;
    v_out := public._rep_jugs_out(p_rep);
    IF v_d * v_per > v_out THEN
      RAISE EXCEPTION 'Only % jug(s) are still out with % -- the rest came back as empties or unsold',
        trim_scale(v_out), v_rep.full_name;
    END IF;

    v_left := v_d;
    FOR v_l IN
      SELECT i.*, d.created_at AS d_created
        FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
       WHERE d.sales_rep_id = p_rep AND d.status = 'posted' AND d.dispatch_date = p_day
         AND i.product_id = p_product AND i.jar_mode IS NULL
       ORDER BY d.created_at DESC, i.id
       FOR UPDATE OF i
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_l.quantity, v_left);
      v_price := v_l.unit_price + v_jp;
      SELECT * INTO v_t FROM stock_dispatch_items
       WHERE dispatch_id = v_l.dispatch_id AND product_id = p_product AND jw_marked
         AND unit_price = v_price AND unit_discount = v_l.unit_discount
       ORDER BY id LIMIT 1 FOR UPDATE;
      IF FOUND THEN
        UPDATE stock_dispatch_items
           SET quantity = quantity + v_take,
               line_value = round((quantity + v_take) * GREATEST(unit_price - unit_discount, 0), 2)
         WHERE id = v_t.id;
      ELSIF v_take = v_l.quantity THEN
        -- The whole line becomes Jug + Water: change it in place.
        UPDATE stock_dispatch_items
           SET jar_mode = 'permanent', jw_marked = true, unit_price = v_price,
               line_value = round(quantity * GREATEST(v_price - unit_discount, 0), 2)
         WHERE id = v_l.id;
      ELSE
        PERFORM public._insert_dispatch_line_no_jugs(v_l.dispatch_id, p_product, v_take, v_price,
                                                     v_l.unit_discount, 'permanent', true);
      END IF;
      IF NOT (v_take = v_l.quantity AND v_t.id IS NULL) THEN
        IF v_take = v_l.quantity THEN
          DELETE FROM stock_dispatch_items WHERE id = v_l.id;
        ELSE
          UPDATE stock_dispatch_items
             SET quantity = quantity - v_take,
                 line_value = round((quantity - v_take) * GREATEST(unit_price - unit_discount, 0), 2)
           WHERE id = v_l.id;
        END IF;
      END IF;
      v_t := NULL;
      v_dispatches := v_dispatches || v_l.dispatch_id;
      v_left := v_left - v_take;
    END LOOP;

  ELSE
    -- Back to Dispenser Water: only what was marked here.
    v_held := public._rep_jug_water_held(p_rep, p_product);
    IF -v_d > v_held THEN
      RAISE EXCEPTION 'Only % can go back to Dispenser Water -- the rest of the Jug + Water was returned unsold',
        trim_scale(v_held);
    END IF;
    v_left := -v_d;
    FOR v_l IN
      SELECT i.*, d.created_at AS d_created
        FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
       WHERE d.sales_rep_id = p_rep AND d.status = 'posted' AND d.dispatch_date = p_day
         AND i.product_id = p_product AND i.jw_marked
       ORDER BY d.created_at DESC, i.id
       FOR UPDATE OF i
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_l.quantity, v_left);
      v_price := v_l.unit_price - v_jp;
      IF v_price < 0 THEN v_price := 0; END IF;
      SELECT * INTO v_t FROM stock_dispatch_items
       WHERE dispatch_id = v_l.dispatch_id AND product_id = p_product AND jar_mode IS NULL
         AND unit_price = v_price AND unit_discount = v_l.unit_discount
       ORDER BY id LIMIT 1 FOR UPDATE;
      IF FOUND THEN
        UPDATE stock_dispatch_items
           SET quantity = quantity + v_take,
               line_value = round((quantity + v_take) * GREATEST(unit_price - unit_discount, 0), 2)
         WHERE id = v_t.id;
      ELSIF v_take = v_l.quantity THEN
        UPDATE stock_dispatch_items
           SET jar_mode = NULL, jw_marked = false, unit_price = v_price,
               line_value = round(quantity * GREATEST(v_price - unit_discount, 0), 2)
         WHERE id = v_l.id;
      ELSE
        PERFORM public._insert_dispatch_line_no_jugs(v_l.dispatch_id, p_product, v_take, v_price,
                                                     v_l.unit_discount, NULL, false);
      END IF;
      IF NOT (v_take = v_l.quantity AND v_t.id IS NULL) THEN
        IF v_take = v_l.quantity THEN
          DELETE FROM stock_dispatch_items WHERE id = v_l.id;
        ELSE
          UPDATE stock_dispatch_items
             SET quantity = quantity - v_take,
                 line_value = round((quantity - v_take) * GREATEST(unit_price - unit_discount, 0), 2)
           WHERE id = v_l.id;
        END IF;
      END IF;
      v_t := NULL;
      v_dispatches := v_dispatches || v_l.dispatch_id;
      v_left := v_left - v_take;
    END LOOP;
  END IF;

  UPDATE stock_dispatches d
     SET total_value = (SELECT COALESCE(SUM(line_value), 0) FROM stock_dispatch_items WHERE dispatch_id = d.id)
   WHERE d.id = ANY (v_dispatches);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_rep.factory_id, 'set_rep_jug_water_sold', 'sales_reps', p_rep::text,
          jsonb_build_object('product', v_name, 'day', p_day, 'jug_water', v_now),
          jsonb_build_object('product', v_name, 'day', p_day, 'jug_water', p_quantity,
                             'jug_price', v_jp, 'postings', to_jsonb(v_dispatches),
                             'note', NULLIF(btrim(COALESCE(p_note, '')), '')));
  RETURN jsonb_build_object('changed', v_d, 'jug_water', p_quantity);
END;
$fn$;
REVOKE ALL ON FUNCTION public.set_rep_jug_water_sold(uuid, uuid, date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_rep_jug_water_sold(uuid, uuid, date, numeric, text) TO authenticated;

-- The return form's figures for one posting day.
CREATE OR REPLACE FUNCTION public.rep_jug_water_day(p_rep uuid, p_day date)
RETURNS TABLE(product_id uuid, product_name text, water_posted numeric, jw_posted numeric,
              jw_marked numeric, jugs_out numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT i.product_id, p.name,
         COALESCE(SUM(i.quantity) FILTER (WHERE i.jar_mode IS NULL), 0),
         COALESCE(SUM(i.quantity) FILTER (WHERE i.jar_mode = 'permanent' AND NOT i.jw_marked), 0),
         COALESCE(SUM(i.quantity) FILTER (WHERE i.jw_marked), 0),
         public._rep_jugs_out(p_rep)
    FROM stock_dispatch_items i
    JOIN stock_dispatches d ON d.id = i.dispatch_id
    JOIN products p ON p.id = i.product_id
   WHERE d.sales_rep_id = p_rep AND d.status = 'posted' AND d.dispatch_date = p_day
     AND public._works_in_factory(auth.uid(), d.factory_id)
     AND public._is_supply_dispenser(i.product_id)
   GROUP BY i.product_id, p.name
   ORDER BY p.name;
END;
$fn$;
REVOKE ALL ON FUNCTION public.rep_jug_water_day(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_jug_water_day(uuid, date) TO authenticated;

-- Accounts' Dispensers card: Jug + Water as posted or marked by the
-- Warehouse; the Dispenser Water's empties returned / still to return.
CREATE OR REPLACE FUNCTION public.rep_dispenser_breakdown(p_rep uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_posted numeric;
  v_unsold numeric;
  v_jw_posted numeric;
  v_jw_marked numeric;
  v_jw_back numeric;
  v_empties numeric;
  v_on_van numeric;
  v_water_sold numeric;
  v_to_return numeric;
  v_jw_sold numeric;
  v_water_price numeric;
  v_jug_price numeric;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  v_posted := COALESCE((
    SELECT sum(sdi.quantity * pj.per_unit)
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_rep AND sd.status = 'posted' AND sdi.jar_mode IS NULL
       AND (p_from IS NULL OR sd.dispatch_date >= p_from)
       AND (p_to   IS NULL OR sd.dispatch_date <= p_to)), 0);
  v_jw_posted := COALESCE((
    SELECT sum(sdi.quantity * pj.per_unit)
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_rep AND sd.status = 'posted' AND sdi.jar_mode = 'permanent'
       AND (p_from IS NULL OR sd.dispatch_date >= p_from)
       AND (p_to   IS NULL OR sd.dispatch_date <= p_to)), 0);
  v_jw_marked := COALESCE((
    SELECT sum(sdi.quantity * pj.per_unit)
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_rep AND sd.status = 'posted' AND sdi.jw_marked
       AND (p_from IS NULL OR sd.dispatch_date >= p_from)
       AND (p_to   IS NULL OR sd.dispatch_date <= p_to)), 0);
  v_unsold := COALESCE((
    SELECT sum(COALESCE(rri.accepted_quantity, 0) * pj.per_unit)
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.sales_rep_id = p_rep AND rr.status = 'completed' AND rri.jar_mode IS NULL
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_to   IS NULL OR rr.return_date <= p_to)), 0);
  v_jw_back := COALESCE((
    SELECT sum(COALESCE(rri.accepted_quantity, 0) * pj.per_unit)
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.sales_rep_id = p_rep AND rr.status = 'completed' AND rri.jar_mode = 'permanent'
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_to   IS NULL OR rr.return_date <= p_to)), 0);
  v_empties := COALESCE((
    SELECT sum(m.quantity)
      FROM container_movements m
      JOIN container_types ct ON ct.id = m.container_type_id
     WHERE m.from_type = 'sales_rep' AND m.from_id = p_rep AND m.source = 'return'
       AND ct.name ~* 'jug|dispenser'
       AND (p_from IS NULL OR public._jug_day(m.created_at) >= p_from)
       AND (p_to   IS NULL OR public._jug_day(m.created_at) <= p_to)), 0);
  -- Dispenser Water still on the van (a hint only).
  v_on_van := COALESCE((
    SELECT sum(rs.quantity * pj.per_unit)
      FROM rep_stock rs
      CROSS JOIN LATERAL public._product_jug(rs.product_id) pj
     WHERE rs.sales_rep_id = p_rep), 0);
  v_on_van := LEAST(v_on_van, GREATEST(v_posted - v_unsold, 0));

  v_jw_sold := GREATEST(v_jw_posted - v_jw_back, 0);
  v_water_sold := LEAST(v_empties, GREATEST(v_posted - v_unsold, 0));
  v_to_return := GREATEST(v_posted - v_unsold - v_empties, 0);

  SELECT p.unit_price / NULLIF(pj.per_unit, 0), public._dispenser_jug_price(p.id) / NULLIF(pj.per_unit, 0)
    INTO v_water_price, v_jug_price
    FROM stock_dispatch_items sdi
    JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
    JOIN products p ON p.id = sdi.product_id
    CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
   WHERE sd.sales_rep_id = p_rep
   ORDER BY sd.dispatch_date DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'posted', v_posted,
    'unsold_back', v_unsold,
    'on_van', v_on_van,
    'sold', v_water_sold + v_jw_sold,
    'empties_back', v_empties,
    'jug_water_sold', v_jw_sold,
    'water_sold', v_water_sold,
    'empties_to_return', v_to_return,
    'jw_posted', v_jw_posted,
    'jw_marked', v_jw_marked,
    'jw_back', v_jw_back,
    'water_price', v_water_price,
    'jug_price', v_jug_price,
    'jug_water_price', COALESCE(v_water_price, 0) + COALESCE(v_jug_price, 0));
END;
$fn$;
REVOKE ALL ON FUNCTION public.rep_dispenser_breakdown(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_dispenser_breakdown(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
