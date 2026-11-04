-- ============================================================================
-- Process Material: a change on an earlier day carries to the later days
-- ----------------------------------------------------------------------------
-- User (2026-11-04): "when material are processed for the previous [day], the
-- total balance is not changing -- on the 3rd qty used was changed to 40,000
-- and damaged 124 but the current total balance on the 4th is not changing".
--
-- Each line keeps its own Opening (copied from the last balance when it was
-- added), so editing an earlier line left every later Opening -- and so
-- every later Total and Balance -- as it was. Now each material's lines are
-- a chain, oldest first (day, then time entered): every line after the first
-- opens at the previous line's Balance. The chain is re-linked whenever a
-- line is added, edited or moved to another day (trigger), so a change on the
-- 3rd moves the 4th and every day after. A change that would leave a later
-- day below 0 is refused, naming that day.
-- Run once now for every material, so the figures already entered line up.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._pm_rechain(p_factory uuid, p_material uuid, p_product uuid, p_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_prev numeric;
  v_first boolean := true;
BEGIN
  FOR r IN
    SELECT id, report_date, opening, qty_in, qty_used, replaced, material_name
      FROM production_material_reports
     WHERE factory_id = p_factory
       AND CASE WHEN p_material IS NOT NULL THEN material_id = p_material
                WHEN p_product IS NOT NULL THEN product_id = p_product
                ELSE material_id IS NULL AND product_id IS NULL AND material_name = p_name END
     ORDER BY report_date, created_at, id
     FOR UPDATE
  LOOP
    IF NOT v_first AND r.opening IS DISTINCT FROM v_prev THEN
      IF v_prev + r.qty_in - r.qty_used + r.replaced < 0 THEN
        RAISE EXCEPTION '% on % would end below 0 (opening % + in % - used %) -- change that day too',
          r.material_name, to_char(r.report_date, 'DD Mon YYYY'), trim_scale(v_prev), trim_scale(r.qty_in),
          trim_scale(r.qty_used);
      END IF;
      UPDATE production_material_reports SET opening = v_prev, updated_at = now() WHERE id = r.id;
      r.opening := v_prev;
    END IF;
    v_prev := r.opening + r.qty_in - r.qty_used + r.replaced;
    v_first := false;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public._pm_rechain(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._pm_rechain_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Its own updates (openings) re-enter here: the chain is already in line.
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  PERFORM public._pm_rechain(NEW.factory_id, NEW.material_id, NEW.product_id, NEW.material_name);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_pm_rechain ON public.production_material_reports;
CREATE TRIGGER trg_pm_rechain
  AFTER INSERT OR UPDATE OF opening, qty_in, qty_used, damages, replaced, report_date
  ON public.production_material_reports
  FOR EACH ROW EXECUTE FUNCTION public._pm_rechain_trigger();

-- Once now, every material.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT DISTINCT factory_id, material_id, product_id,
                  CASE WHEN material_id IS NULL AND product_id IS NULL THEN material_name END AS name
             FROM production_material_reports LOOP
    BEGIN
      PERFORM public._pm_rechain(c.factory_id, c.material_id, c.product_id, c.name);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Not re-linked: %', SQLERRM;
    END;
  END LOOP;
END $$;
