-- ============================================================================
-- Marketers' empty jugs: Warehouse records, QC counts, the account balances
-- ----------------------------------------------------------------------------
-- User decisions (2026-11-01):
--   * A dispenser posted to a marketer goes on their account at the jug +
--     water price (container_types.with_jar_price, N4,200); each empty jug
--     QC counts back comes off at the jug price (jar_price, N3,000). Water-
--     only sales: they remit the water money and bring the jug; jug + water
--     sales: they remit N4,200. A jug neither paid for nor returned stays
--     owed on their account -- no separate charge.
--   * QC's count is final: the Warehouse records what the marketer (or the
--     shop) brought -- Record return, as before -- and hands the jugs to QC;
--     QC counts them (verify_jug_return, now QC's). The count moves the jugs
--     back into the factory's, credits the marketer, and becomes an
--     accepted QC consignment, which QC verifies and posts to the PM as
--     usual -- QC doesn't count twice.
--
--   stock_dispatch_items  a marketer's jug line is priced at with_jar_price
--                         (trigger), and the posting's total follows
--   rep_return_items      unsold full dispensers a marketer brings back are
--                         credited at the price of their latest posting of
--                         that product (trigger), so posting and return match
--   jug_returns.credit_price      the jug price credited, fixed when QC counts
--   qc_jug_batches.jug_return_id  the consignment made from that count
--   qc_pending_jug_returns        what QC has to count
--   rep_account_summary           empty_jugs_returned / _value, and the
--                                 balance owed less that value
-- ============================================================================

ALTER TABLE public.jug_returns ADD COLUMN IF NOT EXISTS credit_price numeric(14,2);
ALTER TABLE public.qc_jug_batches ADD COLUMN IF NOT EXISTS jug_return_id uuid REFERENCES public.jug_returns(id);

-- ============ 1. Prices on a marketer's postings and returns ============
CREATE OR REPLACE FUNCTION public._marketer_jug_line_price()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_kind text;
  v_jug record;
  v_old numeric := NEW.quantity * NEW.unit_price;
BEGIN
  v_kind := (SELECT r.kind FROM stock_dispatches d JOIN sales_reps r ON r.id = d.sales_rep_id WHERE d.id = NEW.dispatch_id);
  IF v_kind IS DISTINCT FROM 'rep' THEN RETURN NEW; END IF;
  SELECT * INTO v_jug FROM public._product_jug(NEW.product_id);
  IF v_jug.container_type_id IS NULL OR v_jug.with_jar_price IS NULL THEN RETURN NEW; END IF;
  NEW.unit_price := v_jug.with_jar_price * v_jug.per_unit;
  NEW.line_value := NEW.quantity * NEW.unit_price;
  UPDATE stock_dispatches SET total_value = COALESCE(total_value, 0) - v_old + NEW.line_value WHERE id = NEW.dispatch_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_marketer_jug_line_price ON public.stock_dispatch_items;
CREATE TRIGGER trg_marketer_jug_line_price BEFORE INSERT ON public.stock_dispatch_items
  FOR EACH ROW EXECUTE FUNCTION public._marketer_jug_line_price();

CREATE OR REPLACE FUNCTION public._marketer_jug_return_price()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_price numeric;
BEGIN
  SELECT r.* INTO v_rep FROM rep_returns rr JOIN sales_reps r ON r.id = rr.sales_rep_id WHERE rr.id = NEW.rep_return_id;
  IF v_rep.kind IS DISTINCT FROM 'rep' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public._product_jug(NEW.product_id)) THEN RETURN NEW; END IF;
  v_price := (SELECT i.unit_price FROM stock_dispatch_items i JOIN stock_dispatches d ON d.id = i.dispatch_id
               WHERE d.sales_rep_id = v_rep.id AND i.product_id = NEW.product_id AND d.status = 'posted'
               ORDER BY d.created_at DESC LIMIT 1);
  IF v_price IS NOT NULL THEN NEW.unit_price := v_price; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_marketer_jug_return_price ON public.rep_return_items;
CREATE TRIGGER trg_marketer_jug_return_price BEFORE INSERT ON public.rep_return_items
  FOR EACH ROW EXECUTE FUNCTION public._marketer_jug_return_price();

