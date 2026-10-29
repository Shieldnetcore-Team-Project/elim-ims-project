-- ============================================================================
-- Process Material: Qty Used includes the damaged
-- ----------------------------------------------------------------------------
-- The user (2026-10-29): in Add New Process Material the PM enters the total
-- quantity used -- good and damaged together -- and the damaged ones in
-- Damages. Damages are part of Qty Used, not on top of it:
--   good used = qty_used - damages
--   balance   = opening + qty_in - qty_used + replaced
-- (before: balance = opening + qty_in - qty_used - damages + replaced, with
-- qty_used the good ones only).
--
-- Existing lines keep their balance: their damages are added into qty_used
-- (what they used in all), so opening + in - used + replaced is unchanged.
-- balance is a generated column, so it is dropped and re-added with the new
-- formula; the checks become balance >= 0 and damages <= qty_used.
-- save_production_material_report is as 20261029110000 with the new rule
-- (and plain assignments, for the Supabase SQL Editor). Safe to run once;
-- running it again would add damages into qty_used a second time, so it
-- stops if already applied.
-- ============================================================================

DO $$
DECLARE c text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.production_material_reports'::regclass
                AND conname = 'production_material_reports_damages_within_used') THEN
    RAISE NOTICE 'Already applied -- nothing changed';
    RETURN;
  END IF;

  -- The old balance check (opening + qty_in - qty_used - damages + replaced >= 0).
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.production_material_reports'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%qty_in%'
  LOOP
    EXECUTE format('ALTER TABLE public.production_material_reports DROP CONSTRAINT %I', c);
  END LOOP;

  ALTER TABLE public.production_material_reports DROP COLUMN balance;
  UPDATE public.production_material_reports SET qty_used = qty_used + damages WHERE damages > 0;
  ALTER TABLE public.production_material_reports
    ADD COLUMN balance numeric(14,3) GENERATED ALWAYS AS (opening + qty_in - qty_used + replaced) STORED;
  ALTER TABLE public.production_material_reports
    ADD CONSTRAINT production_material_reports_balance_not_negative
      CHECK (opening + qty_in - qty_used + replaced >= 0),
    ADD CONSTRAINT production_material_reports_damages_within_used
      CHECK (damages <= qty_used);
END $$;

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
  v_name := (SELECT COALESCE(full_name, email) FROM profiles WHERE id = v_uid);
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'A report can''t be dated in the future'; END IF;

  -- Edit one row.
  IF payload ? 'id' THEN
    IF NOT (public.has_permission(v_uid, 'production'::module_key, 'edit'::action_key)
            OR public.has_permission(v_uid, 'production'::module_key, 'create'::action_key)) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    PERFORM 1 FROM production_material_reports WHERE id = (payload->>'id')::uuid FOR UPDATE;
    v_row := (SELECT r FROM production_material_reports r WHERE r.id = (payload->>'id')::uuid);
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Report line not found'; END IF;
    n_open := COALESCE(NULLIF(payload->>'opening', '')::numeric, v_row.opening);
    n_in := COALESCE(NULLIF(payload->>'qty_in', '')::numeric, v_row.qty_in);
    n_used := COALESCE(NULLIF(payload->>'qty_used', '')::numeric, v_row.qty_used);
    n_dmg := COALESCE(NULLIF(payload->>'damages', '')::numeric, v_row.damages);
    n_rep := COALESCE(NULLIF(payload->>'replaced', '')::numeric, v_row.replaced);
    IF LEAST(n_open, n_in, n_used, n_dmg, n_rep) < 0 THEN RAISE EXCEPTION 'Quantities can''t be negative'; END IF;
    IF n_dmg > n_used THEN
      RAISE EXCEPTION '%: damaged (%) can''t be more than the total used (%)', v_row.material_name, n_dmg, n_used;
    END IF;
    IF n_open + n_in - n_used + n_rep < 0 THEN
      RAISE EXCEPTION '% can''t end below 0: more used than opening + in', v_row.material_name;
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
      v_prod := (SELECT p FROM products p WHERE p.id = (v_line->>'product_id')::uuid);
      IF v_prod.id IS NULL OR NOT public._pm_bottle_product(v_prod.id, v_factory) THEN
        RAISE EXCEPTION 'Pick a blown bottle QC sends to Production';
      END IF;
      v_prod_id := v_prod.id; v_item_name := v_prod.name; v_item_unit := v_prod.unit;
    ELSE
      v_mat := (SELECT m FROM raw_materials m WHERE m.id = NULLIF(v_line->>'material_id', '')::uuid);
      IF v_mat.id IS NULL OR v_mat.factory_id <> v_factory THEN RAISE EXCEPTION 'Pick a material in every line'; END IF;
      v_mat_id := v_mat.id; v_item_name := v_mat.name; v_item_unit := v_mat.unit;
    END IF;
    n_open := COALESCE(NULLIF(v_line->>'opening', '')::numeric, 0);
    n_in := COALESCE(NULLIF(v_line->>'qty_in', '')::numeric, 0);
    n_used := COALESCE(NULLIF(v_line->>'qty_used', '')::numeric, 0);
    n_dmg := COALESCE(NULLIF(v_line->>'damages', '')::numeric, 0);
    n_rep := COALESCE(NULLIF(v_line->>'replaced', '')::numeric, 0);
    IF LEAST(n_open, n_in, n_used, n_dmg, n_rep) < 0 THEN RAISE EXCEPTION 'Quantities can''t be negative'; END IF;
    IF n_dmg > n_used THEN
      RAISE EXCEPTION '%: damaged (%) can''t be more than the total used (%)', v_item_name, n_dmg, n_used;
    END IF;
    IF n_open + n_in - n_used + n_rep < 0 THEN
      RAISE EXCEPTION '% can''t end below 0: more used than opening + in', v_item_name;
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
