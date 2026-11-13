-- ============================================================================
-- H MEDIX 12 Nov: 440 Dispenser Water supplied, 19 returned -> 421
-- ----------------------------------------------------------------------------
-- User (2026-11-13): H MEDIX's 12 Nov supply reads Dispenser Water 440 +
-- Jug + Water 19 = 459. In fact 440 went out and 19 came back: "the 19
-- piece returned should be deducted from the 440, not added to the 440, so
-- that it will now give us 421."
--
-- So the 19 keyed in as a Jug + Water supply line is taken off, and 19 is
-- taken off the 440 Dispenser Water line, leaving 421. Each 12 Nov posting
-- concerned is corrected the way the Warehouse's Correct (pencil) does it --
-- correct_warehouse_posting: the old posting is reversed (goods back into
-- Warehouse stock, its debt removed, anything paid on it kept as H MEDIX's
-- credit) and reposted at once with the same lines, prices and date, less
-- those figures. A posting left with no lines is just reversed.
-- Result: 38 dispensers back in Warehouse stock (the 19 never sent as Jug +
-- Water, and the 19 returned), 12 Nov supplied 421, the account down by
-- 19 x Jug + Water price + 19 x Dispenser Water price. The corrected
-- posting(s) get new invoice numbers and go to Accounts to confirm.
--
-- Guard: it only runs if H MEDIX's 12 Nov reads exactly Jug + Water 19 and
-- Dispenser Water 440 of the same product; anything else changes nothing
-- and lists what is there. Safe to run again (the second run finds it done).
-- ============================================================================

