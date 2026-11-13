-- ============================================================================
-- H MEDIX 12 Nov: 440 Dispenser Water supplied, 21 returned (19 + 2)
-- ----------------------------------------------------------------------------
-- User (2026-11-13): "19 and 2 was returned from 440 making 21" -- the
-- return window must read: supplied 440, 21 already returned, 419 can return.
--
-- What the live data held (read-only check, 13 Nov):
--   postings, live:  INV20261112-79440 Dispenser Water 300
--                    INV20261113-16919 Dispenser Water 121  (20261113090000's
--                      correction of INV20261112-27151, 140, less 19)
--   reversed:        INV20261112-27151 140, INV20261112-57135 Jug + Water 19
--   returns dated 12 Nov:
--     SR-20261112-17857-1  19  on 27151   real
--     SR-20261112-82484-1   2  on 57135   wrong (on the mistaken Jug + Water)
--     SR-20261112-10337-1  17  on 57135   wrong
--     SR-20261113-63344-1   2  on 79440   real
-- So 20261113090000 took the 19 off twice (its return SR-17857 was already
-- in), and 2 + 17 were returned against the mistaken Jug + Water posting.
-- The account's money already equals (440 - 21) x 1,200. On paper stock is
-- 38 too high (each reversal put its full quantity back although 19 of it
-- had already come back by return), but live Dispenser Water stock was only
-- 32 when this was first tried, so stock is left for a separate check.
--
-- This script (records only -- no stock, no money):
--   1. cancels SR-82484 and SR-10337 (their jug entries are undone by the
--      sales_returns trigger); no money moves -- the Jug + Water posting
--      they credited is already reversed, so its charge and their credit
--      are both gone;
--   2. puts INV20261113-16919's line back to 140 (as 27151 was), keeps its
--      total at 145,200 (140 less the 19 returned) and moves SR-17857 onto
--      it (a Dispenser Water swap line moves no jugs).
-- Guards: every row must be as listed above, or nothing changes. Safe to run
-- again (the second run finds it done).
-- ============================================================================

