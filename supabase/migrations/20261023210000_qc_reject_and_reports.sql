-- ============================================================================
-- Quality Control: reject what the Store issued, and the QC reports
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-23):
--
-- 1. QC can reject stock the Store issued to it (Quality Control → Received
--    from Store), with a reason. A rejected issue never becomes QC's stock:
--    the quantity goes back into the Store at the cost it left with, as a
--    'returned' line on the material's ledger carrying the reason.
--    (Preforms issued for blowing already have Accept / Reject with a note,
--    Good bottles → Preforms received; unchanged.)
--
-- 2. Reports as the factory prints them, for a period:
--    qc_preform_report  per preform: From Store (bags received), pieces per
--                       bag, Opening, Total (= opening + received), Blown
--                       (preforms used), Damages (damaged preforms + damaged
--                       bottles + other losses), Expected Bottles (= blown -
--                       damages, the good bottles stocked) and Balance
--                       (= total - blown, preforms still held).
--    qc_bottle_report   per bottle: Opening, Quantity In (good bottles
--                       stocked), Total, Released (sent to production) and
--                       Balance.
--    Both read the existing preform ledger, stockings and transfers; nothing
--    is typed in for them. Only the good bottles are ever stocked.
-- ============================================================================

-- ---------- 1. Reject an issue ----------
ALTER TABLE public.qc_store_receipts DROP CONSTRAINT IF EXISTS qc_store_receipts_status_check;
ALTER TABLE public.qc_store_receipts
  ADD CONSTRAINT qc_store_receipts_status_check CHECK (status IN ('pending', 'confirmed', 'rejected')),
  ADD COLUMN IF NOT EXISTS reject_reason text,
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

-- The ledger line for stock coming back: 'returned' (a movement_type value
-- the raw-material ledger did not allow until now).
ALTER TABLE public.raw_material_movements DROP CONSTRAINT IF EXISTS raw_material_movements_movement_type_check;
ALTER TABLE public.raw_material_movements ADD CONSTRAINT raw_material_movements_movement_type_check
  CHECK (movement_type IN ('received','issued','adjusted','transferred','damaged','used_for_production',
                           'opening_balance','return_from_production','expiry','correction','returned'));

CREATE OR REPLACE FUNCTION public.qc_reject_store_receipt(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_r qc_store_receipts%ROWTYPE;
  v_mv raw_material_movements%ROWTYPE;
  v_m raw_materials%ROWTYPE;
  v_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Give the reason for rejecting it'; END IF;
  SELECT * INTO v_r FROM qc_store_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_r.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_r.status <> 'pending' THEN
    RAISE EXCEPTION 'This issue is already %', CASE v_r.status WHEN 'confirmed' THEN 'confirmed as received' ELSE v_r.status END;
  END IF;
  IF v_r.issued_by = v_uid THEN
    RAISE EXCEPTION 'You issued this stock -- someone in Quality Control decides whether to accept it';
  END IF;

  SELECT * INTO v_mv FROM raw_material_movements WHERE id = v_r.movement_id;
  SELECT * INTO v_m FROM raw_materials WHERE id = v_r.material_id FOR UPDATE;
  v_cost := COALESCE(v_mv.unit_cost, v_m.unit_cost, 0);

  -- Back into the Store at the cost it left with.
  UPDATE raw_materials SET
    current_stock = current_stock + v_r.quantity,
    current_value = current_value + v_r.quantity * v_cost,
    updated_at = now()
  WHERE id = v_r.material_id;
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                     quantity_before, quantity_after)
  VALUES (v_r.factory_id, v_r.material_id, 'returned', v_r.quantity, v_cost, COALESCE(v_mv.reference, 'QC rejection'),
          'Rejected by Quality Control: ' || v_reason, v_uid, v_m.current_stock, v_m.current_stock + v_r.quantity);

  UPDATE qc_store_receipts SET status = 'rejected', reject_reason = v_reason, rejected_by = v_uid, rejected_at = now()
   WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_r.factory_id, 'qc_reject_store_receipt', 'qc_store_receipts', p_id::text,
          jsonb_build_object('material_id', v_r.material_id, 'quantity', v_r.quantity, 'reason', v_reason,
                             'store_stock_after', v_m.current_stock + v_r.quantity));
  RETURN jsonb_build_object('id', p_id, 'rejected', true, 'store_stock', v_m.current_stock + v_r.quantity);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_reject_store_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_reject_store_receipt(uuid, text) TO authenticated;

