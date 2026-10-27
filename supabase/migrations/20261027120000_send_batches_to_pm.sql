-- ============================================================================
-- QC sends to PM by batch
-- ----------------------------------------------------------------------------
-- The user (2026-10-27): QC sends to PM in batches -- every blowing she
-- finishes is sent as it is, all of it at once. Send to production now lists
-- each finished blowing (batch) whose good bottles have not all gone to PM,
-- ticked with what is left of it, and one click sends them all.
--
-- bottle_transfers.shift_record_id: the batch a transfer carries (NULL for
--   transfers from before this, and for "earlier stock" sent without one).
-- pf_unsent_batches(factory): per finished, stocked batch what is still to
--   send = stocked good bottles - live transfers of it (dispatched, received,
--   discrepancy). Capped by the bottle's stock, newest batches first (older
--   ones may have gone to PM before batches were tracked). Whatever stock no
--   batch accounts for comes back as one "earlier stock" row per bottle.
-- dispatch_bottle_transfer: takes an optional shift_record_id; the batch must
--   be finished, of this bottle and factory, and not over-sent.
-- ============================================================================

ALTER TABLE public.bottle_transfers
  ADD COLUMN IF NOT EXISTS shift_record_id uuid REFERENCES public.preform_shift_records(id);
CREATE INDEX IF NOT EXISTS idx_bottle_transfers_batch ON public.bottle_transfers (shift_record_id)
  WHERE shift_record_id IS NOT NULL;

-- Good bottles of a batch already with PM (or on the way).
CREATE OR REPLACE FUNCTION public._pf_batch_sent(p_record uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(quantity_sent), 0) FROM bottle_transfers
   WHERE shift_record_id = p_record AND status IN ('dispatched', 'received', 'discrepancy');
