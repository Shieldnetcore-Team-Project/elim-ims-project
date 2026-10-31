-- ============================================================================
-- Warehouse opening balances, 31 Oct 2026: 75cl 13,277 Pack, 1.5Ltr 498 Pack
-- ----------------------------------------------------------------------------
-- The user (2026-10-31), from the Products Report for 31 Oct: the Opening
-- this morning is 75cl Bottle Water 13,277 (the report showed 14,080) and
-- 1.5Ltr Bottle Water 498 (it showed 0).
--
-- 31 Oct's Opening is the stock less everything recorded from 31 Oct on, so
-- each difference is posted as 'adjusted' stock lines at the very end of
-- 30 Oct: 31 Oct opens at the new figure, and what was done today (75cl: 10
-- out) still counts on top -- the stock moves by the same difference. The
-- 30 Oct row is the old system's final record and stays as it is.
--
-- 75cl's 803 is posted as its two causes (user, 2026-10-31: clear the 716 so
-- the system balances and continues accurately from here):
--   -716  added in this system on 30 Oct after the old system's balance
--         (13,364) was brought in -- already counted by the old system
--   -87   the old system's 30 Oct balance (13,364) over the count (13,277)
--
-- A first version of this script was run live: it posted today's lines
-- instead (75cl -793 to stock 13,277; 1.5Ltr +498), so 31 Oct showed them
-- under Adjusted / B/F with the Opening unchanged. Those lines
-- (STOCK-ADJ-2026-10-31) are taken out and their stock put back first --
-- a copy goes to the audit log -- then the opening lines are posted, so the
-- result is the same whichever version ran before.
--
-- Each is applied only while the Opening without those lines is what the
-- report showed (14,080 / 0); any other figure changes nothing and says so.
-- Production's hall is not touched. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_t record;
  v_n int;
  v_pid uuid;
  v_stock numeric;
  v_open numeric;
  v_delta numeric;
  v_part record;
  v_at timestamptz;
  v_run numeric;
  v_prior numeric;
  v_copy jsonb;
  v_done jsonb := '[]'::jsonb;
