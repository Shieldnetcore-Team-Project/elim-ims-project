-- ============================================================================
-- Godwin's 30 Oct return shows on his next posting
-- ----------------------------------------------------------------------------
-- User report (2026-11-02): Warehouse -> Marketers -> Post products for
-- Godwin doesn't show his return of 30 Oct (75cl 4, 50cl 16).
-- 20261102100000 linked that return to load-out 4 so it would not be carried
-- again; the user wants it carried like any return. So:
--   * the link (carried_dispatch_id) is taken off, and the posting form
--     adds the return to his next posting automatically (20261031150000);
--   * its goods go into Warehouse stock now ('return_from_rep' lines, as
--     create_rep_return does), so carrying them out on that posting leaves
--     the Warehouse where it is. Dated now, not 30 Oct, so 31 Oct's counted
--     opening stays as it was.
-- Only that return (RRN-20261030-..., noted "WhatsApp message"). Does
-- nothing if 20261102100000 hasn't run. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._godwin_30oct_return_open()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ret rep_returns%ROWTYPE;
  v_it record;
  v_before numeric;
  v_rep text;
BEGIN
  SELECT * INTO v_ret FROM rep_returns
   WHERE return_number LIKE 'RRN-20261030-%' AND return_date = DATE '2026-10-30' AND status = 'completed'
     AND notes LIKE 'Return of 30/10/2026 (WhatsApp message)%'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'Godwin''s 30 Oct return is not recorded -- nothing changed';
    RETURN;
  END IF;
  v_rep := (SELECT full_name FROM sales_reps WHERE id = v_ret.sales_rep_id);

  UPDATE rep_returns
     SET carried_dispatch_id = NULL,
         notes = 'Return of 30/10/2026 (WhatsApp message), recorded 2 Nov 2026. Back in Warehouse stock '
                 || 'on 2 Nov; carried onto the next posting.'
   WHERE id = v_ret.id;

  IF NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reference = v_ret.return_number AND movement_type = 'return_from_rep') THEN
    FOR v_it IN SELECT product_id, COALESCE(accepted_quantity, quantity_returned) AS qty
                  FROM rep_return_items WHERE rep_return_id = v_ret.id LOOP
      SELECT current_stock INTO v_before FROM products WHERE id = v_it.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock + v_it.qty, updated_at = now() WHERE id = v_it.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                      quantity_before, quantity_after)
      VALUES (v_ret.factory_id, v_it.product_id, 'return_from_rep', v_it.qty, v_ret.return_number,
              'Returned by ' || v_rep || ' (return of 30 Oct)', v_ret.received_by, v_before, v_before + v_it.qty);
    END LOOP;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (NULL, v_ret.factory_id, 'reopen_rep_return', 'rep_return', v_ret.id::text,
          jsonb_build_object('carried_dispatch_id', v_ret.carried_dispatch_id),
          jsonb_build_object('return_number', v_ret.return_number, 'carried_dispatch_id', NULL,
                             'note', 'Shown on the next posting; goods back in Warehouse stock'));
  RAISE NOTICE '% (%) will show on %''s next posting', v_ret.return_number, v_rep, v_rep;
END;
$$;
REVOKE ALL ON FUNCTION public._godwin_30oct_return_open() FROM PUBLIC, anon, authenticated;

SELECT public._godwin_30oct_return_open();