$$;
REVOKE ALL ON FUNCTION public._pf_batch_sent(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pf_unsent_batches(p_factory uuid)
RETURNS TABLE(
  shift_record_id uuid, reference text, production_date date, shift text, preform text,
  product_id uuid, product text, stocked numeric, sent numeric, to_send numeric, current_stock numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._pf_can('post') OR public._pf_can('confirm')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT (public._works_in_factory(auth.uid(), p_factory) OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  WITH b AS (
    SELECT r.id, r.reference, r.production_date, r.shift, m.name AS preform, m.grams_per_piece,
           s.product_id, SUM(s.accepted_qty) AS stocked, public._pf_batch_sent(r.id) AS sent,
           max(r.completed_at) AS done_at
      FROM preform_shift_records r
      JOIN preform_stockings s ON s.shift_record_id = r.id AND s.status = 'accepted' AND NOT s.test_cleared
      JOIN raw_materials m ON m.id = r.material_id
     WHERE r.factory_id = p_factory AND r.status = 'completed' AND NOT r.test_cleared
     GROUP BY r.id, r.reference, r.production_date, r.shift, m.name, m.grams_per_piece, s.product_id
  ), open_b AS (
    SELECT b.*, b.stocked - b.sent AS left_qty FROM b WHERE b.stocked - b.sent > 0
  ), capped AS (
    -- Newest batches take the stock first.
    SELECT o.*, p.name AS product, p.current_stock,
           GREATEST(LEAST(o.left_qty,
                          p.current_stock - COALESCE(SUM(o.left_qty) OVER (
                            PARTITION BY o.product_id ORDER BY o.done_at DESC, o.reference DESC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)), 0) AS to_send
      FROM open_b o JOIN products p ON p.id = o.product_id
  ), loose AS (
    SELECT p.id AS product_id, p.name AS product, p.current_stock,
           p.current_stock - COALESCE((SELECT SUM(c.to_send) FROM capped c WHERE c.product_id = p.id), 0) AS to_send
      FROM products p
     WHERE p.factory_id = p_factory AND p.active AND p.current_stock > 0
       AND public._pf_is_bottle_product(p.id, p.product_type::text)
  )
  SELECT c.id, c.reference, c.production_date, c.shift,
         c.preform || COALESCE(' ' || trim(to_char(c.grams_per_piece, 'FM999990.##')) || 'g', ''),
         c.product_id, c.product::text, c.stocked, c.sent, c.to_send, c.current_stock
    FROM capped c WHERE c.to_send > 0
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, NULL, l.product_id, l.product::text, NULL, NULL, l.to_send, l.current_stock
    FROM loose l WHERE l.to_send > 0
  ORDER BY 3 DESC NULLS LAST, 2 DESC NULLS LAST, 7;
END;
$$;
REVOKE ALL ON FUNCTION public.pf_unsent_batches(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pf_unsent_batches(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.dispatch_bottle_transfer(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_product uuid := (payload->>'product_id')::uuid;
  v_record uuid := NULLIF(payload->>'shift_record_id', '')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_req numeric := NULLIF(payload->>'quantity_requested', '')::numeric;
  v_shift text := NULLIF(payload->>'shift', '');
  v_prod_ref text := NULLIF(btrim(COALESCE(payload->>'production_reference', '')), '');
  v_dept text := NULLIF(btrim(COALESCE(payload->>'to_department', '')), '');
  v_p products%ROWTYPE;
  v_r preform_shift_records%ROWTYPE;
  v_stocked numeric;
  v_ref text;
  v_id uuid;
  v_existing bottle_transfers%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('post') OR public._pf_can('confirm')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM bottle_transfers WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the receiving department'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole quantity above 0'; END IF;
  IF v_req IS NOT NULL AND (v_req <= 0 OR v_req <> trunc(v_req)) THEN
    RAISE EXCEPTION 'The quantity requested is a whole number above 0';
  END IF;
  IF v_req IS NOT NULL AND v_qty > v_req THEN
    RAISE EXCEPTION 'You are issuing % but only % were requested', v_qty, v_req;
  END IF;
  IF v_shift IS NOT NULL AND v_shift NOT IN ('day', 'night') THEN RAISE EXCEPTION 'Pick the shift (day or night)'; END IF;
  SELECT * INTO v_p FROM products WHERE id = v_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

  IF v_record IS NOT NULL THEN
    SELECT * INTO v_r FROM preform_shift_records WHERE id = v_record FOR UPDATE;
    IF NOT FOUND OR v_r.factory_id <> v_p.factory_id OR v_r.test_cleared THEN RAISE EXCEPTION 'Batch not found'; END IF;
    IF v_r.status <> 'completed' THEN RAISE EXCEPTION 'Batch % is not finished (%)', v_r.reference, v_r.status; END IF;
    SELECT COALESCE(SUM(accepted_qty), 0) INTO v_stocked FROM preform_stockings
     WHERE shift_record_id = v_record AND product_id = v_product AND status = 'accepted';
    IF v_stocked = 0 THEN RAISE EXCEPTION 'Batch % did not make %', v_r.reference, v_p.name; END IF;
    IF v_qty > v_stocked - public._pf_batch_sent(v_record) THEN
      RAISE EXCEPTION 'Batch % has only % bottles left to send', v_r.reference, v_stocked - public._pf_batch_sent(v_record);
    END IF;
    v_prod_ref := COALESCE(v_prod_ref, v_r.reference);
  END IF;

  v_ref := public._pf_ref('BTR');
  PERFORM public._pf_product_move(v_product, -v_qty, 'transferred', v_ref, 'Transfer to ' || v_dept);
  INSERT INTO bottle_transfers(factory_id, reference, client_ref, product_id, to_department, quantity_sent,
                               quantity_requested, shift, production_reference, notes, sent_by, shift_record_id)
  VALUES (v_p.factory_id, v_ref, v_client, v_product, v_dept, v_qty, v_req, v_shift, v_prod_ref,
          NULLIF(btrim(COALESCE(payload->>'notes', '')), ''), auth.uid(), v_record)
  RETURNING id INTO v_id;
  PERFORM public._pf_audit(v_p.factory_id, 'dispatch_bottle_transfer', 'bottle_transfers', v_id, NULL,
                           jsonb_build_object('reference', v_ref, 'to', v_dept, 'quantity', v_qty,
                                              'requested', v_req, 'shift', v_shift, 'production_reference', v_prod_ref,
                                              'batch', v_r.reference));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_bottle_transfer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_bottle_transfer(jsonb) TO authenticated;
