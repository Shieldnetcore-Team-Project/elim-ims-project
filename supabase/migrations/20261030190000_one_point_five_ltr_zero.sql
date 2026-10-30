-- ============================================================================
-- 1.5Ltr Bottle Water: nothing on 30 Oct 2026 (user, 2026-10-30)
-- ----------------------------------------------------------------------------
-- The Warehouse never held 1.5Ltr; nothing is brought forward for it. Its
-- 30 Oct row on the Products Report is all 0 -- Opening, Qty In, Total, Qty
-- Out, Returned, Gift/Sample, Adjusted / B/F, Balance -- like the old
-- system's rows, stored and shown as is (warehouse_report_snapshots). Its
-- stock is 0 (cleared in 20261030180000), so 31 Oct opens at 0 and anything
-- released from Production after that counts as usual. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_n int;
  v_pid uuid;
BEGIN
  v_n := (SELECT count(*) FROM products
           WHERE factory_id = v_factory AND product_type = 'finished' AND active
             AND btrim(name) ~* '^1\.5 ?(l|ltr|litre|liter)\M');
  IF v_n <> 1 THEN
    RAISE NOTICE '1.5Ltr Bottle Water: % matching products -- not changed', v_n;
    RETURN;
  END IF;
  v_pid := (SELECT id FROM products
             WHERE factory_id = v_factory AND product_type = 'finished' AND active
               AND btrim(name) ~* '^1\.5 ?(l|ltr|litre|liter)\M');

  INSERT INTO warehouse_report_snapshots(factory_id, report_date, product_id, opening, qty_in, qty_out,
                                         returned, gift, balance, source)
  VALUES (v_factory, '2026-10-30', v_pid, 0, 0, 0, 0, 0, 0, 'Not held: nothing brought forward (user)')
  ON CONFLICT (product_id, report_date) DO UPDATE
    SET opening = 0, qty_in = 0, qty_out = 0, returned = 0, gift = 0, balance = 0, source = EXCLUDED.source;

  IF (SELECT current_stock FROM products WHERE id = v_pid) <> 0 THEN
    RAISE NOTICE '1.5Ltr Bottle Water: 30 Oct row set to 0, but stock is % -- run 20261030180000 first',
      (SELECT current_stock FROM products WHERE id = v_pid);
  ELSE
    RAISE NOTICE '1.5Ltr Bottle Water: 30 Oct all 0; stock 0';
  END IF;
END $$;
