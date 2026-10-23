-- ============================================================================
-- Store stock counts and adjustments without approval
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-23): like restocking (20261023120000), a stock
-- count or adjustment of a raw material on the Store page -- Raw Materials →
-- Adjust Stock, Preform Inventory → stock count / opening balance -- adds to
-- or takes from stock at once. No second person approves or posts it.
--
--   * request_stock_adjustment: a raw-material adjustment is recorded and
--     posted in the same transaction (stock and value, ledger line, damage
--     record for a damaged write-off, workflow trail, audit row). It no longer
--     raises an "awaiting approval" notification. Finished goods (Warehouse)
--     keep their approval.
--   * request_stock_count: the opening-balance cost goes in with the request,
--     so the opening balance is valued at it when posted at once.
--   * The raw-material adjustments already waiting are posted now, except a
--     count whose material's stock has moved since it was counted (its
--     variance would be stale -- the Store cancels and counts again). Their
--     "awaiting approval" notifications are marked read.
-- Who may adjust is unchanged: raw-materials submit (the Store, Inventory
-- Officer). Stock cannot go below zero.
-- ============================================================================

-- ---------- 1. Post a raw-material adjustment (internal) ----------
CREATE OR REPLACE FUNCTION public._post_raw_material_adjustment(p_id uuid, p_actor uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req stock_adjustment_requests%ROWTYPE;
  v_before numeric; v_before_value numeric; v_unit_cost numeric; v_unit text; v_move_cost numeric;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.entity_type <> 'raw_material' THEN RAISE EXCEPTION 'Not a raw material adjustment'; END IF;
  IF v_req.status NOT IN ('pending_approval', 'approved') THEN
    RAISE EXCEPTION 'Adjustment % is already %', v_req.reference_number, v_req.status;
  END IF;

  SELECT current_stock, current_value, unit_cost, unit INTO v_before, v_before_value, v_unit_cost, v_unit
    FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
  IF v_before + v_req.quantity_delta < 0 THEN
    RAISE EXCEPTION 'Stock cannot go below zero (% in stock, adjustment %)', v_before, v_req.quantity_delta;
  END IF;
  IF v_req.quantity_delta >= 0 THEN
    v_move_cost := COALESCE(v_req.unit_cost, v_unit_cost);
  ELSE
    v_move_cost := public.avg_unit_cost(v_before_value, v_before, v_unit_cost);
  END IF;

  UPDATE raw_materials SET
    current_stock = current_stock + v_req.quantity_delta,
    current_value = v_before_value + v_req.quantity_delta * v_move_cost,
    updated_at = now()
  WHERE id = v_req.material_id;
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id,
                                     quantity_before, quantity_after)
  VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_move_cost,
          COALESCE(v_req.reference_number, 'Stock adjustment'), COALESCE(v_req.reason, 'Stock adjustment'), p_actor,
          v_before, v_before + v_req.quantity_delta);

  IF v_req.movement_type = 'damaged' THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, material_id, quantity, unit,
                               unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0'),
            'INVENTORY', p_id::text, v_req.material_id, abs(v_req.quantity_delta), v_unit, v_move_cost,
            v_req.reason, v_req.submitted_by, p_actor, 'posted');
  END IF;

  UPDATE stock_adjustment_requests SET status = 'posted', reviewed_by = p_actor, reviewed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('raw-materials', p_id, 'post', v_req.status::workflow_status, 'posted',
                                        COALESCE(p_comment, 'Posted by the Store, no approval needed'));
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (p_actor, v_req.factory_id, 'post_stock_adjustment', 'raw_material', v_req.material_id::text,
          jsonb_build_object('current_stock', v_before),
          jsonb_build_object('current_stock', v_before + v_req.quantity_delta, 'reference', v_req.reference_number,
                             'without_approval', true));
  RETURN jsonb_build_object('posted', true, 'current_stock', v_before + v_req.quantity_delta);