DO $$
DECLARE
  v_cust customers%ROWTYPE;
  v_uid uuid := auth.uid();
  v_prod uuid;
  v_jug_qty numeric;
  v_water_qty numeric;
  v_cut numeric := 19;          -- what came back, off the Dispenser Water lines
  v_take numeric;
  v_found text;
  v_sale record;
  v_line record;
  v_items jsonb;
  v_changed boolean;
  v_new jsonb;
  v_done text := '';
  v_after numeric;
  v_reason text := '19 returned on 12 Nov was keyed in as a Jug + Water supply -- 440 supplied less 19 returned = 421';
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE entity = 'customers' AND entity_id = 'hmedix-19-returned-12nov') THEN
    RAISE NOTICE 'Already done -- nothing to change';
    RETURN;
  END IF;

  IF (SELECT count(*) FROM customers
       WHERE regexp_replace(lower(name), '[^a-z]', '', 'g') = 'hmedix' AND removed_at IS NULL) <> 1 THEN
    RAISE NOTICE 'Not exactly one customer named H MEDIX here -- nothing changed';
    RETURN;
  END IF;
  SELECT * INTO v_cust FROM customers
   WHERE regexp_replace(lower(name), '[^a-z]', '', 'g') = 'hmedix' AND removed_at IS NULL;

  -- What H MEDIX was posted on 12 Nov, line by line.
  v_found := (SELECT string_agg(s.invoice_number || ': ' || public._sale_line_name(p.name, si.jar_mode)
                                 || ' ' || si.quantity::text || ' @ ' || si.unit_price::text, '; '
                                 ORDER BY s.created_at, p.name)
                FROM sales s JOIN sale_items si ON si.sale_id = s.id JOIN products p ON p.id = si.product_id
               WHERE s.customer_id = v_cust.id AND s.sale_date::date = '2026-11-12'
                 AND s.status = 'posted' AND s.deleted_at IS NULL);

  v_jug_qty := (SELECT COALESCE(sum(si.quantity), 0)
                  FROM sales s JOIN sale_items si ON si.sale_id = s.id
                 WHERE s.customer_id = v_cust.id AND s.sale_date::date = '2026-11-12'
                   AND s.status = 'posted' AND s.deleted_at IS NULL AND si.jar_mode = 'permanent');
  IF v_jug_qty = 0 THEN
    RAISE NOTICE 'H MEDIX has no Jug + Water on 12 Nov here -- nothing changed';
    RETURN;
  END IF;
  IF (SELECT count(DISTINCT si.product_id)
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
       WHERE s.customer_id = v_cust.id AND s.sale_date::date = '2026-11-12'
         AND s.status = 'posted' AND s.deleted_at IS NULL AND si.jar_mode = 'permanent') <> 1 THEN
    RAISE EXCEPTION 'H MEDIX''s 12 Nov Jug + Water is on more than one product -- nothing changed. 12 Nov lines: %', v_found;
  END IF;
  v_prod := (SELECT si.product_id
               FROM sales s JOIN sale_items si ON si.sale_id = s.id
              WHERE s.customer_id = v_cust.id AND s.sale_date::date = '2026-11-12'
                AND s.status = 'posted' AND s.deleted_at IS NULL AND si.jar_mode = 'permanent' LIMIT 1);
  v_water_qty := (SELECT COALESCE(sum(si.quantity), 0)
                    FROM sales s JOIN sale_items si ON si.sale_id = s.id
                   WHERE s.customer_id = v_cust.id AND s.sale_date::date = '2026-11-12'
                     AND s.status = 'posted' AND s.deleted_at IS NULL
                     AND si.product_id = v_prod AND si.jar_mode IS DISTINCT FROM 'permanent');
  IF v_jug_qty <> 19 OR v_water_qty <> 440 THEN
    RAISE EXCEPTION 'H MEDIX 12 Nov reads Jug + Water % and Dispenser Water %, not 19 and 440 -- nothing changed. 12 Nov lines: %',
      v_jug_qty, v_water_qty, v_found;
  END IF;

  -- The SQL Editor has no signed-in user: act as an Admin so the correction's
  -- own checks (and its audit rows) work.
  IF v_uid IS NULL THEN
    v_uid := (SELECT ur.user_id FROM user_roles ur
               WHERE ur.role = 'super_admin' AND public._works_in_factory(ur.user_id, v_cust.factory_id)
               ORDER BY ur.user_id LIMIT 1);
    IF v_uid IS NULL THEN RAISE EXCEPTION 'No Admin account found to record this under -- nothing changed'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  END IF;

  -- Postings with the Jug + Water line first, so the 19 comes off the same
  -- invoice where it can.
  FOR v_sale IN
    SELECT s.id, s.invoice_number, s.discount
      FROM sales s
     WHERE s.customer_id = v_cust.id AND s.sale_date::date = '2026-11-12'
       AND s.status = 'posted' AND s.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.product_id = v_prod)
     ORDER BY EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.jar_mode = 'permanent') DESC,
              s.created_at
  LOOP
    v_items := '[]'::jsonb;
    v_changed := false;
    FOR v_line IN
      SELECT si.product_id, si.quantity, si.unit_price, si.jar_mode
        FROM sale_items si WHERE si.sale_id = v_sale.id
       ORDER BY (si.product_id = v_prod AND si.jar_mode IS DISTINCT FROM 'permanent') DESC, si.quantity DESC, si.id
    LOOP
      IF v_line.jar_mode = 'permanent' THEN
        v_changed := true;                       -- the Jug + Water line goes
        CONTINUE;
      END IF;
      v_take := 0;
      IF v_line.product_id = v_prod AND v_cut > 0 THEN
        v_take := LEAST(v_cut, v_line.quantity);
        v_cut := v_cut - v_take;
        v_changed := true;
      END IF;
      CONTINUE WHEN v_line.quantity - v_take <= 0;
      v_items := v_items || (jsonb_build_object('product_id', v_line.product_id,
                                                'quantity', v_line.quantity - v_take,
                                                'unit_price', v_line.unit_price)
                             || CASE WHEN v_line.jar_mode IS NOT NULL
                                     THEN jsonb_build_object('jar_mode', v_line.jar_mode) ELSE '{}'::jsonb END);
    END LOOP;
    CONTINUE WHEN NOT v_changed;
    IF jsonb_array_length(v_items) = 0 THEN
      PERFORM public._reverse_posted_sale(v_sale.id, 'Removed: ' || v_reason);
      v_done := v_done || v_sale.invoice_number || ' reversed; ';
    ELSE
      v_new := public.correct_warehouse_posting(v_sale.id, jsonb_build_object(
                 'reason', v_reason, 'discount', v_sale.discount,
                 'sale_date', '2026-11-12', 'items', v_items));
      v_done := v_done || v_sale.invoice_number || ' -> ' || COALESCE(v_new->>'invoice_number', '?') || '; ';
    END IF;
  END LOOP;
  IF v_cut > 0 THEN RAISE EXCEPTION 'Could only take % of the 19 off -- nothing changed', 19 - v_cut; END IF;

  v_after := (SELECT COALESCE(sum(si.quantity), 0)
                FROM sales s JOIN sale_items si ON si.sale_id = s.id
               WHERE s.customer_id = v_cust.id AND s.sale_date::date = '2026-11-12'
                 AND s.status = 'posted' AND s.deleted_at IS NULL AND si.product_id = v_prod);
  IF v_after <> 421 THEN
    RAISE EXCEPTION '12 Nov would read % dispensers, not 421 -- nothing changed', v_after;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_cust.factory_id, 'correct_warehouse_posting', 'customers', 'hmedix-19-returned-12nov',
          jsonb_build_object('customer', v_cust.name, 'lines_12nov', v_found, 'dispensers_12nov', v_jug_qty + v_water_qty),
          jsonb_build_object('reason', v_reason, 'done', v_done, 'dispensers_12nov', v_after));

  RAISE NOTICE 'H MEDIX 12 Nov dispensers: % -> %. %', v_jug_qty + v_water_qty, v_after, v_done;
END $$;
