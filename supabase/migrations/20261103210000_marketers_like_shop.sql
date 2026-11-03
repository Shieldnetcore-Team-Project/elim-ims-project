-- ============================================================================
-- Marketers like the shop: Dispenser Water at N1,200, a jug not returned owed
-- ----------------------------------------------------------------------------
-- User (2026-11-03), rule A: "Dispenser Water is N1,200" for marketers too.
-- Until now (20261101100000) a marketer's dispenser was posted at water +
-- jug (N4,200, a trigger) and each empty QC counted back credited the jug
-- (N3,000). Now, as at the shop:
--   * a dispenser is posted to a marketer at its Costing price (N1,200):
--     trg_marketer_jug_line_price is dropped;
--   * an empty brought back and counted by QC clears the jug -- no money
--     credit (verify_jug_return, credit_price left empty);
--   * a jug that went out and has not come back (in an unsold dispenser or
--     as a counted empty) is owed at the jug's price -- the empty-jug product
--     on Costing (Dispenser Empty, N3,000): rep_account_summary.jugs_owed /
--     jugs_owed_value, added to the balance owed.
-- The switch-over keeps every balance as it was: marketers' dispenser
-- postings and returns go to the Costing price (reprice_posted_lines) and the
-- old N3,000 credits come off. A jug back: N4,200 - N3,000 before = N1,200
-- now; a jug not back: N4,200 before = N1,200 + N3,000 now.
-- ============================================================================

-- 1. Postings at the Costing price.
DROP TRIGGER IF EXISTS trg_marketer_jug_line_price ON public.stock_dispatch_items;

-- 2. Empties: no money credit (as 20261102150000, credit left empty).
CREATE OR REPLACE FUNCTION public.verify_jug_return(p_id uuid, p_received numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_j jug_returns%ROWTYPE;
  v_rep sales_reps%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_name text;
  v_can_hold numeric;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_type container_types%ROWTYPE;
  v_credit numeric;
BEGIN
  -- QC counts the empties the Warehouse recorded (user, 2026-11-01).
  IF NOT (public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key)
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only Quality Control counts returned jugs';
  END IF;
  SELECT * INTO v_j FROM jug_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  IF v_j.status <> 'pending' THEN RAISE EXCEPTION 'Return % is already %', v_j.reference, v_j.status; END IF;
  IF v_j.recorded_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Someone other than the person who recorded % must count and confirm it', v_j.reference;
  END IF;
  IF p_received IS NULL OR p_received < 0 OR p_received <> trunc(p_received) THEN
    RAISE EXCEPTION 'Enter the whole number of jugs counted (0 if none arrived)';
  END IF;
  IF p_received > v_j.quantity_claimed THEN
    RAISE EXCEPTION 'Counted % but the Warehouse recorded % -- the Warehouse records the extra jugs as a new return',
      trim_scale(p_received), trim_scale(v_j.quantity_claimed);
  END IF;
  IF p_received <> v_j.quantity_claimed AND v_note IS NULL THEN
    RAISE EXCEPTION 'The count differs from the % claimed -- say why', trim_scale(v_j.quantity_claimed);
  END IF;

  IF v_j.sales_rep_id IS NOT NULL THEN
    SELECT * INTO v_rep FROM sales_reps WHERE id = v_j.sales_rep_id FOR UPDATE;
    v_name := v_rep.full_name;
    v_can_hold := public._jug_rep_balance(v_j.sales_rep_id, v_j.container_type_id)
                - public._jug_rep_full(v_j.sales_rep_id, v_j.container_type_id);
  ELSE
    SELECT * INTO v_cust FROM customers WHERE id = v_j.customer_id FOR UPDATE;
    v_name := v_cust.name;
    v_can_hold := public._jug_customer_balance(v_j.customer_id, v_j.container_type_id);
  END IF;
  IF p_received > GREATEST(v_can_hold, 0) THEN
    RAISE EXCEPTION '% owes only % empty jugs -- more than that cannot be received from them. Record an opening balance first if they really held more.',
      v_name, trim_scale(GREATEST(v_can_hold, 0));
  END IF;

  IF p_received > 0 THEN
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                    source, reference, notes, created_by)
    VALUES (v_j.factory_id, v_j.container_type_id,
            CASE WHEN v_j.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'customer' END,
            COALESCE(v_j.sales_rep_id, v_j.customer_id), 'warehouse', NULL, p_received,
            'return', v_j.reference, COALESCE(v_note, v_j.notes), v_uid);
  END IF;
  -- A marketer is credited the jug price for each jug counted back; the
  -- shop and a customer are not.
  SELECT * INTO v_type FROM container_types WHERE id = v_j.container_type_id;
  -- Rule A (2026-11-03): an empty brought back clears the jug, it is not
  -- money -- the marketer was charged water only, and a jug not brought
  -- back is charged on their account (rep_account_summary).
  v_credit := NULL;
  UPDATE jug_returns SET status = 'verified', quantity_received = p_received, verified_by = v_uid,
         verified_at = now(), verify_note = v_note, credit_price = v_credit
   WHERE id = p_id;

  -- The counted jugs are QC's from here: an accepted consignment, which QC
  -- verifies (good / damaged) and posts to the PM as usual.
  IF p_received > 0 THEN
    INSERT INTO qc_jug_batches (factory_id, reference, jug_kind, quantity_sent, send_notes, sent_by, sent_at,
                                status, quantity_accepted, accept_note, accepted_by, accepted_at, jug_return_id)
    VALUES (v_j.factory_id, v_j.reference, CASE WHEN v_type.name ~* 'old' THEN 'old' ELSE 'new' END,
            v_j.quantity_claimed, 'From ' || v_name || COALESCE(' -- ' || v_j.notes, ''),
            v_j.recorded_by, v_j.recorded_at, 'accepted', p_received, v_note, v_uid, now(), v_j.id)
    ON CONFLICT (reference) DO NOTHING;
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_j.factory_id, 'verify_jug_return', 'jug_returns', p_id::text,
          jsonb_build_object('claimed', v_j.quantity_claimed),
          jsonb_build_object('received', p_received, 'note', v_note));
  RETURN jsonb_build_object('reference', v_j.reference, 'received', p_received,
                            'short', v_j.quantity_claimed - p_received);
