-- ============================================================================
-- Godwin's 30 Oct return: no Warehouse stock change (like Malla)
-- ----------------------------------------------------------------------------
-- User (2026-11-02): "do it like Malla, so that it will not affect the
-- stocks, and when user is posting to this marketer, user will see the
-- returned products and new post will add to the return products".
--
-- Godwin's return of 30 Oct (75cl 4, 50cl 16) came back to the Warehouse
-- that day, so the 31 Oct count already has those packs. The first version
-- of 20261102110000 put them into Warehouse stock again on 2 Nov
-- ('return_from_rep' lines, reference RRN-20261030-...). Here those lines
-- come out and the stock goes back by the same amount -- as if they never
-- happened (a copy goes to the audit log), as for Malla (20261031140000).
--
-- The return stays open (carried_dispatch_id NULL), so Warehouse → Post to
-- Marketer for Godwin lists it and adds it to the posting with whatever new
-- products are posted; that posting takes the packs out when they leave.
-- Nothing to do if those lines were never made. Safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._godwin_30oct_return_no_stock()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ret rep_returns%ROWTYPE;
  v_line record;
  v_copy jsonb;
  v_undone jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_ret FROM rep_returns
   WHERE return_number LIKE 'RRN-20261030-%' AND return_date = DATE '2026-10-30' AND status = 'completed'
     AND notes ~ 'Return of 30/10/2026 \(WhatsApp message\)'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE NOTICE 'Godwin''s 30 Oct return is not recorded -- nothing changed';
    RETURN jsonb_build_object('skipped', 'no return');
  END IF;

  -- Open for his next posting, unless a live posting already carried it.
  IF v_ret.carried_dispatch_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM stock_dispatches d
                  WHERE d.id = v_ret.carried_dispatch_id AND d.dispatch_date = DATE '2026-10-30'
                    AND d.notes ~ 'Load out \d of 30/10/2026') THEN
    UPDATE rep_returns SET carried_dispatch_id = NULL WHERE id = v_ret.id;
  END IF;

  v_copy := (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM inventory_movements m
              WHERE m.reference = v_ret.return_number AND m.movement_type = 'return_from_rep');
  FOR v_line IN
    SELECT product_id, SUM(quantity) AS qty FROM inventory_movements
     WHERE reference = v_ret.return_number AND movement_type = 'return_from_rep'
     GROUP BY product_id
  LOOP
    UPDATE products SET current_stock = current_stock - v_line.qty, updated_at = now() WHERE id = v_line.product_id;
    v_undone := v_undone || jsonb_build_object('product_id', v_line.product_id, 'quantity', v_line.qty);
  END LOOP;
  DELETE FROM inventory_movements WHERE reference = v_ret.return_number AND movement_type = 'return_from_rep';

  UPDATE rep_returns
     SET notes = regexp_replace(notes, 'Back in Warehouse stock on 2 Nov;',
                                'In the Warehouse''s 31 Oct count;')
   WHERE id = v_ret.id;

  IF jsonb_array_length(v_undone) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (NULL, v_ret.factory_id, 'godwin_30oct_return_no_stock', 'rep_return', v_ret.id::text,
            jsonb_build_object('warehouse_lines', v_copy),
            jsonb_build_object('stock_taken_back', v_undone,
                               'note', 'Already in the 31 Oct count; the return stays open for the next posting'));
  END IF;
  RETURN jsonb_build_object('return', v_ret.return_number, 'stock_taken_back', v_undone);
END;
$$;
REVOKE ALL ON FUNCTION public._godwin_30oct_return_no_stock() FROM PUBLIC, anon, authenticated;

SELECT public._godwin_30oct_return_no_stock() AS result;