BEGIN
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  FOR v_t IN
    SELECT * FROM (VALUES
      ('75cl Bottle Water', '^75 ?cl bottle', 14080::numeric, 13277::numeric,
       '[[-716, "Cleared: 716 added on 30 Oct after the old system''s balance (13,364) was brought in -- already counted in the old system"],
         [-87, "Count correction: the old system''s 30 Oct balance 13,364 against the count of 13,277"]]'::jsonb),
      ('1.5Ltr Bottle Water', '^1\.5 ?(l|ltr|litre|liter)\M', 0::numeric, 498::numeric,
       '[[498, "Opening balance of 31 Oct 2026 set to 498 (user)"]]'::jsonb))
           AS t(label, pattern, expected, target, parts)
  LOOP
    v_n := (SELECT count(*) FROM products
             WHERE factory_id = v_factory AND product_type = 'finished' AND active
               AND btrim(name) ~* v_t.pattern);
    IF v_n <> 1 THEN
      RAISE NOTICE '%: % matching products -- not changed', v_t.label, v_n;
      CONTINUE;
    END IF;
    v_pid := (SELECT id FROM products
               WHERE factory_id = v_factory AND product_type = 'finished' AND active
                 AND btrim(name) ~* v_t.pattern);
    PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
    v_stock := (SELECT current_stock FROM products WHERE id = v_pid);
    -- Already done by this version: its lines are all on 30 Oct.
    IF EXISTS (SELECT 1 FROM inventory_movements
                WHERE product_id = v_pid AND reference = 'STOCK-ADJ-2026-10-31'
                  AND (created_at AT TIME ZONE 'Africa/Lagos')::date = '2026-10-30')
       AND NOT EXISTS (SELECT 1 FROM inventory_movements
                        WHERE product_id = v_pid AND reference = 'STOCK-ADJ-2026-10-31'
                          AND (created_at AT TIME ZONE 'Africa/Lagos')::date >= '2026-10-31') THEN
      RAISE NOTICE '%: 31 Oct opening already set -- not changed', v_t.label;
      CONTINUE;
    END IF;
    -- What earlier STOCK-ADJ-2026-10-31 lines did to the stock.
    v_prior := COALESCE((SELECT SUM(COALESCE(quantity_after - quantity_before, quantity))
                           FROM inventory_movements
                          WHERE product_id = v_pid AND reference = 'STOCK-ADJ-2026-10-31'), 0);
    -- 31 Oct's Opening without them, as warehouse_products_report works it out.
    v_open := (v_stock - v_prior) - COALESCE((
      SELECT SUM(COALESCE(m.quantity_after - m.quantity_before,
                          CASE WHEN m.movement_type::text IN ('sold', 'issued', 'transferred', 'damaged', 'used_for_production')
                               THEN -abs(m.quantity) ELSE m.quantity END))
        FROM inventory_movements m
       WHERE m.product_id = v_pid
         AND m.reference IS DISTINCT FROM 'STOCK-ADJ-2026-10-31'
         AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date >= '2026-10-31'), 0);
    IF v_open <> v_t.expected THEN
      RAISE NOTICE '%: 31 Oct opens at % without the earlier correction (expected %) -- not changed; say what it should be',
        v_t.label, v_open, v_t.expected;
      CONTINUE;
    END IF;

    -- Take the first version's lines out and put their stock back.
    IF v_prior <> 0 OR EXISTS (SELECT 1 FROM inventory_movements
                                WHERE product_id = v_pid AND reference = 'STOCK-ADJ-2026-10-31') THEN
      v_copy := (SELECT jsonb_agg(to_jsonb(m)) FROM inventory_movements m
                  WHERE m.product_id = v_pid AND m.reference = 'STOCK-ADJ-2026-10-31');
      DELETE FROM inventory_movements WHERE product_id = v_pid AND reference = 'STOCK-ADJ-2026-10-31';
      UPDATE products SET current_stock = current_stock - v_prior, updated_at = now() WHERE id = v_pid;
      INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
      VALUES (auth.uid(), v_factory, 'delete', 'inventory_movements', 'STOCK-ADJ-2026-10-31', v_copy,
              jsonb_build_object('product', v_t.label, 'stock_put_back', -v_prior,
                                 'reason', 'Today''s correction replaced by the 31 Oct opening balance'));
      RAISE NOTICE '%: earlier correction (%) taken out; stock % -> %',
        v_t.label, v_prior, v_stock, v_stock - v_prior;
      v_stock := v_stock - v_prior;
    END IF;

    v_delta := v_t.target - v_open;
    IF (SELECT sum((e->>0)::numeric) FROM jsonb_array_elements(v_t.parts) e) <> v_delta THEN
      RAISE EXCEPTION '%: the lines do not add up to % -- nothing changed', v_t.label, v_delta;
    END IF;
    UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_pid;
    -- One line per cause, a second apart, ending at 23:59:59 on 30 Oct.
    v_run := v_open;
    v_at := timestamptz '2026-10-30 23:59:59+01' - (jsonb_array_length(v_t.parts) - 1) * interval '1 second';
    FOR v_part IN SELECT (x.e->>0)::numeric AS qty, x.e->>1 AS reason
                    FROM jsonb_array_elements(v_t.parts) WITH ORDINALITY AS x(e, i) ORDER BY x.i LOOP
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after, created_at)
      VALUES (v_factory, v_pid, 'adjusted', v_part.qty, 'STOCK-ADJ-2026-10-31', v_part.reason,
              auth.uid(), v_run, v_run + v_part.qty, v_at);
      v_run := v_run + v_part.qty;
      v_at := v_at + interval '1 second';
    END LOOP;
    v_done := v_done || jsonb_build_object('product', v_t.label, 'opening_before', v_open,
                                           'opening_after', v_t.target, 'stock_before', v_stock,
                                           'stock_after', v_stock + v_delta);
    RAISE NOTICE '%: 31 Oct opening % -> %; stock % -> %', v_t.label, v_open, v_t.target, v_stock, v_stock + v_delta;
  END LOOP;

  IF jsonb_array_length(v_done) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_factory, 'stock_count', 'products', 'STOCK-ADJ-2026-10-31',
            jsonb_build_object('products', v_done, 'reason', 'Warehouse opening balances of 31 Oct 2026 (user)'));
  END IF;
END $$;
