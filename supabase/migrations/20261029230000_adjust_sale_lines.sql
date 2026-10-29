-- ============================================================================
-- adjust_sale_lines: discount / surcharge per product on a posted invoice
-- ----------------------------------------------------------------------------
-- User rule (2026-10-29): from the customer view on the Accountant page, the
-- accountant can give a customer / distributor / marketer a discount on each
-- product of a sale, and add a surcharge (extra cost) on each product, all
-- in one save. Final at once -- no approval and no reason required -- and
-- logged in the audit trail. (Replaces the whole-invoice apply_sale_discount
-- first written the same day.)
--
-- p_lines: [{item_id, discount, surcharge}] -- money PER PACK (per unit of
-- the product), added to what the line already has; the line moves by
-- quantity x that amount (user, 2026-10-29: "per pack, not per whole packs").
--   sale_items  unit_discount / unit_surcharge: per pack; discount /
--               surcharge: the line totals (quantity x per pack); line_total
--               becomes quantity x (unit_price - unit_discount + unit_surcharge)
--   sales       subtotal, grand_total and balance move by the net change
--               (surcharges - discounts); the printed invoice shows each
--               line's discount / surcharge and the new totals
--   debts       the invoice's debt moves with it -- a surcharge on a paid
--               invoice re-opens (or opens) a debt for the extra
--   ledger      a customer's account gets one CREDIT_ADJUSTMENT (net down)
--               or DEBIT_ADJUSTMENT (net up) and outstanding_balance moves
-- A discount can't take a pack's price below 0, nor the invoice below what has been
-- paid (that would be a refund). Same rights as recording a payment.
-- ============================================================================

DROP FUNCTION IF EXISTS public.apply_sale_discount(uuid, numeric, text);

ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS discount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  ADD COLUMN IF NOT EXISTS surcharge numeric(14,2) NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
  ADD COLUMN IF NOT EXISTS unit_discount numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_discount >= 0),
  ADD COLUMN IF NOT EXISTS unit_surcharge numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_surcharge >= 0);

