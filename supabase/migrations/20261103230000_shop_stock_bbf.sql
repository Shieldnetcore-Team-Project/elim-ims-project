-- ============================================================================
-- The Retail Shop's stock brought forward from the old system (3 Nov 2026)
-- ----------------------------------------------------------------------------
-- User (2026-11-03): balance the shop's stock with the old system -- 50cl 26,
-- 75cl 47, 1.5Ltr 20, Dispenser 3, Sachet 7 -- and nothing else (35cl and the
-- rest to 0).
--
--   _set_shop_stock_bbf(outlet, lines)   lines: [{match, quantity}], match an
--                     ILIKE pattern naming exactly one active finished
--                     product; the shop's stock is set to the quantity by one
--                     'adjustment' move (reason "Balance brought forward from
--                     the old system"), so rep_stock and its ledger agree and
--                     the day's figures show it under corrections. A product
--                     already at its figure is left alone, so running again
--                     changes nothing. With p_zero_rest every other product
--                     the shop holds is set to 0 the same way (the list is the
--                     whole shop).
--   Run once for the one active Retail Outlet; a database without one (a test
--   database) is skipped.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._set_shop_stock_bbf(p_outlet uuid, p_lines jsonb, p_zero_rest boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_line jsonb;
  v_qty numeric;
  v_n int;
  v_p products%ROWTYPE;
  v_before numeric;
  v_ref text := 'BBF-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD');
  v_done jsonb := '[]'::jsonb;
  v_listed uuid[] := '{}';
  v_rest record;
BEGIN
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail outlet not found'; END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_qty := (v_line->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty < 0 THEN RAISE EXCEPTION 'Bad quantity for %', v_line->>'match'; END IF;
    SELECT count(*) INTO v_n FROM products
     WHERE factory_id = v_rep.factory_id AND active AND product_type::text = 'finished'
       AND name ILIKE (v_line->>'match');
    IF v_n <> 1 THEN
      RAISE EXCEPTION '"%" names % products (%)', v_line->>'match', v_n,
        (SELECT string_agg(name, ', ') FROM products WHERE factory_id = v_rep.factory_id AND active
            AND product_type::text = 'finished' AND name ILIKE (v_line->>'match'));
    END IF;
    SELECT * INTO v_p FROM products
     WHERE factory_id = v_rep.factory_id AND active AND product_type::text = 'finished'
       AND name ILIKE (v_line->>'match');

    v_listed := v_listed || v_p.id;
    SELECT quantity INTO v_before FROM rep_stock WHERE sales_rep_id = p_outlet AND product_id = v_p.id FOR UPDATE;
    IF NOT FOUND THEN
      v_before := 0;
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity) VALUES (p_outlet, v_p.id, v_rep.factory_id, 0);
    END IF;
    IF v_before = v_qty THEN CONTINUE; END IF;

    UPDATE rep_stock SET quantity = v_qty, updated_at = now() WHERE sales_rep_id = p_outlet AND product_id = v_p.id;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                    user_id, quantity_before, quantity_after)
    VALUES (v_rep.factory_id, p_outlet, v_p.id, 'adjustment', v_qty - v_before, v_ref,
            'Balance brought forward from the old system', auth.uid(), v_before, v_qty);
    v_done := v_done || jsonb_build_object('product', v_p.name, 'before', v_before, 'after', v_qty);
  END LOOP;

  IF p_zero_rest THEN
    FOR v_rest IN SELECT rs.product_id, rs.quantity, p.name FROM rep_stock rs JOIN products p ON p.id = rs.product_id
                   WHERE rs.sales_rep_id = p_outlet AND rs.quantity <> 0 AND rs.product_id <> ALL (v_listed)
                   FOR UPDATE OF rs LOOP
      UPDATE rep_stock SET quantity = 0, updated_at = now() WHERE sales_rep_id = p_outlet AND product_id = v_rest.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                      user_id, quantity_before, quantity_after)
      VALUES (v_rep.factory_id, p_outlet, v_rest.product_id, 'adjustment', -v_rest.quantity, v_ref,
              'Balance brought forward from the old system', auth.uid(), v_rest.quantity, 0);
      v_done := v_done || jsonb_build_object('product', v_rest.name, 'before', v_rest.quantity, 'after', 0);
    END LOOP;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_rep.factory_id, 'shop_stock_bbf', 'sales_reps', p_outlet::text,
          jsonb_build_object('reference', v_ref, 'lines', v_done));
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION public._set_shop_stock_bbf(uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_outlet uuid; v_n int;
BEGIN
  SELECT count(*), min(id::text)::uuid INTO v_n, v_outlet FROM sales_reps WHERE kind = 'outlet' AND status = 'active';
  IF v_n <> 1 THEN
    RAISE NOTICE 'Shop stock b/f skipped: % active retail outlets', v_n;
    RETURN;
  END IF;
  -- A test database's seeded outlet, without the factory's products.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['50cl%', '75cl%', '1.5%', 'Dispenser Water%', 'Sachet%']) m
              WHERE NOT EXISTS (SELECT 1 FROM products p JOIN sales_reps r ON r.factory_id = p.factory_id
                                 WHERE r.id = v_outlet AND p.active AND p.name ILIKE m)) THEN
    RAISE NOTICE 'Shop stock b/f skipped: the outlet''s factory lacks one of the products';
    RETURN;
  END IF;
  RAISE NOTICE 'Shop stock b/f: %', public._set_shop_stock_bbf(v_outlet, jsonb_build_array(
    jsonb_build_object('match', '50cl%', 'quantity', 26),
    jsonb_build_object('match', '75cl%', 'quantity', 47),
    jsonb_build_object('match', '1.5%', 'quantity', 20),
    jsonb_build_object('match', 'Dispenser Water%', 'quantity', 3),
    jsonb_build_object('match', 'Sachet%', 'quantity', 7)), true);
END $$;
