-- ============================================================================
-- Process Material: blown bottles from QC are the PM's raw material
-- ----------------------------------------------------------------------------
-- User request (2026-10-29): the blown bottles QC sends to the Production
-- Manager must appear in the material dropdown of Production → Process
-- Material → Add New Process Material. They are now raw material to the PM,
-- which she processes into finished Bottle Water.
--
-- production_material_reports.product_id: the bottle product a line is about
--   (material_id stays the Store raw material; a line has exactly one).
-- production_material_options(p_factory) now also returns the blown-bottle
--   products (semi-finished, or any product QC has sent to the PM), with
--   kind = 'bottle' (Store materials: 'material'), the balance their last
--   line ended on, and received_since = bottles the PM received from QC
--   (bottle_transfers received / discrepancy, test data excluded) after that
--   last line -- the Qty In a new line starts with. The return type changes,
--   so the function is dropped and re-created.
-- save_production_material_report: a new line gives material_id or
--   product_id; the bottle must be of the factory and a blown bottle.
--   Edits are unchanged.
-- ============================================================================

ALTER TABLE public.production_material_reports
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES public.products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS production_material_reports_product_idx
  ON public.production_material_reports (product_id, report_date DESC, created_at DESC);

-- A blown bottle the PM processes: semi-finished, or sent to the PM by QC.
CREATE OR REPLACE FUNCTION public._pm_bottle_product(p_product uuid, p_factory uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM products p
     WHERE p.id = p_product AND p.factory_id = p_factory
       AND (p.product_type = 'semi_finished'
            OR EXISTS (SELECT 1 FROM bottle_transfers t WHERE t.product_id = p.id)));