DO $$
DECLARE
  v_uid uuid := auth.uid();
  v_cust customers%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_item sale_items%ROWTYPE;
  v_r1 sales_returns%ROWTYPE;     -- SR-17857, 19, real
  v_bad uuid[];
  v_prod uuid;
  v_before numeric;
  v_supplied numeric;
  v_returned numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE entity = 'customers' AND entity_id = 'hmedix-12nov-440-less-21') THEN
    RAISE NOTICE 'Already done -- nothing to change';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sales WHERE invoice_number = 'INV20261113-16919') THEN
    RAISE NOTICE 'INV20261113-16919 is not here -- nothing changed';
    RETURN;
  END IF;

  SELECT * INTO v_sale FROM sales WHERE invoice_number = 'INV20261113-16919' FOR UPDATE;
  SELECT * INTO v_cust FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
  IF regexp_replace(lower(v_cust.name), '[^a-z]', '', 'g') <> 'hmedix' THEN
    RAISE EXCEPTION 'INV20261113-16919 is not H MEDIX''s -- nothing changed';
  END IF;
  IF v_sale.deleted_at IS NOT NULL OR v_sale.status <> 'posted' OR v_sale.sale_date <> '2026-11-12' THEN
    RAISE EXCEPTION 'INV20261113-16919 is no longer a live 12 Nov posting -- nothing changed';
  END IF;
  IF (SELECT count(*) FROM sale_items WHERE sale_id = v_sale.id) <> 1 THEN
    RAISE EXCEPTION 'INV20261113-16919 has more than one line -- nothing changed';
  END IF;
  SELECT * INTO v_item FROM sale_items WHERE sale_id = v_sale.id FOR UPDATE;
  IF v_item.quantity <> 121 OR v_item.unit_price <> 1200 THEN
    RAISE EXCEPTION 'INV20261113-16919 reads % @ %, not 121 @ 1,200 -- nothing changed', v_item.quantity, v_item.unit_price;
  END IF;
  v_prod := v_item.product_id;

  SELECT * INTO v_r1 FROM sales_returns WHERE return_number = 'SR-20261112-17857-1' FOR UPDATE;
  IF NOT FOUND OR v_r1.customer_id <> v_cust.id OR v_r1.status = 'cancelled' OR v_r1.quantity_returned <> 19
     OR v_r1.product_id <> v_prod
     OR v_r1.sale_id <> (SELECT id FROM sales WHERE invoice_number = 'INV20261112-27151') THEN
    RAISE EXCEPTION 'SR-20261112-17857-1 is not the 19 returned on INV20261112-27151 -- nothing changed';
  END IF;

  v_bad := ARRAY(SELECT id FROM sales_returns
                  WHERE return_number IN ('SR-20261112-82484-1', 'SR-20261112-10337-1')
                    AND customer_id = v_cust.id AND status <> 'cancelled' AND product_id = v_prod
                    AND sale_id = (SELECT id FROM sales WHERE invoice_number = 'INV20261112-57135'
                                      AND deleted_at IS NOT NULL));
  IF cardinality(v_bad) <> 2
     OR (SELECT sum(quantity_returned) FROM sales_returns WHERE id = ANY (v_bad)) <> 19 THEN
    RAISE EXCEPTION 'SR-20261112-82484-1 (2) and SR-20261112-10337-1 (17) on the reversed INV20261112-57135 were not both found -- nothing changed';
  END IF;

  IF v_uid IS NULL THEN
    v_uid := (SELECT ur.user_id FROM user_roles ur WHERE ur.role = 'super_admin'
               AND public._works_in_factory(ur.user_id, v_cust.factory_id) ORDER BY ur.user_id LIMIT 1);
  END IF;

  -- 1. The two wrong returns: cancelled (jugs undone by trigger), 19 off stock.
  UPDATE sales_returns
     SET status = 'cancelled',
         notes = COALESCE(notes || ' | ', '') || 'Cancelled 13 Nov: returned against the mistaken Jug + Water posting INV20261112-57135'
   WHERE id = ANY (v_bad);

  -- 2. INV20261113-16919 back to 140 with the 19 returned on it (as 27151 was).
  UPDATE sale_items SET quantity = 140, line_total = 140 * unit_price WHERE id = v_item.id;
  UPDATE sales_returns SET sale_id = v_sale.id WHERE id = v_r1.id;
  -- No jug entry: a Dispenser Water (swap) line moves no jugs.
  -- Stock is NOT touched here (13 Nov: live Dispenser Water stock was 32, so
  -- the -38 would have gone below zero) -- see the stock check separately.

  v_supplied := (SELECT sum(si.quantity) FROM sales s JOIN sale_items si ON si.sale_id = s.id
                  WHERE s.customer_id = v_cust.id AND s.sale_date = '2026-11-12' AND s.status = 'posted'
                    AND s.deleted_at IS NULL AND si.product_id = v_prod);
  v_returned := (SELECT sum(quantity_returned) FROM sales_returns
                  WHERE customer_id = v_cust.id AND return_date = '2026-11-12' AND status <> 'cancelled'
                    AND product_id = v_prod);
  IF v_supplied <> 440 OR v_returned <> 21 THEN
    RAISE EXCEPTION '12 Nov would read supplied % and returned %, not 440 and 21 -- nothing changed', v_supplied, v_returned;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_cust.factory_id, 'correct_warehouse_posting', 'customers', 'hmedix-12nov-440-less-21',
          jsonb_build_object('customer', v_cust.name, 'INV20261113-16919', 121, 'returned_12nov', 40,
                             'cancelled', jsonb_build_array('SR-20261112-82484-1', 'SR-20261112-10337-1')),
          jsonb_build_object('INV20261113-16919', 140, 'supplied_12nov', v_supplied, 'returned_12nov', v_returned,
                             'stock', 0, 'reason', '440 supplied, 19 + 2 returned (user, 13 Nov)'));

  RAISE NOTICE 'H MEDIX 12 Nov: supplied %, returned %, can return %. Stock and money unchanged.',
    v_supplied, v_returned, v_supplied - v_returned;
END $$;
