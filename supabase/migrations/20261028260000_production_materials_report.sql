-- ============================================================================
-- Production: materials report (the Production Manager's raw-material register)
-- ----------------------------------------------------------------------------
-- The user asked (2026-10-28) for the Production page to have a tab where the
-- Production Manager records the raw materials she works with, like the
-- factory's paper "All Materials Report":
--   S/N, Material, Opening, Qty In, Total, Qty Used, Damages, Replaced,
--   Balance, Date/Time, Edit.
--
-- production_material_reports: one row per material per entry.
--   total   = opening + qty_in
--   balance = opening + qty_in - qty_used - damages + replaced
--   (replaced: damaged pieces made good again, e.g. by the supplier)
-- The material's name and unit are kept on the row, so the register reads
-- the same even for someone without Store (raw-materials) access.
--
-- production_material_options(p_factory): the active raw materials with the
-- balance on their last report -- the "Opening" a new entry starts from --
-- and a detail (brand · grams · supplier) that tells same-named materials
-- apart (the Store has many "Preform", "Bottle Cap", "Shrink Nylon").
-- save_production_material_report(payload): adds one or more rows, or edits
-- one ({id, ...}). Needs production create (adding) / create or edit
-- (editing). Quantities can't be negative, and a balance can't go below 0.
-- Every add and edit is audited.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.production_material_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  report_date date NOT NULL DEFAULT CURRENT_DATE,
  material_id uuid REFERENCES public.raw_materials(id) ON DELETE SET NULL,
  material_name text NOT NULL,
  unit text,
  opening numeric(14,3) NOT NULL DEFAULT 0 CHECK (opening >= 0),
  qty_in numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_in >= 0),
  qty_used numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_used >= 0),
  damages numeric(14,3) NOT NULL DEFAULT 0 CHECK (damages >= 0),
  replaced numeric(14,3) NOT NULL DEFAULT 0 CHECK (replaced >= 0),
  total numeric(14,3) GENERATED ALWAYS AS (opening + qty_in) STORED,
  balance numeric(14,3) GENERATED ALWAYS AS (opening + qty_in - qty_used - damages + replaced) STORED,
  remarks text,
  created_by uuid REFERENCES auth.users(id),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (opening + qty_in - qty_used - damages + replaced >= 0)
);
CREATE INDEX IF NOT EXISTS production_material_reports_factory_date_idx
  ON public.production_material_reports (factory_id, report_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS production_material_reports_material_idx
  ON public.production_material_reports (material_id, report_date DESC, created_at DESC);

GRANT SELECT ON public.production_material_reports TO authenticated;
GRANT ALL ON public.production_material_reports TO service_role;
ALTER TABLE public.production_material_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "production material reports read" ON public.production_material_reports;
CREATE POLICY "production material reports read" ON public.production_material_reports FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key));
-- No INSERT/UPDATE/DELETE policy: rows only change through the function below.

-- Materials to pick from, with the balance their last report ended on.
CREATE OR REPLACE FUNCTION public.production_material_options(p_factory uuid)
RETURNS TABLE(material_id uuid, material_name text, unit text, last_balance numeric, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT rm.id, rm.name, rm.unit,
         COALESCE((SELECT r.balance FROM production_material_reports r
                    WHERE r.material_id = rm.id
                    ORDER BY r.report_date DESC, r.created_at DESC LIMIT 1), 0),
         NULLIF(concat_ws(' · ', b.name,
                          CASE WHEN rm.grams_per_piece IS NOT NULL THEN trim(to_char(rm.grams_per_piece, 'FM990.0')) || 'g' END,
                          s.name), '')
    FROM raw_materials rm
    LEFT JOIN brands b ON b.id = rm.brand_id
    LEFT JOIN suppliers s ON s.id = rm.supplier_id
   WHERE rm.factory_id = p_factory AND rm.active
   ORDER BY rm.name, b.name NULLS LAST, s.name NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION public.production_material_options(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_material_options(uuid) TO authenticated;

-- Add rows: { factory_id, report_date?, lines: [{material_id, opening, qty_in,
-- qty_used, damages, replaced, remarks?}] }. Edit one: { id, opening, qty_in,
-- qty_used, damages, replaced, report_date?, remarks? }.
CREATE OR REPLACE FUNCTION public.save_production_material_report(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'report_date', '')::date, CURRENT_DATE);
  v_line jsonb;
  v_mat raw_materials%ROWTYPE;
  v_row production_material_reports%ROWTYPE;
  v_n int := 0;
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
    SELECT * INTO v_mat FROM raw_materials WHERE id = (v_line->>'material_id')::uuid;
    IF NOT FOUND OR v_mat.factory_id <> v_factory THEN RAISE EXCEPTION 'Pick a material in every line'; END IF;
    n_open := COALESCE(NULLIF(v_line->>'opening', '')::numeric, 0);
    n_in := COALESCE(NULLIF(v_line->>'qty_in', '')::numeric, 0);
    n_used := COALESCE(NULLIF(v_line->>'qty_used', '')::numeric, 0);
    n_dmg := COALESCE(NULLIF(v_line->>'damages', '')::numeric, 0);
    n_rep := COALESCE(NULLIF(v_line->>'replaced', '')::numeric, 0);
    IF LEAST(n_open, n_in, n_used, n_dmg, n_rep) < 0 THEN RAISE EXCEPTION 'Quantities can''t be negative'; END IF;
    IF n_open + n_in - n_used - n_dmg + n_rep < 0 THEN
      RAISE EXCEPTION '% can''t end below 0: used and damaged are more than opening + in + replaced', v_mat.name;
    END IF;
    INSERT INTO production_material_reports (factory_id, report_date, material_id, material_name, unit,
                                             opening, qty_in, qty_used, damages, replaced, remarks,
                                             created_by, created_by_name)
    VALUES (v_factory, v_date, v_mat.id, v_mat.name, v_mat.unit, n_open, n_in, n_used, n_dmg, n_rep,
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