-- ---------- 2a. Preform report ----------
CREATE OR REPLACE FUNCTION public.qc_preform_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE (
  material_id uuid, material text, brand text, grammage text, pieces_per_bag numeric,
  received numeric, received_bags numeric, opening numeric, total numeric, blown numeric,
  damages numeric, expected_bottles numeric, balance numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._pf_can('view')
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  RETURN QUERY
  WITH mv AS (
    SELECT x.material_id,
           SUM(x.quantity) FILTER (WHERE x.effective_date < p_from) AS opening,
           SUM(x.quantity) FILTER (WHERE x.effective_date BETWEEN p_from AND p_to
                                     AND x.movement_type IN ('issue_in', 'issue_reversed')) AS received,
           -SUM(x.quantity) FILTER (WHERE x.effective_date BETWEEN p_from AND p_to
                                      AND x.movement_type IN ('good_bottles', 'damaged_preforms', 'damaged_bottles',
                                                              'other_losses', 'usage_reversed')) AS blown,
           -SUM(x.quantity) FILTER (WHERE x.effective_date BETWEEN p_from AND p_to
                                      AND x.movement_type IN ('damaged_preforms', 'damaged_bottles', 'other_losses')) AS damages
      FROM preform_movements x
     WHERE x.factory_id = p_factory AND x.effective_date <= p_to
     GROUP BY x.material_id
  )
  SELECT m.id, m.name, b.name, b.grammage, m.pieces_per_bag,
         COALESCE(mv.received, 0),
         CASE WHEN m.pieces_per_bag > 0 THEN round(COALESCE(mv.received, 0) / m.pieces_per_bag, 2) END,
         COALESCE(mv.opening, 0),
         COALESCE(mv.opening, 0) + COALESCE(mv.received, 0),
         COALESCE(mv.blown, 0),
         COALESCE(mv.damages, 0),
         COALESCE(mv.blown, 0) - COALESCE(mv.damages, 0),
         COALESCE(mv.opening, 0) + COALESCE(mv.received, 0) - COALESCE(mv.blown, 0)
    FROM mv
    JOIN raw_materials m ON m.id = mv.material_id
    LEFT JOIN brands b ON b.id = m.brand_id
   ORDER BY m.name, b.name NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_preform_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_preform_report(uuid, date, date) TO authenticated;

-- ---------- 2b. Bottles report ----------
-- In = good bottles stocked (accepted stockings); Released = sent to
-- production (transfers not cancelled or reversed). Dates are Nigeria time.
CREATE OR REPLACE FUNCTION public.qc_bottle_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE (
  product_id uuid, product text, opening numeric, quantity_in numeric, total numeric, released numeric, balance numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._pf_can('view')
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  RETURN QUERY
  WITH moves AS (
    SELECT s.product_id, (COALESCE(s.received_at, s.sent_at) AT TIME ZONE 'Africa/Lagos')::date AS d,
           COALESCE(s.accepted_qty, 0) AS qty
      FROM preform_stockings s
     WHERE s.factory_id = p_factory AND s.status = 'accepted'
    UNION ALL
    SELECT t.product_id, (t.sent_at AT TIME ZONE 'Africa/Lagos')::date, -t.quantity_sent
      FROM bottle_transfers t
     WHERE t.factory_id = p_factory AND t.status NOT IN ('cancelled', 'reversed')
  ), agg AS (
    SELECT mo.product_id,
           COALESCE(SUM(mo.qty) FILTER (WHERE mo.d < p_from), 0) AS opening,
           COALESCE(SUM(mo.qty) FILTER (WHERE mo.d BETWEEN p_from AND p_to AND mo.qty > 0), 0) AS qty_in,
           COALESCE(-SUM(mo.qty) FILTER (WHERE mo.d BETWEEN p_from AND p_to AND mo.qty < 0), 0) AS released
      FROM moves mo
     WHERE mo.d <= p_to
     GROUP BY mo.product_id
  )
  SELECT p.id, p.name, a.opening, a.qty_in, a.opening + a.qty_in, a.released, a.opening + a.qty_in - a.released
    FROM agg a JOIN products p ON p.id = a.product_id
   ORDER BY p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_bottle_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_bottle_report(uuid, date, date) TO authenticated;

-- ---------- Confirm only what is still waiting ----------
-- As 20261023180000, plus: a rejected issue cannot be confirmed afterwards.
CREATE OR REPLACE FUNCTION public.qc_confirm_store_receipt(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_r qc_store_receipts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_r FROM qc_store_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_r.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_r.status = 'confirmed' THEN
    RETURN jsonb_build_object('id', p_id, 'confirmed', true, 'already', true);
  END IF;
  IF v_r.status = 'rejected' THEN
    RAISE EXCEPTION 'This issue was rejected and went back to the Store';
  END IF;
  IF v_r.issued_by = v_uid THEN
    RAISE EXCEPTION 'You issued this stock -- someone in Quality Control confirms receiving it';
  END IF;
  UPDATE qc_store_receipts SET status = 'confirmed', confirmed_by = v_uid, confirmed_at = now() WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_r.factory_id, 'qc_confirm_store_receipt', 'qc_store_receipts', p_id::text,
          jsonb_build_object('material_id', v_r.material_id, 'quantity', v_r.quantity));
  RETURN jsonb_build_object('id', p_id, 'confirmed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_confirm_store_receipt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_confirm_store_receipt(uuid) TO authenticated;