CREATE OR REPLACE FUNCTION public.adjust_sale_lines(p_sale uuid, p_lines jsonb, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sale sales%ROWTYPE;
  v_item sale_items%ROWTYPE;
  v_debt debts%ROWTYPE;
  v_line jsonb;
  v_ud numeric;
  v_us numeric;
  v_d numeric;
  v_s numeric;
  v_disc numeric := 0;
  v_surch numeric := 0;
  v_net numeric;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_audit jsonb := '[]'::jsonb;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key)
       OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'No product lines given'; END IF;

  -- Lock order: sale -> customer -> debt (as everywhere else).
  SELECT * INTO v_sale FROM sales WHERE id = p_sale FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_sale.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_sale.deleted_at IS NOT NULL OR v_sale.status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted invoice can be adjusted';
  END IF;
  IF COALESCE(v_sale.is_pr, false) THEN RAISE EXCEPTION 'A PR / complimentary invoice is not billed'; END IF;
  IF v_sale.customer_id IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_ud := round(COALESCE((v_line->>'discount')::numeric, 0), 2);
    v_us := round(COALESCE((v_line->>'surcharge')::numeric, 0), 2);
    IF v_ud < 0 OR v_us < 0 THEN RAISE EXCEPTION 'Discounts and surcharges cannot be negative'; END IF;
    CONTINUE WHEN v_ud = 0 AND v_us = 0;
    SELECT * INTO v_item FROM sale_items WHERE id = (v_line->>'item_id')::uuid AND sale_id = p_sale FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product line not found on invoice %', v_sale.invoice_number; END IF;
    IF v_item.unit_price - v_item.unit_discount - v_ud + v_item.unit_surcharge + v_us < 0 THEN
      RAISE EXCEPTION 'The discount on % is more than its price per pack (%)',
        (SELECT name FROM products WHERE id = v_item.product_id),
        v_item.unit_price - v_item.unit_discount + v_item.unit_surcharge + v_us;
    END IF;
    v_d := round(v_item.quantity * v_ud, 2);
    v_s := round(v_item.quantity * v_us, 2);
    UPDATE sale_items
       SET unit_discount = unit_discount + v_ud, unit_surcharge = unit_surcharge + v_us,
           discount = discount + v_d, surcharge = surcharge + v_s, line_total = line_total - v_d + v_s
     WHERE id = v_item.id;
    v_disc := v_disc + v_d;
    v_surch := v_surch + v_s;
    v_audit := v_audit || jsonb_build_object('item_id', v_item.id,
      'product', (SELECT name FROM products WHERE id = v_item.product_id),
      'quantity', v_item.quantity, 'discount_per_pack', v_ud, 'surcharge_per_pack', v_us,
      'discount', v_d, 'surcharge', v_s, 'line_total_before', v_item.line_total,
      'line_total_after', v_item.line_total - v_d + v_s);
  END LOOP;
  IF v_disc = 0 AND v_surch = 0 THEN RAISE EXCEPTION 'Enter a discount or surcharge on at least one product'; END IF;

  v_net := v_surch - v_disc;
  IF v_sale.balance + v_net < 0 THEN
    RAISE EXCEPTION 'The discounts are more than the balance still owed (%): that would be a refund', v_sale.balance;
  END IF;

  UPDATE sales
     SET subtotal = subtotal + v_net, grand_total = grand_total + v_net, balance = balance + v_net
   WHERE id = p_sale;

  IF v_net <> 0 THEN
    SELECT * INTO v_debt FROM debts WHERE sale_id = p_sale
     ORDER BY (status <> 'paid') DESC, created_at DESC, id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE debts
         SET total_amount = GREATEST(total_amount + v_net, 0),
             outstanding = GREATEST(outstanding + v_net, 0),
             status = CASE WHEN GREATEST(outstanding + v_net, 0) = 0 THEN 'paid'::debt_status
                           WHEN amount_paid > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END,
             updated_at = now()
       WHERE id = v_debt.id
       RETURNING * INTO v_debt;
    ELSIF v_net > 0 THEN
      -- A paid (cash) invoice now owes the surcharge.
      INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
      VALUES (v_sale.factory_id, v_sale.customer_id, p_sale, v_sale.sales_rep_id, v_net, 0, v_net, 'unpaid')
      RETURNING * INTO v_debt;
    END IF;
    IF v_sale.customer_id IS NOT NULL THEN
      UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance + v_net, 0), updated_at = now()
       WHERE id = v_sale.customer_id;
      PERFORM public._customer_ledger_post(
        v_sale.factory_id, v_sale.customer_id,
        CASE WHEN v_net < 0 THEN 'CREDIT_ADJUSTMENT' ELSE 'DEBIT_ADJUSTMENT' END,
        'sale_line_adjustment', gen_random_uuid(), p_sale, NULL, v_debt.id,
        0, 0, 0, 0, v_net, NULL,
        'Adjustment on ' || v_sale.invoice_number ||
          CASE WHEN v_disc > 0 THEN ': discount ' || v_disc ELSE '' END ||
          CASE WHEN v_surch > 0 THEN CASE WHEN v_disc > 0 THEN ', ' ELSE ': ' END || 'surcharge ' || v_surch ELSE '' END,
        v_note, NULL, NULL, v_uid);
    END IF;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_sale.factory_id, 'sale_line_adjustment', 'sales', p_sale::text,
          jsonb_build_object('invoice_number', v_sale.invoice_number, 'grand_total', v_sale.grand_total,
                             'balance', v_sale.balance),
          jsonb_build_object('invoice_number', v_sale.invoice_number, 'customer', v_sale.customer_name,
                             'discount', v_disc, 'surcharge', v_surch, 'lines', v_audit,
                             'grand_total', v_sale.grand_total + v_net, 'balance', v_sale.balance + v_net,
                             'note', v_note));

  RETURN jsonb_build_object('invoice_number', v_sale.invoice_number, 'discount', v_disc, 'surcharge', v_surch,
                            'grand_total', v_sale.grand_total + v_net, 'balance', v_sale.balance + v_net);
END;
$$;
REVOKE ALL ON FUNCTION public.adjust_sale_lines(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_sale_lines(uuid, jsonb, text) TO authenticated;

-- The invoice lines now carry their id (for the adjust form) and each line's
-- discount / surcharge (printed on the invoice). The return type changes, so
-- drop and re-create.
DROP FUNCTION IF EXISTS public.sale_invoice_lines(uuid[]);
CREATE FUNCTION public.sale_invoice_lines(p_sales uuid[])
RETURNS TABLE(sale_id uuid, product_name text, unit text, quantity numeric, unit_price numeric, line_total numeric,
              item_id uuid, discount numeric, surcharge numeric, unit_discount numeric, unit_surcharge numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF COALESCE(array_length(p_sales, 1), 0) > 1000 THEN RAISE EXCEPTION 'At most 1000 sales at a time'; END IF;

  RETURN QUERY
  SELECT si.sale_id, COALESCE(p.name, '-')::text, COALESCE(p.unit, '')::text,
         si.quantity, si.unit_price, si.line_total, si.id, si.discount, si.surcharge,
         si.unit_discount, si.unit_surcharge
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN products p ON p.id = si.product_id
   WHERE si.sale_id = ANY(p_sales)
     AND public._works_in_factory(auth.uid(), s.factory_id)
   ORDER BY si.sale_id, si.id;
END;
$$;
REVOKE ALL ON FUNCTION public.sale_invoice_lines(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sale_invoice_lines(uuid[]) TO authenticated;