$$;
REVOKE ALL ON FUNCTION public._pm_bottle_product(uuid, uuid) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.production_material_options(uuid);
CREATE FUNCTION public.production_material_options(p_factory uuid)
RETURNS TABLE(material_id uuid, material_name text, unit text, last_balance numeric, detail text,
              kind text, received_since numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT x.id, x.name, x.unit, x.last_balance, x.detail, x.kind, x.received_since
    FROM (
      SELECT rm.id, rm.name, rm.unit,
             COALESCE((SELECT r.balance FROM production_material_reports r
                        WHERE r.material_id = rm.id
                        ORDER BY r.report_date DESC, r.created_at DESC LIMIT 1), 0) AS last_balance,
             NULLIF(concat_ws(' · ', b.name,
                              CASE WHEN rm.grams_per_piece IS NOT NULL THEN trim(to_char(rm.grams_per_piece, 'FM990.0')) || 'g' END,
                              s.name), '') AS detail,
             'material'::text AS kind, 0::numeric AS received_since,
             1 AS grp, b.name AS b_name, s.name AS s_name
        FROM raw_materials rm
        LEFT JOIN brands b ON b.id = rm.brand_id
        LEFT JOIN suppliers s ON s.id = rm.supplier_id
       WHERE rm.factory_id = p_factory AND rm.active
      UNION ALL
      SELECT p.id, p.name, p.unit,
             COALESCE(last.balance, 0),
             'Blown bottle from QC',
             'bottle'::text,
             COALESCE((SELECT SUM(t.quantity_received) FROM bottle_transfers t
                        WHERE t.product_id = p.id AND t.status IN ('received', 'discrepancy')
                          AND NOT COALESCE(t.test_cleared, false)
                          AND (last.created_at IS NULL OR t.received_at > last.created_at)), 0),
             0, NULL, NULL
        FROM products p
        LEFT JOIN LATERAL (SELECT r.balance, r.created_at FROM production_material_reports r
                            WHERE r.product_id = p.id
                            ORDER BY r.report_date DESC, r.created_at DESC LIMIT 1) last ON true
       WHERE p.factory_id = p_factory AND p.active AND public._pm_bottle_product(p.id, p_factory)
    ) x
   ORDER BY x.grp, x.name, x.b_name NULLS LAST, x.s_name NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION public.production_material_options(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_material_options(uuid) TO authenticated;

-- As 20261028260000, plus lines for blown bottles (product_id).
CREATE OR REPLACE FUNCTION public.save_production_material_report(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'report_date', '')::date, CURRENT_DATE);
  v_line jsonb;
  v_mat raw_materials%ROWTYPE;
  v_prod products%ROWTYPE;
  v_row production_material_reports%ROWTYPE;
  v_n int := 0;
  v_item_name text; v_item_unit text; v_mat_id uuid; v_prod_id uuid;
  n_open numeric; n_in numeric; n_used numeric; n_dmg numeric; n_rep numeric;
BEGIN
  SELECT COALESCE(full_name, email) INTO v_name FROM profiles WHERE id = v_uid;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'A report can''t be dated in the future'; END IF;

  -- Edit one row.
  IF payload ? 'id' THEN
    IF NOT (public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key)
            OR public.has_permission(v_uid, 'production'::module_key, 'create'::action_key)) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    SELECT * INTO v_row FROM production_material_reports WHERE id = (payload->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Report line not found'; END IF;
    n_open := COALESCE(NULLIF(payload->>'opening', '')::numeric, v_row.opening);
    n_in := COALESCE(NULLIF(payload->>'qty_in', '')::numeric, v_row.qty_in);
    n_used := COALESCE(NULLIF(payload->>'qty_used', '')::numeric, v_row.qty_used);
    n_dmg := COALESCE(NULLIF(payload->>'damages', '')::numeric, v_row.damages);
    n_rep := COALESCE(NULLIF(payload->>'replaced', '')::numeric, v_row.replaced);
    IF LEAST(n_open, n_in, n_used, n_dmg, n_rep) < 0 THEN RAISE EXCEPTION 'Quantities can''t be negative'; END IF;
    IF n_open + n_in - n_used - n_dmg + n_rep < 0 THEN
      RAISE EXCEPTION '% can''t end below 0: used and damaged are more than opening + in + replaced', v_row.material_name;
    END IF;
    UPDATE production_material_reports
       SET opening = n_open, qty_in = n_in, qty_used = n_used, damages = n_dmg, replaced = n_rep,
           report_date = COALESCE(NULLIF(payload->>'report_date', '')::date, report_date),
           remarks = CASE WHEN payload ? 'remarks' THEN NULLIF(btrim(payload->>'remarks'), '') ELSE remarks END,
           updated_at = now()
     WHERE id = v_row.id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_row.factory_id, 'edit', 'production_material_reports', v_row.id::text, to_jsonb(v_row),
            jsonb_build_object('opening', n_open, 'qty_in', n_in, 'qty_used', n_used, 'damages', n_dmg, 'replaced', n_rep));
    RETURN jsonb_build_object('edited', 1);
  END IF;

  -- Add rows.
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF payload->'lines' IS NULL OR jsonb_array_length(payload->'lines') = 0 THEN
    RAISE EXCEPTION 'Add at least one material';
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(payload->'lines') LOOP
    v_mat_id := NULL; v_prod_id := NULL;
    IF NULLIF(v_line->>'product_id', '') IS NOT NULL THEN
      SELECT * INTO v_prod FROM products WHERE id = (v_line->>'product_id')::uuid;
      IF NOT FOUND OR NOT public._pm_bottle_product(v_prod.id, v_factory) THEN
        RAISE EXCEPTION 'Pick a blown bottle QC sends to Production';
      END IF;
      v_prod_id := v_prod.id; v_item_name := v_prod.name; v_item_unit := v_prod.unit;
    ELSE
      SELECT * INTO v_mat FROM raw_materials WHERE id = NULLIF(v_line->>'material_id', '')::uuid;
      IF NOT FOUND OR v_mat.factory_id <> v_factory THEN RAISE EXCEPTION 'Pick a material in every line'; END IF;
      v_mat_id := v_mat.id; v_item_name := v_mat.name; v_item_unit := v_mat.unit;
    END IF;
    n_open := COALESCE(NULLIF(v_line->>'opening', '')::numeric, 0);
    n_in := COALESCE(NULLIF(v_line->>'qty_in', '')::numeric, 0);
    n_used := COALESCE(NULLIF(v_line->>'qty_used', '')::numeric, 0);
    n_dmg := COALESCE(NULLIF(v_line->>'damages', '')::numeric, 0);
    n_rep := COALESCE(NULLIF(v_line->>'replaced', '')::numeric, 0);
    IF LEAST(n_open, n_in, n_used, n_dmg, n_rep) < 0 THEN RAISE EXCEPTION 'Quantities can''t be negative'; END IF;
    IF n_open + n_in - n_used - n_dmg + n_rep < 0 THEN
      RAISE EXCEPTION '% can''t end below 0: used and damaged are more than opening + in + replaced', v_item_name;
    END IF;
    INSERT INTO production_material_reports (factory_id, report_date, material_id, product_id, material_name, unit,
                                             opening, qty_in, qty_used, damages, replaced, remarks,
                                             created_by, created_by_name)
    VALUES (v_factory, v_date, v_mat_id, v_prod_id, v_item_name, v_item_unit, n_open, n_in, n_used, n_dmg, n_rep,
            NULLIF(btrim(v_line->>'remarks'), ''), v_uid, v_name);
    v_n := v_n + 1;
  END LOOP;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create', 'production_material_reports', v_date::text,
          jsonb_build_object('lines', payload->'lines', 'report_date', v_date));
  RETURN jsonb_build_object('added', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.save_production_material_report(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_production_material_report(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
