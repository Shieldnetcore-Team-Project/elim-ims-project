-- ============================================================================
-- Accounts give a discount per pack on postings (the Retail Shop's)
-- ----------------------------------------------------------------------------
-- User (2026-11-03): on the Accountant page, when printing the Retail Shop's
-- invoices, Accounts can add a discount -- as a marketer's sale takes a
-- discount per pack -- on the Warehouse's postings to the shop.
--
--   stock_dispatch_items.unit_discount   per pack, 0 by default; the line's
--                     value is quantity x (price - discount), the posting's
--                     total follows; the price itself is kept
--   posting_discount_lines(dispatches)   the lines to discount, per product
--                     and price, with the discount already given
--   set_posting_discount(dispatches, lines, note)   Accounts (payments or
--                     debts write, as adjust_sale_lines), final at once,
--                     audited with the old and new totals; a discount is
--                     between 0 and the price
--   rep_posting_lines  a posting line reads at its price after discount, so
--                     every printout and screen shows quantity x price =
--                     amount (as a discounted invoice does)
--   reprice_posted_lines  keeps the discount when a price is corrected
-- ============================================================================

ALTER TABLE public.stock_dispatch_items
  ADD COLUMN IF NOT EXISTS unit_discount numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_discount >= 0);

CREATE OR REPLACE FUNCTION public.posting_discount_lines(p_dispatches uuid[])
RETURNS TABLE(product_id uuid, product_name text, unit text, unit_price numeric, quantity numeric,
              unit_discount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT i.product_id, COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.unit_price,
         SUM(i.quantity), MAX(i.unit_discount)
    FROM stock_dispatch_items i
    JOIN stock_dispatches d ON d.id = i.dispatch_id
    LEFT JOIN products p ON p.id = i.product_id
   WHERE d.id = ANY (p_dispatches) AND d.status::text <> 'reversed'
     AND public._works_in_factory(auth.uid(), d.factory_id)
   GROUP BY 1, 2, 3, 4
   ORDER BY 2, 4;
END;
$$;
REVOKE ALL ON FUNCTION public.posting_discount_lines(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.posting_discount_lines(uuid[]) TO authenticated;

-- p_lines: [{product_id, unit_price, unit_discount}] -- the discount per pack
-- for that product at that price on every one of the postings.
CREATE OR REPLACE FUNCTION public.set_posting_discount(p_dispatches uuid[], p_lines jsonb, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_line jsonb;
  v_disc numeric;
  v_price numeric;
  v_d record;
  v_before numeric := 0;
  v_after numeric := 0;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'lines must be a list'; END IF;
  IF EXISTS (SELECT 1 FROM stock_dispatches d WHERE d.id = ANY (p_dispatches)
              AND (d.status::text = 'reversed' OR NOT public._works_in_factory(v_uid, d.factory_id))) THEN
    RAISE EXCEPTION 'A posting here is reversed or not yours to change';
  END IF;
  SELECT COALESCE(SUM(total_value), 0) INTO v_before FROM stock_dispatches WHERE id = ANY (p_dispatches);

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_disc := COALESCE(NULLIF(v_line->>'unit_discount', '')::numeric, 0);
    v_price := NULLIF(v_line->>'unit_price', '')::numeric;
    IF v_disc < 0 THEN RAISE EXCEPTION 'A discount can''t be below 0'; END IF;
    IF v_price IS NOT NULL AND v_disc > v_price THEN
      RAISE EXCEPTION 'A discount can''t be more than the price (%)', v_price;
    END IF;
    UPDATE stock_dispatch_items
       SET unit_discount = v_disc, line_value = quantity * GREATEST(unit_price - v_disc, 0)
     WHERE dispatch_id = ANY (p_dispatches) AND product_id = (v_line->>'product_id')::uuid
       AND (v_price IS NULL OR unit_price = v_price) AND v_disc <= unit_price;
  END LOOP;

  FOR v_d IN SELECT id, dispatch_number, factory_id, total_value FROM stock_dispatches WHERE id = ANY (p_dispatches) LOOP
    UPDATE stock_dispatches
       SET total_value = (SELECT COALESCE(SUM(line_value), 0) FROM stock_dispatch_items WHERE dispatch_id = v_d.id)
     WHERE id = v_d.id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_d.factory_id, 'set_posting_discount', 'stock_dispatches', v_d.id::text,
            jsonb_build_object('dispatch_number', v_d.dispatch_number, 'total_value', v_d.total_value),
            jsonb_build_object('total_value', (SELECT total_value FROM stock_dispatches WHERE id = v_d.id),
                               'lines', p_lines, 'note', NULLIF(btrim(COALESCE(p_note, '')), '')));
  END LOOP;
  SELECT COALESCE(SUM(total_value), 0) INTO v_after FROM stock_dispatches WHERE id = ANY (p_dispatches);
  RETURN jsonb_build_object('before', v_before, 'after', v_after, 'discount', v_before - v_after);
END;
$$;
REVOKE ALL ON FUNCTION public.set_posting_discount(uuid[], jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_posting_discount(uuid[], jsonb, text) TO authenticated;

-- As 20261030220000, a posting line at its price after discount.
CREATE OR REPLACE FUNCTION public.rep_posting_lines(p_kind text, p_id uuid)
RETURNS TABLE(product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  IF p_kind = 'dispatch' THEN
    RETURN QUERY
    SELECT COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity, i.unit_price - i.unit_discount,
           COALESCE(NULLIF(i.line_value, 0), i.quantity * (i.unit_price - i.unit_discount)),
           CASE WHEN i.unit_discount > 0 THEN 'less ' || trim(to_char(i.unit_discount, 'FM999G999G990D00')) || ' a pack' END
      FROM stock_dispatch_items i
      JOIN stock_dispatches d ON d.id = i.dispatch_id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE i.dispatch_id = p_id AND public._works_in_factory(auth.uid(), d.factory_id)
     ORDER BY p.name;
  ELSIF p_kind = 'return' THEN
    RETURN QUERY
    SELECT COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, i.quantity_returned, i.unit_price,
           i.quantity_returned * i.unit_price,
           NULLIF(concat_ws(', ',
             CASE WHEN i.accepted_quantity IS NOT NULL THEN 'accepted ' || trim(to_char(i.accepted_quantity, 'FM999G999G990D###')) END,
             CASE WHEN i.damaged_quantity > 0 THEN 'damaged ' || trim(to_char(i.damaged_quantity, 'FM999G999G990D###')) END,
             CASE WHEN i.rejected_quantity > 0 THEN 'rejected ' || trim(to_char(i.rejected_quantity, 'FM999G999G990D###')) END), '')
      FROM rep_return_items i
      JOIN rep_returns r ON r.id = i.rep_return_id
      LEFT JOIN products p ON p.id = i.product_id
     WHERE i.rep_return_id = p_id AND public._works_in_factory(auth.uid(), r.factory_id)
     ORDER BY p.name;
  ELSIF p_kind = 'sale' THEN
    RETURN QUERY
    SELECT COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text, si.quantity, si.unit_price, si.line_total,
           NULL::text
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = p_id AND public._works_in_factory(auth.uid(), s.factory_id)
     ORDER BY p.name;
  ELSE
    RAISE EXCEPTION 'Unknown transaction kind: %', p_kind;
  END IF;
END;
$$;

-- As 20261103190000, the discount kept when a price is corrected.
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
    UPDATE stock_dispatch_items SET unit_price = v_p.unit_price,
           line_value = quantity * GREATEST(v_p.unit_price - unit_discount, 0)
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

NOTIFY pgrst, 'reload schema';
