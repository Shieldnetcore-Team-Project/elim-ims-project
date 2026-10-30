-- ============================================================================
-- 50cl: the old system's 30 Oct Qty In was 615, not 613 (user, 2026-10-30)
-- ----------------------------------------------------------------------------
-- The old system's 30 Oct row for 50cl Bottle Water becomes
--   Opening 302 | Qty In 615 | Total 917 | Qty Out 500 | Balance 417
-- (was 613 / 915 / 415), so its balance brought forward is 417: Warehouse
-- stock goes up by 2. With the 80 packs Production released that day the
-- report then shows Qty In 695, Total 997, Balance 497 -- the stock.
--
-- The 2 packs are posted as part of the balance brought forward (an
-- 'opening_balance' line, BALANCE-BF-2026-10-30) at the B/F's own time, so
-- what was done after the B/F still counts on top. Done once: only while the
-- stored row still says 613 (20261030150000/20261030120000 now carry 615/417
-- for a first run). Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_pid uuid;
  v_factory uuid;
  v_at timestamptz;
  v_before numeric;
BEGIN
  v_pid := (SELECT s.product_id FROM warehouse_report_snapshots s
              JOIN products p ON p.id = s.product_id
             WHERE s.report_date = '2026-10-30' AND btrim(p.name) ~* '^50 ?cl bottle'
               AND s.qty_in = 613 AND s.balance = 415
             LIMIT 1);
  IF v_pid IS NULL THEN
    RAISE NOTICE '50cl: already Qty In 615 / Balance 417 -- nothing changed';
    RETURN;
  END IF;
  v_factory := (SELECT factory_id FROM products WHERE id = v_pid);

  UPDATE warehouse_report_snapshots SET qty_in = 615, balance = 417
   WHERE product_id = v_pid AND report_date = '2026-10-30';

  -- At the balance brought forward's time, so it stays part of the B/F.
  v_at := public._report_snapshot_cutoff(v_pid, '2026-10-30');
  PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
  v_before := (SELECT current_stock FROM products WHERE id = v_pid);
  UPDATE products SET current_stock = current_stock + 2, updated_at = now() WHERE id = v_pid;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after, created_at)
  VALUES (v_factory, v_pid, 'opening_balance', 2, 'BALANCE-BF-2026-10-30',
          'Balance brought forward from the old system: 50cl Qty In 615, not 613 (+2)',
          auth.uid(), v_before, v_before + 2, COALESCE(v_at, now()));

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'stock_count', 'products', 'BALANCE-BF-2026-10-30',
          jsonb_build_object('product', '50cl Bottle Water', 'qty_in', 613, 'balance', 415),
          jsonb_build_object('product', '50cl Bottle Water', 'qty_in', 615, 'balance', 417,
                             'stock_now', v_before + 2, 'reason', 'Old system 30 Oct Qty In was 615'));
  RAISE NOTICE '50cl: Qty In 615, Balance 417 brought forward -- stock % -> %', v_before, v_before + 2;
END $$;
