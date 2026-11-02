-- ============================================================================
-- Godwin: load-out and return of 30 Oct 2026
-- ----------------------------------------------------------------------------
-- User request (2026-11-02), from the WhatsApp message of 30/10/2026:
--   Load out 30/10/2026 -- Godwin             (2:30 pm)
--     1) 50cl 100, 75cl 150   2) 75cl 60   3) 75cl 200   4) 50cl 16
--   His return: 75cl 4, 50cl 16               (2:31 pm)
-- Recorded on 30 Oct as four postings (dispatches) and one return, at the
-- product's current price, on Godwin's account and van stock:
--   supplied 50cl 116, 75cl 410 · returned 50cl 16, 75cl 4
--   -> on his van: 50cl +100, 75cl +406
--
-- The Warehouse's stock is NOT changed. It was set to the old system's
-- 30 Oct balance and counted again for 31 Oct's opening (20261030180000,
-- 20261031100000), both of which already count these goods -- as for
-- Malla's 30 Oct posting (20261031140000). So no inventory_movements lines.
--
-- The return is linked to load-out 4 (carried_dispatch_id) so it is not
-- added again to Godwin's next posting (20261031150000 adds open returns
-- automatically); it already happened on 30 Oct. (Changed by
-- 20261102110000: the user wants it carried -- the link is taken off and
-- its goods put back in Warehouse stock.)
--
-- Recorded by: whoever last posted bottles to a marketer (the Warehouse
-- officer), else an admin -- rep_returns needs a person.
-- Stops, changing nothing, if Godwin or the 50cl / 75cl Bottle Water product
-- isn't found exactly once, or Godwin already has a posting or return dated
-- 30 Oct (so it can't be entered twice). Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._godwin_loadout_30oct()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := DATE '2026-10-30';
  v_at timestamptz := TIMESTAMP '2026-10-30 14:30:00' AT TIME ZONE 'Africa/Lagos';
  v_rep sales_reps%ROWTYPE;
  v_n int;
  v_50 products%ROWTYPE;
  v_75 products%ROWTYPE;
  v_user uuid;
  v_load record;
  v_line record;
  v_pid uuid;
  v_price numeric;
  v_before numeric;
  v_total numeric;
  v_number text;
  v_id uuid;
  v_last uuid;
  v_ret uuid;
  v_ret_number text;
  v_out jsonb := '[]'::jsonb;
BEGIN
  v_n := (SELECT count(*) FROM sales_reps WHERE kind = 'rep' AND full_name ~* '\mgodwin\M');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Found % marketers named Godwin -- nothing recorded', v_n;
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE kind = 'rep' AND full_name ~* '\mgodwin\M';

  v_n := (SELECT count(*) FROM products WHERE factory_id = v_rep.factory_id AND product_type = 'finished'
             AND active AND btrim(name) ~* '^50 ?cl bottle');
  IF v_n <> 1 THEN RAISE EXCEPTION 'Found % 50cl Bottle Water products -- nothing recorded', v_n; END IF;
  SELECT * INTO v_50 FROM products WHERE factory_id = v_rep.factory_id AND product_type = 'finished'
     AND active AND btrim(name) ~* '^50 ?cl bottle';
  v_n := (SELECT count(*) FROM products WHERE factory_id = v_rep.factory_id AND product_type = 'finished'
             AND active AND btrim(name) ~* '^75 ?cl bottle');
  IF v_n <> 1 THEN RAISE EXCEPTION 'Found % 75cl Bottle Water products -- nothing recorded', v_n; END IF;
  SELECT * INTO v_75 FROM products WHERE factory_id = v_rep.factory_id AND product_type = 'finished'
     AND active AND btrim(name) ~* '^75 ?cl bottle';

  IF EXISTS (SELECT 1 FROM stock_dispatches WHERE sales_rep_id = v_rep.id AND dispatch_date = v_date AND status <> 'reversed')
     OR EXISTS (SELECT 1 FROM rep_returns WHERE sales_rep_id = v_rep.id AND return_date = v_date AND status <> 'cancelled') THEN
    RAISE NOTICE '% already has a posting or return dated 30 Oct -- nothing recorded: %', v_rep.full_name,
      (SELECT string_agg(x, ', ') FROM (
         SELECT dispatch_number AS x FROM stock_dispatches WHERE sales_rep_id = v_rep.id AND dispatch_date = v_date AND status <> 'reversed'
         UNION ALL
         SELECT return_number FROM rep_returns WHERE sales_rep_id = v_rep.id AND return_date = v_date AND status <> 'cancelled') s);
    RETURN jsonb_build_object('skipped', 'Godwin already has a posting or return dated 30 Oct');
  END IF;

  v_user := COALESCE(
    (SELECT d.created_by FROM stock_dispatches d JOIN stock_dispatch_items i ON i.dispatch_id = d.id
      WHERE d.factory_id = v_rep.factory_id AND d.created_by IS NOT NULL AND i.product_id IN (v_50.id, v_75.id)
      ORDER BY d.created_at DESC LIMIT 1),
    (SELECT received_by FROM rep_returns WHERE factory_id = v_rep.factory_id ORDER BY created_at DESC LIMIT 1),
    (SELECT user_id FROM user_roles WHERE role IN ('super_admin', 'chairman') ORDER BY role DESC LIMIT 1));
  IF v_user IS NULL THEN RAISE EXCEPTION 'No Warehouse officer or admin to record it under -- nothing recorded'; END IF;

  -- ---- The four load-outs ----
  FOR v_load IN
    SELECT * FROM (VALUES (1, 150::numeric, 100::numeric), (2, 60, 0), (3, 200, 0), (4, 0, 16)) AS t(n, q75, q50)
     ORDER BY n
  LOOP
    v_number := 'DSP-20261030-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
    WHILE EXISTS (SELECT 1 FROM stock_dispatches WHERE dispatch_number = v_number) LOOP
      v_number := 'DSP-20261030-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
    END LOOP;
    v_total := v_load.q50 * v_50.unit_price + v_load.q75 * v_75.unit_price;
    INSERT INTO stock_dispatches(factory_id, dispatch_number, dispatch_date, sales_rep_id, total_value, notes,
                                 created_by, created_at)
    VALUES (v_rep.factory_id, v_number, v_date, v_rep.id, v_total,
            'Load out ' || v_load.n || ' of 30/10/2026 (WhatsApp message), recorded 2 Nov 2026. '
            || 'Warehouse stock not changed: already in the 30 Oct balance and 31 Oct count.',
            v_user, v_at + make_interval(secs => v_load.n))
    RETURNING id INTO v_id;
    v_last := v_id;

    FOR v_line IN SELECT * FROM (VALUES (v_50.id, v_load.q50, v_50.unit_price), (v_75.id, v_load.q75, v_75.unit_price)) AS l(pid, qty, price)
                   WHERE qty > 0
    LOOP
      INSERT INTO stock_dispatch_items(dispatch_id, product_id, quantity, unit_price, line_value)
      VALUES (v_id, v_line.pid, v_line.qty, v_line.price, v_line.qty * v_line.price);
      SELECT quantity INTO v_before FROM rep_stock WHERE sales_rep_id = v_rep.id AND product_id = v_line.pid FOR UPDATE;
      IF NOT FOUND THEN
        v_before := 0;
        INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity) VALUES (v_rep.id, v_line.pid, v_rep.factory_id, v_line.qty);
      ELSE
        UPDATE rep_stock SET quantity = quantity + v_line.qty, updated_at = now()
         WHERE sales_rep_id = v_rep.id AND product_id = v_line.pid;
      END IF;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                      user_id, quantity_before, quantity_after, created_at)
      VALUES (v_rep.factory_id, v_rep.id, v_line.pid, 'dispatch_in', v_line.qty, v_number, 'Stock dispatch (load out of 30 Oct)',
              v_user, v_before, v_before + v_line.qty, v_at + make_interval(secs => v_load.n));
    END LOOP;

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (NULL, v_rep.factory_id, 'create_stock_dispatch', 'stock_dispatch', v_id::text,
            jsonb_build_object('dispatch_number', v_number, 'sales_rep_id', v_rep.id, 'total_value', v_total,
                               'dispatch_date', v_date, 'recorded_for', v_user,
                               'note', 'Godwin load out of 30 Oct 2026, back-dated; Warehouse stock not changed'));
    v_out := v_out || jsonb_build_object('posting', v_number, '50cl', v_load.q50, '75cl', v_load.q75, 'value', v_total);
  END LOOP;

  -- ---- His return ----
  v_ret_number := 'RRN-20261030-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  WHILE EXISTS (SELECT 1 FROM rep_returns WHERE return_number = v_ret_number) LOOP
    v_ret_number := 'RRN-20261030-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  END LOOP;
  INSERT INTO rep_returns(factory_id, return_number, sales_rep_id, return_date, status, received_by, received_at,
                          inspected_by, inspected_at, notes, created_at, carried_dispatch_id)
  VALUES (v_rep.factory_id, v_ret_number, v_rep.id, v_date, 'received', v_user, v_at + interval '1 minute',
          NULL, NULL,
          'Return of 30/10/2026 (WhatsApp message), recorded 2 Nov 2026. Warehouse stock not changed: '
          || 'already in the 31 Oct count. Not carried onto a later posting.',
          v_at + interval '1 minute', v_last)
  RETURNING id INTO v_ret;
  FOR v_line IN SELECT * FROM (VALUES (v_75.id, 4::numeric, v_75.unit_price), (v_50.id, 16::numeric, v_50.unit_price)) AS l(pid, qty, price) LOOP
    INSERT INTO rep_return_items(rep_return_id, product_id, quantity_returned, unit_price,
                                 accepted_quantity, damaged_quantity, rejected_quantity, charge_rep)
    VALUES (v_ret, v_line.pid, v_line.qty, v_line.price, v_line.qty, 0, 0, true);
    SELECT quantity INTO v_before FROM rep_stock WHERE sales_rep_id = v_rep.id AND product_id = v_line.pid FOR UPDATE;
    UPDATE rep_stock SET quantity = quantity - v_line.qty, updated_at = now()
     WHERE sales_rep_id = v_rep.id AND product_id = v_line.pid;
    INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason,
                                    user_id, quantity_before, quantity_after, created_at)
    VALUES (v_rep.factory_id, v_rep.id, v_line.pid, 'returned_out', -v_line.qty, v_ret_number, 'Returned to Warehouse',
            v_user, v_before, v_before - v_line.qty, v_at + interval '1 minute');
  END LOOP;
  UPDATE rep_returns SET status = 'completed', inspected_by = v_user, inspected_at = v_at + interval '1 minute' WHERE id = v_ret;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (NULL, v_rep.factory_id, 'create_rep_return', 'rep_return', v_ret::text,
          jsonb_build_object('return_number', v_ret_number, 'sales_rep_id', v_rep.id, 'return_date', v_date,
                             'value', 4 * v_75.unit_price + 16 * v_50.unit_price, 'recorded_for', v_user,
                             'note', 'Godwin return of 30 Oct 2026, back-dated; Warehouse stock not changed'));

  RETURN jsonb_build_object('marketer', v_rep.full_name, 'postings', v_out,
                            'return', jsonb_build_object('number', v_ret_number, '75cl', 4, '50cl', 16),
                            'van_now', jsonb_build_object(
                              '50cl', (SELECT quantity FROM rep_stock WHERE sales_rep_id = v_rep.id AND product_id = v_50.id),
                              '75cl', (SELECT quantity FROM rep_stock WHERE sales_rep_id = v_rep.id AND product_id = v_75.id)));
END;
$$;
REVOKE ALL ON FUNCTION public._godwin_loadout_30oct() FROM PUBLIC, anon, authenticated;

-- Only where the factory is trading (a fresh test database is left alone).
SELECT CASE WHEN EXISTS (SELECT 1 FROM public.rep_stock_movements)
            THEN public._godwin_loadout_30oct()
            ELSE jsonb_build_object('skipped', 'no marketer postings yet') END AS result;
