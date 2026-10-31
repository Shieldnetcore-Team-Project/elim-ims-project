-- ============================================================================
-- Malla: clear every transaction except posting DSP-20261030-53041
-- ----------------------------------------------------------------------------
-- The user (2026-10-31): on marketer Malla's account keep only the posting
-- DSP-20261030-53041 (30 Oct, N717,000: 50cl Bottle Water 200 Pack, 75cl
-- Bottle Water 110 Pack) and clear every other transaction -- the sales of
-- 30 Oct (INV20261030-17190, -43210, -12561, -26682, ...) and anything else
-- -- so that what the Warehouse takes back from Malla is counted against
-- what was supplied to him.
--
-- Removed, as if they never happened (a copy goes to the audit log):
--   * every sale on Malla's account (sales.sales_rep_id), with its items,
--     receipts, debts and approval trail;
--   * his customers' money records -- their payments, debts and account
--     ledger -- and their balances back to 0 (later payments settle the
--     oldest debts first, so they can't be split per sale); the customers
--     themselves stay on his list;
--   * his cash remittances;
--   * his van stock ledger except DSP-20261030-53041's lines, and his van
--     stock set to exactly that posting: 50cl 200, 75cl 110.
--   * his earlier postings and returns, up to 29 Oct (DSP-20261029-62685,
--     DSP-20261029-99832), with their stock lines. The Warehouse's stock
--     was set to the old system's balance on 30 Oct, which already counts
--     them, so the Warehouse's stock is not changed for them.
-- The posting itself and the Warehouse's stock are not touched: his sales
-- came out of his van, not the Warehouse.
--
-- Stops, changing nothing, if: Malla is not found exactly once; the posting
-- is not his; he has another posting or a return after 29 Oct (they move
-- today's Warehouse stock -- say what to do with them); a sale took stock
-- from the Warehouse
-- or has a sales return or delivery; or one of his customers also bought
-- outside his account. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_n int;
  v_keep stock_dispatches%ROWTYPE;
  v_sales uuid[];
  v_invoices text[];
  v_custs uuid[];
  v_other text;
  v_copy jsonb;
  v_held jsonb;
  v_old_dispatches uuid[];
  v_old_returns uuid[];
  v_old_refs text[];
BEGIN
  v_n := (SELECT count(*) FROM sales_reps r JOIN factories f ON f.id = r.factory_id
           WHERE f.code = 'water' AND r.kind = 'rep' AND lower(btrim(r.full_name)) = 'malla');
  IF v_n <> 1 THEN
    RAISE NOTICE 'Malla: % marketers match -- nothing changed', v_n;
    RETURN;
  END IF;
  v_rep := (SELECT r FROM sales_reps r JOIN factories f ON f.id = r.factory_id
             WHERE f.code = 'water' AND r.kind = 'rep' AND lower(btrim(r.full_name)) = 'malla');

  v_keep := (SELECT d FROM stock_dispatches d WHERE d.dispatch_number = 'DSP-20261030-53041');
  IF v_keep.id IS NULL OR v_keep.sales_rep_id IS DISTINCT FROM v_rep.id THEN
    RAISE NOTICE 'DSP-20261030-53041 is not a posting to Malla -- nothing changed';
    RETURN;
  END IF;

  -- Other postings / returns dated after 29 Oct move today's Warehouse
  -- stock: not cleared blindly.
  v_other := (SELECT string_agg(n, ', ') FROM (
      SELECT dispatch_number AS n FROM stock_dispatches
       WHERE sales_rep_id = v_rep.id AND id <> v_keep.id
         AND (created_at AT TIME ZONE 'Africa/Lagos')::date > '2026-10-29'
      UNION ALL SELECT return_number FROM rep_returns
       WHERE sales_rep_id = v_rep.id
         AND (COALESCE(received_at, created_at) AT TIME ZONE 'Africa/Lagos')::date > '2026-10-29') x);
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Malla also has % -- nothing changed; say what to do with them', v_other;
  END IF;
  -- Those up to 29 Oct (DSP-20261029-62685, DSP-20261029-99832): the
  -- Warehouse's stock was set to the old system's balance on 30 Oct, which
  -- already counts them, so they and their stock lines go without changing
  -- the Warehouse's stock.
  v_old_dispatches := ARRAY(SELECT id FROM stock_dispatches WHERE sales_rep_id = v_rep.id AND id <> v_keep.id);
  v_old_returns := ARRAY(SELECT id FROM rep_returns WHERE sales_rep_id = v_rep.id);
  v_old_refs := ARRAY(SELECT dispatch_number FROM stock_dispatches WHERE id = ANY (v_old_dispatches)
                      UNION ALL SELECT return_number FROM rep_returns WHERE id = ANY (v_old_returns));

  v_sales := ARRAY(SELECT id FROM sales WHERE sales_rep_id = v_rep.id);
  v_invoices := ARRAY(SELECT invoice_number FROM sales WHERE id = ANY (v_sales));
  v_custs := ARRAY(SELECT DISTINCT customer_id FROM sales WHERE id = ANY (v_sales) AND customer_id IS NOT NULL);

  IF EXISTS (SELECT 1 FROM inventory_movements WHERE reference = ANY (v_invoices)) THEN
    RAISE EXCEPTION 'A sale on Malla''s account took stock from the Warehouse -- nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM sales_returns WHERE sale_id = ANY (v_sales))
     OR EXISTS (SELECT 1 FROM deliveries WHERE sale_id = ANY (v_sales)) THEN
    RAISE EXCEPTION 'A sale on Malla''s account has a sales return or delivery -- nothing changed';
  END IF;
  v_other := (SELECT string_agg(DISTINCT c.name, ', ') FROM sales s JOIN customers c ON c.id = s.customer_id
               WHERE s.customer_id = ANY (v_custs) AND NOT (s.id = ANY (v_sales)) AND s.deleted_at IS NULL);
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'These customers also bought outside Malla''s account: % -- nothing changed', v_other;
  END IF;

  v_held := (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity)), '[]'::jsonb)
               FROM rep_stock WHERE sales_rep_id = v_rep.id);
  IF cardinality(v_sales) = 0 AND cardinality(v_old_refs) = 0
     AND NOT EXISTS (SELECT 1 FROM rep_remittances WHERE sales_rep_id = v_rep.id)
     AND NOT EXISTS (SELECT 1 FROM rep_stock_movements
                      WHERE sales_rep_id = v_rep.id AND reference IS DISTINCT FROM v_keep.dispatch_number)
     AND v_held = (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', q)), '[]'::jsonb)
                     FROM (SELECT product_id, SUM(quantity) AS q FROM stock_dispatch_items
                            WHERE dispatch_id = v_keep.id GROUP BY product_id) k) THEN
    RAISE NOTICE 'Malla already holds only DSP-20261030-53041 -- nothing to clear';
    RETURN;
  END IF;

  v_copy := jsonb_build_object(
    'sales', (SELECT COALESCE(jsonb_agg(to_jsonb(s) || jsonb_build_object('items',
                (SELECT jsonb_agg(to_jsonb(i)) FROM sale_items i WHERE i.sale_id = s.id))), '[]'::jsonb)
                FROM sales s WHERE s.id = ANY (v_sales)),
    'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM payments_received p
                  WHERE p.sale_id = ANY (v_sales) OR p.customer_id = ANY (v_custs)),
    'debts', (SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb) FROM debts d
               WHERE d.sale_id = ANY (v_sales) OR d.customer_id = ANY (v_custs)),
    'customers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                    'total_purchases', c.total_purchases, 'outstanding_balance', c.outstanding_balance,
                    'total_transactions', c.total_transactions, 'credit_balance', c.credit_balance)), '[]'::jsonb)
                    FROM customers c WHERE c.id = ANY (v_custs)),
    'remittances', (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM rep_remittances m
                     WHERE m.sales_rep_id = v_rep.id),
    'postings', (SELECT COALESCE(jsonb_agg(to_jsonb(d) || jsonb_build_object('items',
                   (SELECT jsonb_agg(to_jsonb(i)) FROM stock_dispatch_items i WHERE i.dispatch_id = d.id))), '[]'::jsonb)
                   FROM stock_dispatches d WHERE d.id = ANY (v_old_dispatches)),
    'returns', (SELECT COALESCE(jsonb_agg(to_jsonb(r) || jsonb_build_object('items',
                  (SELECT jsonb_agg(to_jsonb(i)) FROM rep_return_items i WHERE i.rep_return_id = r.id))), '[]'::jsonb)
                  FROM rep_returns r WHERE r.id = ANY (v_old_returns)),
    'warehouse_lines', (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM inventory_movements m
                         WHERE m.reference = ANY (v_old_refs)),
    'van_stock_before', v_held);

  -- Append-only ledgers: their guards are paused just for these deletes.
  ALTER TABLE public.customer_account_transactions DISABLE TRIGGER trg_cat_immutable;
  DELETE FROM customer_account_transactions WHERE customer_id = ANY (v_custs);
  ALTER TABLE public.customer_account_transactions ENABLE TRIGGER trg_cat_immutable;
  ALTER TABLE public.container_movements DISABLE TRIGGER trg_cm_immutable;
  DELETE FROM container_movements
   WHERE sale_id = ANY (v_sales) OR dispatch_id = ANY (v_old_dispatches) OR rep_return_id = ANY (v_old_returns);
  ALTER TABLE public.container_movements ENABLE TRIGGER trg_cm_immutable;

  -- The 29 Oct postings / returns: records and stock lines only.
  DELETE FROM inventory_movements WHERE reference = ANY (v_old_refs);
  DELETE FROM rep_returns WHERE id = ANY (v_old_returns);            -- items go with them
  DELETE FROM stock_dispatches WHERE id = ANY (v_old_dispatches);    -- items go with them

  DELETE FROM payments_received WHERE sale_id = ANY (v_sales) OR customer_id = ANY (v_custs);
  DELETE FROM debts WHERE sale_id = ANY (v_sales) OR customer_id = ANY (v_custs);  -- debt payments go with them
  DELETE FROM workflow_approval_history WHERE module = 'sales' AND entity_id = ANY (v_sales);
  DELETE FROM audit_logs WHERE entity = 'sales' AND entity_id = ANY (ARRAY(SELECT x::text FROM unnest(v_sales) x));
  DELETE FROM sales WHERE id = ANY (v_sales);                                          -- items go with them
  UPDATE customers SET total_purchases = 0, outstanding_balance = 0, total_transactions = 0,
                       credit_balance = 0, updated_at = now()
   WHERE id = ANY (v_custs);

  DELETE FROM rep_remittances WHERE sales_rep_id = v_rep.id;

  -- His van: exactly what DSP-20261030-53041 gave him.
  DELETE FROM rep_stock_movements
   WHERE sales_rep_id = v_rep.id AND reference IS DISTINCT FROM v_keep.dispatch_number;
  DELETE FROM rep_stock WHERE sales_rep_id = v_rep.id;
  INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity, updated_at)
  SELECT v_rep.id, product_id, v_rep.factory_id, SUM(quantity), now()
    FROM stock_dispatch_items WHERE dispatch_id = v_keep.id
   GROUP BY product_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_rep.factory_id, 'delete', 'sales_reps', v_rep.id::text, v_copy,
          jsonb_build_object('marketer', v_rep.full_name, 'kept', v_keep.dispatch_number,
            'van_stock_after', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity))
                                  FROM rep_stock WHERE sales_rep_id = v_rep.id),
            'reason', 'Malla''s transactions cleared except DSP-20261030-53041 (user, 31 Oct 2026)'));
  RAISE NOTICE 'Malla: % sale(s) (%), % customer(s) reset, remittances cleared, earlier postings/returns removed (%); van stock = DSP-20261030-53041',
    cardinality(v_sales), array_to_string(v_invoices, ', '), cardinality(v_custs), array_to_string(v_old_refs, ', ');
END $$;