END;
$$;

-- 3. The balance: jugs not brought back are owed (as 20261101100000, plus that).
CREATE OR REPLACE FUNCTION public.rep_account_summary(p_sales_rep_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_goods_out numeric := 0;
  v_accepted numeric := 0;
  v_written_off numeric := 0;
  v_damaged numeric := 0;
  v_rejected numeric := 0;
  v_cash numeric := 0;
  v_credit numeric := 0;
  v_collected numeric := 0;
  v_van_value numeric := 0;
  v_sales_count int := 0;
  v_sales_value numeric := 0;
  v_jugs_back numeric := 0;
  v_jugs_value numeric := 0;
  v_jugs_owed numeric := 0;
  v_jugs_owed_value numeric := 0;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT COALESCE(SUM(sdi.line_value), 0) INTO v_goods_out
  FROM stock_dispatch_items sdi
  JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
  WHERE sd.sales_rep_id = p_sales_rep_id AND sd.status = 'posted'
    AND (p_from IS NULL OR sd.dispatch_date >= p_from)
    AND (p_to   IS NULL OR sd.dispatch_date <= p_to);

  SELECT
    COALESCE(SUM(COALESCE(rri.accepted_quantity,0) * rri.unit_price), 0),
    COALESCE(SUM(CASE WHEN NOT rri.charge_rep THEN (rri.damaged_quantity + rri.rejected_quantity) * rri.unit_price ELSE 0 END), 0),
    COALESCE(SUM(rri.damaged_quantity * rri.unit_price), 0),
    COALESCE(SUM(rri.rejected_quantity * rri.unit_price), 0)
  INTO v_accepted, v_written_off, v_damaged, v_rejected
  FROM rep_return_items rri
  JOIN rep_returns rr ON rr.id = rri.rep_return_id
  WHERE rr.sales_rep_id = p_sales_rep_id AND rr.status = 'completed'
    AND (p_from IS NULL OR rr.return_date >= p_from)
    AND (p_to   IS NULL OR rr.return_date <= p_to);

  SELECT COALESCE(SUM(amount), 0) INTO v_cash
  FROM rep_remittances
  WHERE sales_rep_id = p_sales_rep_id
    AND (p_from IS NULL OR remittance_date >= p_from)
    AND (p_to   IS NULL OR remittance_date <= p_to);

  SELECT COALESCE(SUM(outstanding), 0) INTO v_credit
  FROM debts
  WHERE sales_rep_id = p_sales_rep_id AND status <> 'paid';

  v_collected := public._rep_credit_collected(p_sales_rep_id);

  -- Empty jugs QC counted back from the marketer, each credited at the jug
  -- price of the day it was counted (20261101100000).
  SELECT COALESCE(SUM(j.quantity_received), 0), COALESCE(SUM(j.quantity_received * j.credit_price), 0)
    INTO v_jugs_back, v_jugs_value
    FROM jug_returns j
   WHERE j.sales_rep_id = p_sales_rep_id AND j.status = 'verified' AND j.credit_price IS NOT NULL
     AND (p_from IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
     AND (p_to   IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date <= p_to);

  -- Rule A (2026-11-03): every jug that went out with a posting and has not
  -- come back -- in an unsold dispenser or as an empty QC counted -- is owed
  -- at the jug's price (the empty-jug product on Costing).
  WITH moves AS (
    SELECT pj.container_type_id AS t, sdi.quantity * pj.per_unit AS q
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_sales_rep_id AND sd.status = 'posted'
       AND (p_from IS NULL OR sd.dispatch_date >= p_from)
       AND (p_to   IS NULL OR sd.dispatch_date <= p_to)
    UNION ALL
    SELECT pj.container_type_id, -COALESCE(rri.accepted_quantity, 0) * pj.per_unit
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.sales_rep_id = p_sales_rep_id AND rr.status = 'completed'
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_to   IS NULL OR rr.return_date <= p_to)
    UNION ALL
    SELECT j.container_type_id, -j.quantity_received
      FROM jug_returns j
     WHERE j.sales_rep_id = p_sales_rep_id AND j.status = 'verified'
       AND (p_from IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date >= p_from)
       AND (p_to   IS NULL OR (j.verified_at AT TIME ZONE 'Africa/Lagos')::date <= p_to)
  ), per AS (
    SELECT t, GREATEST(SUM(q), 0) AS owed FROM moves GROUP BY t
  )
  SELECT COALESCE(SUM(per.owed), 0), COALESCE(SUM(per.owed * COALESCE(e.unit_price, ct.jar_price, 0)), 0)
    INTO v_jugs_owed, v_jugs_owed_value
    FROM per
    JOIN container_types ct ON ct.id = per.t
    LEFT JOIN LATERAL public._jug_empty_product(ct.id, ct.factory_id) e ON true;

  SELECT COALESCE(SUM(rs.quantity * p.unit_price), 0) INTO v_van_value
  FROM rep_stock rs JOIN products p ON p.id = rs.product_id
  WHERE rs.sales_rep_id = p_sales_rep_id;

  SELECT COUNT(*), COALESCE(SUM(grand_total), 0) INTO v_sales_count, v_sales_value
  FROM sales
  WHERE sales_rep_id = p_sales_rep_id
    AND status = 'posted' AND deleted_at IS NULL AND NOT COALESCE(is_pr, false)
    AND (p_from IS NULL OR sale_date >= p_from)
    AND (p_to   IS NULL OR sale_date <= p_to);

  RETURN jsonb_build_object(
    'goods_out_value', v_goods_out,
    'accepted_returns_value', v_accepted + v_written_off,
    'accepted_only_value', v_accepted,
    'written_off_value', v_written_off,
    'damaged_value', v_damaged,
    'rejected_value', v_rejected,
    'cash_remitted', v_cash,
    'credit_outstanding', v_credit,
    'credit_collected', v_collected,
    'van_stock_value', v_van_value,
    'sales_count', v_sales_count,
    'sales_value', v_sales_value,
    'empty_jugs_returned', v_jugs_back,
    'empty_jugs_value', v_jugs_value,
    'jugs_owed', v_jugs_owed,
    'jugs_owed_value', v_jugs_owed_value,
    'net_balance_owed', v_goods_out - (v_accepted + v_written_off) - v_jugs_value + v_jugs_owed_value
                        - v_cash - v_credit - v_collected
  );
END;
$$;

-- 4. The switch-over, once: dispenser postings and returns to the Costing
--    price, the old jug credits off (audit-logged).
DO $$
DECLARE v_p uuid; v_n int;
BEGIN
  FOR v_p IN
    SELECT DISTINCT pc.product_id FROM public.product_containers pc
      JOIN public.products p ON p.id = pc.product_id
     WHERE COALESCE(pc.jug_role, 'with_water') <> 'empty'
  LOOP
    PERFORM public.reprice_posted_lines(v_p, 'Rule A: dispenser at its Costing price; jugs not returned owed', false);
  END LOOP;
  WITH x AS (
    UPDATE public.jug_returns j SET credit_price = NULL
      FROM public.sales_reps r
     WHERE r.id = j.sales_rep_id AND r.kind = 'rep' AND j.credit_price IS NOT NULL
    RETURNING j.id, j.factory_id, j.reference
  )
  SELECT count(*) INTO v_n FROM x;
  IF v_n > 0 THEN
    INSERT INTO public.audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    SELECT NULL, f.id, 'rule_a_jug_credits_removed', 'jug_returns', 'rule_a',
           jsonb_build_object('count', v_n, 'reason', 'Empties clear the jug; a jug not returned is owed instead')
      FROM public.factories f LIMIT 1;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
