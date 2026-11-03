-- ============================================================================
-- Re-pricing touches only what is meant: since a date, at the old price
-- ----------------------------------------------------------------------------
-- User (2026-11-03): "make sure the system does not repeat this same mistake
-- again". The mistake: Dispenser Water was priced wrongly on Costing for a
-- while, every posting / return in that time kept the wrong price, and
-- putting the price right never reached them.
--
-- Costing > Product Prices now confirms every price change (old -> new, with
-- warnings) and, when the old price was a mistake, corrects the postings and
-- returns made at it in the same step. For that, reprice_posted_lines takes
-- two more options, so a genuine price change can't rewrite older postings:
--   p_from        only postings / returns dated on or after this day
--   p_old_price   only lines at exactly this (wrong) price
-- Left out, it behaves as 20261103180000 (every line not at today's price).
-- ============================================================================

DROP FUNCTION IF EXISTS public.reprice_posted_lines(uuid, text, boolean);
CREATE OR REPLACE FUNCTION public.reprice_posted_lines(
  p_product uuid, p_reason text DEFAULT NULL, p_dry_run boolean DEFAULT false,
  p_from date DEFAULT NULL, p_old_price numeric DEFAULT NULL
) RETURNS TABLE(kind text, reference text, party text, day date, quantity numeric,
                old_price numeric, new_price numeric, old_value numeric, new_value numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_p products%ROWTYPE;
  v_d record;
  v_old numeric;
  v_reason text := COALESCE(NULLIF(btrim(p_reason), ''), 'Re-priced to the Costing price');
BEGIN
  IF v_uid IS NOT NULL AND NOT public._is_product_admin(v_uid) THEN
    RAISE EXCEPTION 'Only an administrator can re-price postings';
  END IF;
  SELECT * INTO v_p FROM products WHERE id = p_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF p_from IS NOT NULL AND p_from > (now() AT TIME ZONE 'Africa/Lagos')::date THEN
    RAISE EXCEPTION 'The start date is in the future';
  END IF;

  RETURN QUERY
  SELECT 'posting'::text, d.dispatch_number, r.full_name, d.dispatch_date, i.quantity,
         i.unit_price, v_p.unit_price, i.line_value, i.quantity * v_p.unit_price
    FROM stock_dispatch_items i
    JOIN stock_dispatches d ON d.id = i.dispatch_id
    JOIN sales_reps r ON r.id = d.sales_rep_id
   WHERE i.product_id = p_product AND d.status::text <> 'reversed' AND i.unit_price <> v_p.unit_price
     AND (p_from IS NULL OR d.dispatch_date >= p_from)
     AND (p_old_price IS NULL OR i.unit_price = p_old_price)
  UNION ALL
  SELECT 'return', rr.return_number, r.full_name, rr.return_date, i.quantity_returned,
         i.unit_price, v_p.unit_price, i.quantity_returned * i.unit_price, i.quantity_returned * v_p.unit_price
    FROM rep_return_items i
    JOIN rep_returns rr ON rr.id = i.rep_return_id
    JOIN sales_reps r ON r.id = rr.sales_rep_id
   WHERE i.product_id = p_product AND rr.status::text <> 'cancelled' AND i.unit_price <> v_p.unit_price
     AND (p_from IS NULL OR rr.return_date >= p_from)
     AND (p_old_price IS NULL OR i.unit_price = p_old_price)
   ORDER BY 4, 2;

  IF p_dry_run THEN RETURN; END IF;

  FOR v_d IN
    SELECT DISTINCT d.id, d.dispatch_number, d.factory_id, d.total_value
      FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
     WHERE i.product_id = p_product AND d.status::text <> 'reversed' AND i.unit_price <> v_p.unit_price
       AND (p_from IS NULL OR d.dispatch_date >= p_from)
       AND (p_old_price IS NULL OR i.unit_price = p_old_price)
  LOOP
    v_old := v_d.total_value;
    UPDATE stock_dispatch_items SET unit_price = v_p.unit_price, line_value = quantity * v_p.unit_price
     WHERE dispatch_id = v_d.id AND product_id = p_product AND unit_price <> v_p.unit_price
       AND (p_old_price IS NULL OR unit_price = p_old_price);
    UPDATE stock_dispatches
       SET total_value = (SELECT COALESCE(SUM(line_value), 0) FROM stock_dispatch_items WHERE dispatch_id = v_d.id)
     WHERE id = v_d.id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_d.factory_id, 'reprice_posted_lines', 'stock_dispatches', v_d.id::text,
            jsonb_build_object('dispatch_number', v_d.dispatch_number, 'total_value', v_old),
            jsonb_build_object('product', v_p.name, 'unit_price', v_p.unit_price,
                               'total_value', (SELECT total_value FROM stock_dispatches WHERE id = v_d.id),
                               'reason', v_reason));
  END LOOP;

  FOR v_d IN
    SELECT DISTINCT rr.id, rr.return_number, rr.factory_id
      FROM rep_return_items i JOIN rep_returns rr ON rr.id = i.rep_return_id
     WHERE i.product_id = p_product AND rr.status::text <> 'cancelled' AND i.unit_price <> v_p.unit_price
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_old_price IS NULL OR i.unit_price = p_old_price)
  LOOP
    SELECT SUM(quantity_returned * unit_price) INTO v_old FROM rep_return_items
     WHERE rep_return_id = v_d.id AND product_id = p_product;
    UPDATE rep_return_items SET unit_price = v_p.unit_price
     WHERE rep_return_id = v_d.id AND product_id = p_product AND unit_price <> v_p.unit_price
       AND (p_old_price IS NULL OR unit_price = p_old_price);
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_d.factory_id, 'reprice_posted_lines', 'rep_returns', v_d.id::text,
            jsonb_build_object('return_number', v_d.return_number, 'value', v_old),
            jsonb_build_object('product', v_p.name, 'unit_price', v_p.unit_price,
                               'value', (SELECT SUM(quantity_returned * unit_price) FROM rep_return_items
                                          WHERE rep_return_id = v_d.id AND product_id = p_product),
                               'reason', v_reason));
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.reprice_posted_lines(uuid, text, boolean, date, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reprice_posted_lines(uuid, text, boolean, date, numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';