-- ============ 2. QC counts returned empties ============
-- As 20261020200000, but QC's (goods-receiving submit, as accepting a jug
-- consignment); not more than the Warehouse recorded; the marketer's jug
-- credit fixed; the counted jugs become QC's accepted consignment.
CREATE OR REPLACE FUNCTION public.verify_jug_return(p_id uuid, p_received numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_j jug_returns%ROWTYPE;
  v_rep sales_reps%ROWTYPE;
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
  SELECT * INTO v_rep FROM sales_reps WHERE id = v_j.sales_rep_id FOR UPDATE;
  v_can_hold := public._jug_rep_balance(v_j.sales_rep_id, v_j.container_type_id)
              - public._jug_rep_full(v_j.sales_rep_id, v_j.container_type_id);
  IF p_received > GREATEST(v_can_hold, 0) THEN
    RAISE EXCEPTION '% owes only % empty jugs -- more than that cannot be received from them. Record an opening balance first if they really held more.',
      v_rep.full_name, trim_scale(GREATEST(v_can_hold, 0));
  END IF;

  IF p_received > 0 THEN
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                    source, reference, notes, created_by)
    VALUES (v_j.factory_id, v_j.container_type_id, 'sales_rep', v_j.sales_rep_id, 'warehouse', NULL, p_received,
            'return', v_j.reference, COALESCE(v_note, v_j.notes), v_uid);
  END IF;
  -- A marketer is credited the jug price for each jug counted back; the
  -- shop is not (its money is the cash-up).
  SELECT * INTO v_type FROM container_types WHERE id = v_j.container_type_id;
  v_credit := CASE WHEN v_rep.kind = 'rep' THEN v_type.jar_price END;
  UPDATE jug_returns SET status = 'verified', quantity_received = p_received, verified_by = v_uid,
         verified_at = now(), verify_note = v_note, credit_price = v_credit
   WHERE id = p_id;

  -- The counted jugs are QC's from here: an accepted consignment, which QC
  -- verifies (good / damaged) and posts to the PM as usual.
  IF p_received > 0 THEN
    INSERT INTO qc_jug_batches (factory_id, reference, jug_kind, quantity_sent, send_notes, sent_by, sent_at,
                                status, quantity_accepted, accept_note, accepted_by, accepted_at, jug_return_id)
    VALUES (v_j.factory_id, v_j.reference, CASE WHEN v_type.name ~* 'old' THEN 'old' ELSE 'new' END,
            v_j.quantity_claimed, 'From ' || v_rep.full_name || COALESCE(' -- ' || v_j.notes, ''),
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
REVOKE ALL ON FUNCTION public.verify_jug_return(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_jug_return(uuid, numeric, text) TO authenticated;

-- What QC has to count: empties the Warehouse recorded from marketers and the
-- shop, oldest first.
CREATE OR REPLACE FUNCTION public.qc_pending_jug_returns(p_factory uuid)
RETURNS TABLE(id uuid, reference text, holder text, holder_kind text, jug text, quantity_claimed numeric,
              notes text, recorded_by uuid, recorded_by_name text, recorded_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._qc_jug_can_view() OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT j.id, j.reference, r.full_name::text, r.kind::text, ct.name::text, j.quantity_claimed, j.notes,
         j.recorded_by, COALESCE(NULLIF(p.full_name, ''), p.email)::text, j.recorded_at
    FROM jug_returns j
    JOIN sales_reps r ON r.id = j.sales_rep_id
    JOIN container_types ct ON ct.id = j.container_type_id
    LEFT JOIN profiles p ON p.id = j.recorded_by
   WHERE j.factory_id = p_factory AND j.status = 'pending'
   ORDER BY j.recorded_at;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_pending_jug_returns(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_pending_jug_returns(uuid) TO authenticated;

-- ============ 3. The marketer's account counts the jugs back ============
-- As 20260928160000, plus the empty jugs QC counted back at their credited
-- price, off the balance owed.
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
    'net_balance_owed', v_goods_out - (v_accepted + v_written_off) - v_jugs_value - v_cash - v_credit - v_collected
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.rep_account_summary(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