END;
$$;
REVOKE ALL ON FUNCTION public._post_raw_material_adjustment(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------- 2. request_stock_adjustment: raw materials post at once ----------
-- As 20260826090000, plus an optional unit_cost, and a raw-material
-- adjustment is posted straight away.
CREATE OR REPLACE FUNCTION public.request_stock_adjustment(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_entity_type text := payload->>'entity_type';
  v_material_id uuid := NULLIF(payload->>'material_id','')::uuid;
  v_product_id uuid := NULLIF(payload->>'product_id','')::uuid;
  v_delta numeric := (payload->>'quantity_delta')::numeric;
  v_movement_type text := COALESCE(payload->>'movement_type', 'adjusted');
  v_reason text := btrim(COALESCE(payload->>'reason', ''));
  v_cost numeric := NULLIF(payload->>'unit_cost', '')::numeric;
  v_factory uuid; v_id uuid; v_module public.module_key; v_number text; v_item_name text; v_post jsonb;
BEGIN
  IF v_entity_type NOT IN ('raw_material','finished_good') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_delta IS NULL OR v_delta = 0 THEN RAISE EXCEPTION 'quantity_delta must be non-zero'; END IF;
  IF v_reason = '' THEN RAISE EXCEPTION 'A reason is required for a stock adjustment'; END IF;
  IF lower(v_reason) IN ('adjustment','adjust','adjusted','n/a','na','misc','miscellaneous','other','stock adjustment','correction') THEN
    RAISE EXCEPTION 'Reason must be a meaningful explanation, not just "%"', v_reason;
  END IF;
  IF length(v_reason) < 5 THEN RAISE EXCEPTION 'Reason is too short — provide a meaningful explanation'; END IF;
  IF v_cost IS NOT NULL AND v_cost < 0 THEN RAISE EXCEPTION 'Unit cost cannot be negative'; END IF;
  v_module := CASE v_entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;

  IF v_entity_type = 'raw_material' THEN
    IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id, name INTO v_factory, v_item_name FROM raw_materials WHERE id = v_material_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found'; END IF;
  ELSE
    IF NOT public.has_permission(v_uid, 'finished-goods'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
    SELECT factory_id, name INTO v_factory, v_item_name FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  END IF;

  v_number := 'ADJ-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO stock_adjustment_requests(factory_id, reference_number, entity_type, material_id, product_id, quantity_delta,
                                        movement_type, reason, submitted_by, status, unit_cost)
  VALUES (v_factory, v_number, v_entity_type, v_material_id, v_product_id, v_delta, v_movement_type, v_reason, v_uid,
          'pending_approval', v_cost)
  RETURNING id INTO v_id;
  PERFORM public.record_workflow_action(v_module, v_id, 'submit', NULL, 'pending_approval', v_reason);

  IF v_entity_type = 'raw_material' THEN
    v_post := public._post_raw_material_adjustment(v_id, v_uid);
    RETURN jsonb_build_object('id', v_id, 'reference_number', v_number, 'posted', true,
                              'current_stock', v_post->'current_stock');
  END IF;

  INSERT INTO notifications(factory_id, title, body)
  VALUES (v_factory, 'Stock adjustment awaiting approval',
          v_number || ' — ' || COALESCE(v_item_name, 'item') || ' (' || (CASE WHEN v_delta > 0 THEN '+' ELSE '' END) || v_delta || ') — ' || v_reason);

  RETURN jsonb_build_object('id', v_id, 'reference_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_stock_adjustment(jsonb) TO authenticated;

-- ---------- 3. request_stock_count: cost goes in with the request ----------
-- As 20261020190000, but the opening-balance cost is passed to
-- request_stock_adjustment (which now posts at once) instead of being set on
-- the request afterwards.
CREATE OR REPLACE FUNCTION public.request_stock_count(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_material uuid := NULLIF(payload->>'material_id', '')::uuid;
  v_kind text := COALESCE(NULLIF(payload->>'kind', ''), 'count');
  v_counted numeric := NULLIF(payload->>'counted_quantity', '')::numeric;
  v_bags numeric := NULLIF(payload->>'counted_bags', '')::numeric;
  v_loose numeric := NULLIF(payload->>'counted_loose', '')::numeric;
  v_ref text := NULLIF(btrim(COALESCE(payload->>'supporting_reference', '')), '');
  v_reason text := btrim(COALESCE(payload->>'reason', ''));
  v_cost numeric := NULLIF(payload->>'unit_cost', '')::numeric;
  v_ppb numeric := NULLIF(payload->>'counted_pieces_per_bag', '')::numeric;
  v_m raw_materials%ROWTYPE;
  v_pending text;
  v_delta numeric;
  v_res jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_kind NOT IN ('count', 'opening_balance') THEN RAISE EXCEPTION 'Unknown count type %', v_kind; END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = v_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;

  IF v_bags IS NOT NULL OR v_loose IS NOT NULL THEN
    -- Bags of another size (e.g. a second supplier's) can be counted with
    -- their own size; otherwise the specification's.
    v_ppb := COALESCE(v_ppb, v_m.pieces_per_bag);
    IF v_ppb IS NULL THEN RAISE EXCEPTION 'Set pieces per bag for % first', v_m.name; END IF;
    IF v_ppb <= 0 OR v_ppb <> trunc(v_ppb) THEN RAISE EXCEPTION 'Pieces per bag must be a whole number above 0'; END IF;
    v_bags := COALESCE(v_bags, 0);
    v_loose := COALESCE(v_loose, 0);
    IF COALESCE(v_bags, 0) < 0 OR COALESCE(v_loose, 0) < 0
       OR COALESCE(v_bags, 0) <> trunc(COALESCE(v_bags, 0)) OR COALESCE(v_loose, 0) <> trunc(COALESCE(v_loose, 0)) THEN
      RAISE EXCEPTION 'Bags and loose pieces must be whole numbers';
    END IF;
    v_counted := v_bags * v_ppb + v_loose;
  ELSE
    v_ppb := NULL;
  END IF;
  IF v_counted IS NULL OR v_counted < 0 THEN RAISE EXCEPTION 'Enter the quantity physically counted'; END IF;
  IF v_m.is_preform AND v_counted <> trunc(v_counted) THEN RAISE EXCEPTION 'Preforms are counted in whole pieces'; END IF;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Give the count sheet or other supporting reference'; END IF;
  IF v_cost IS NOT NULL AND v_cost < 0 THEN RAISE EXCEPTION 'Unit cost cannot be negative'; END IF;
  IF v_kind = 'count' THEN v_cost := NULL; END IF;

  SELECT reference_number INTO v_pending FROM stock_adjustment_requests
   WHERE material_id = v_material AND adjustment_kind IS NOT NULL AND status IN ('pending_approval', 'approved')
   LIMIT 1;
  IF v_pending IS NOT NULL THEN
    RAISE EXCEPTION 'Count % for % is still awaiting approval -- finish or cancel it first', v_pending, v_m.name;
  END IF;
  IF v_kind = 'opening_balance' AND (
       EXISTS (SELECT 1 FROM raw_material_movements WHERE material_id = v_material AND movement_type = 'opening_balance')
       OR EXISTS (SELECT 1 FROM stock_adjustment_requests WHERE material_id = v_material
                    AND adjustment_kind = 'opening_balance' AND status = 'posted')) THEN
    RAISE EXCEPTION '% already has an opening balance -- record a physical count instead', v_m.name;
  END IF;

  v_delta := v_counted - v_m.current_stock;
  IF v_delta = 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (v_uid, v_m.factory_id, 'stock_count_matched', 'raw_materials', v_material::text,
            jsonb_build_object('counted', v_counted, 'system', v_m.current_stock, 'kind', v_kind, 'counted_bags', v_bags, 'counted_loose', v_loose, 'pieces_per_bag', v_ppb,
                               'supporting_reference', v_ref, 'reason', NULLIF(v_reason, '')));
    RETURN jsonb_build_object('variance', 0, 'request', false, 'system_quantity', v_m.current_stock);
  END IF;

  v_res := public.request_stock_adjustment(jsonb_build_object(
    'entity_type', 'raw_material', 'material_id', v_material, 'quantity_delta', v_delta,
    'movement_type', CASE v_kind WHEN 'opening_balance' THEN 'opening_balance' ELSE 'adjusted' END,
    'reason', v_reason, 'unit_cost', v_cost));
  UPDATE stock_adjustment_requests SET
    system_quantity = v_m.current_stock, counted_quantity = v_counted, supporting_reference = v_ref,
    unit_cost = v_cost, adjustment_kind = v_kind,
    counted_bags = v_bags, counted_loose = v_loose, counted_pieces_per_bag = v_ppb
  WHERE id = (v_res->>'id')::uuid;
  RETURN v_res || jsonb_build_object('variance', v_delta, 'request', true, 'system_quantity', v_m.current_stock);
END;
$$;
REVOKE ALL ON FUNCTION public.request_stock_count(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_stock_count(jsonb) TO authenticated;

-- ---------- 4. Post the raw-material adjustments already waiting ----------
-- Recorded as posted by whoever raised each one. A count whose material's
-- stock has moved since it was counted stays waiting (cancel and recount).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT q.id, q.submitted_by
      FROM stock_adjustment_requests q
      JOIN raw_materials m ON m.id = q.material_id
     WHERE q.entity_type = 'raw_material'
       AND q.status IN ('pending_approval', 'approved')
       AND (q.counted_quantity IS NULL OR q.system_quantity = m.current_stock)
       AND m.current_stock + q.quantity_delta >= 0
     ORDER BY q.submitted_at
  LOOP
    PERFORM public._post_raw_material_adjustment(r.id, r.submitted_by, 'Posted when Store approval was removed');
  END LOOP;
END $$;

-- Their "awaiting approval" notifications no longer need anyone.
UPDATE notifications n SET read = true
 WHERE n.read = false
   AND n.title = 'Stock adjustment awaiting approval'
   AND NOT EXISTS (
     SELECT 1 FROM stock_adjustment_requests q
      WHERE q.factory_id = n.factory_id
        AND q.reference_number = split_part(n.body, ' — ', 1)
        AND q.status IN ('pending_approval', 'approved'));
