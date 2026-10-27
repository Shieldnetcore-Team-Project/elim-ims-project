-- ============================================================================
-- Bottles go out as Bottle Water in packs, never as empty bottles in pieces
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-27): bottle products posted to marketers,
-- distributors, retail shops or sold to walk-in customers are recorded in
-- packs. The finished Bottle Water products are in packs
-- (20261027180000); the empty blown bottles ("50cl Bottle", semi_finished,
-- in pieces) are QC stock and must not go out. The posting and sale forms
-- now list finished products only; this makes the database refuse an empty
-- bottle on a posting or a sale too.
--
-- Malla's posting: any live posting to the marketer Malla (Water factory) that
-- holds an empty bottle is reversed (as reverse_stock_dispatch does: off the
-- marketer, back into stock), so it can be posted again as Bottle Water in
-- packs. Left alone, with a notice, if some of it was already sold or
-- returned. A posting of Bottle Water only is untouched (20261027180000 shows
-- it in packs). Safe to run again.
-- ============================================================================

-- ---- 1. Guard ----
CREATE OR REPLACE FUNCTION public._no_semi_finished_out()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text;
BEGIN
  SELECT name INTO v_name FROM products WHERE id = NEW.product_id AND product_type = 'semi_finished';
  IF FOUND THEN
    RAISE EXCEPTION '% is an empty bottle (QC stock, in pieces) -- post or sell the Bottle Water product in packs instead', v_name;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_no_semi_finished_dispatch ON public.stock_dispatch_items;
CREATE TRIGGER trg_no_semi_finished_dispatch
  BEFORE INSERT OR UPDATE OF product_id ON public.stock_dispatch_items
  FOR EACH ROW EXECUTE FUNCTION public._no_semi_finished_out();
DROP TRIGGER IF EXISTS trg_no_semi_finished_sale ON public.sale_items;
CREATE TRIGGER trg_no_semi_finished_sale
  BEFORE INSERT OR UPDATE OF product_id ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public._no_semi_finished_out();

-- ---- 2. Malla's posting ----
DO $$
DECLARE
  v_count int;
  v_rep sales_reps%ROWTYPE;
  v_d stock_dispatches%ROWTYPE;
  v_item record;
  v_before numeric;
  v_ok boolean;
BEGIN
  SELECT count(*) INTO v_count FROM sales_reps r JOIN factories f ON f.id = r.factory_id
   WHERE f.code = 'water' AND r.kind = 'rep' AND lower(btrim(r.full_name)) = 'malla';
  IF v_count <> 1 THEN
    RAISE NOTICE 'Malla: % marketers match -- correct the posting on Warehouse → Marketers → Postings & returns', v_count;
    RETURN;
  END IF;
  SELECT r.* INTO v_rep FROM sales_reps r JOIN factories f ON f.id = r.factory_id
   WHERE f.code = 'water' AND r.kind = 'rep' AND lower(btrim(r.full_name)) = 'malla';

  FOR v_d IN
    SELECT d.* FROM stock_dispatches d
     WHERE d.sales_rep_id = v_rep.id AND d.status = 'posted'
       AND EXISTS (SELECT 1 FROM stock_dispatch_items i JOIN products p ON p.id = i.product_id
                    WHERE i.dispatch_id = d.id AND p.product_type = 'semi_finished')
     FOR UPDATE
  LOOP
    -- Only while every unit is still with the marketer.
    SELECT bool_and(COALESCE(rs.quantity, 0) >= i.quantity) INTO v_ok
      FROM stock_dispatch_items i
      LEFT JOIN rep_stock rs ON rs.sales_rep_id = v_d.sales_rep_id AND rs.product_id = i.product_id
     WHERE i.dispatch_id = v_d.id;
    IF NOT v_ok THEN
      RAISE NOTICE 'Kept %: Malla already sold or returned some of it -- correct it on the Marketers page', v_d.dispatch_number;
      CONTINUE;
    END IF;

    FOR v_item IN SELECT * FROM stock_dispatch_items WHERE dispatch_id = v_d.id LOOP
      SELECT quantity INTO v_before FROM rep_stock
       WHERE sales_rep_id = v_d.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
       WHERE sales_rep_id = v_d.sales_rep_id AND product_id = v_item.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_d.factory_id, v_d.sales_rep_id, v_item.product_id, 'reversal', -v_item.quantity, v_d.dispatch_number,
              'Posted in pieces; to be posted again in packs', auth.uid(), v_before, v_before - v_item.quantity);

      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_d.factory_id, v_item.product_id, 'return_from_rep', v_item.quantity, v_d.dispatch_number,
              'Posting reversed: posted in pieces; to be posted again in packs', auth.uid(), v_before, v_before + v_item.quantity);
    END LOOP;

    UPDATE stock_dispatches
       SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(),
           reverse_reason = 'Posted in pieces; post again as Bottle Water in packs'
     WHERE id = v_d.id;
    UPDATE rep_returns SET carried_dispatch_id = NULL WHERE carried_dispatch_id = v_d.id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), v_d.factory_id, 'reverse_stock_dispatch', 'stock_dispatch', v_d.id::text,
            jsonb_build_object('dispatch_number', v_d.dispatch_number, 'marketer', v_rep.full_name,
                               'reason', 'Posted in pieces; post again as Bottle Water in packs (2026-10-27)'));
    RAISE NOTICE 'Reversed % (Malla)', v_d.dispatch_number;
  END LOOP;
END $$;
