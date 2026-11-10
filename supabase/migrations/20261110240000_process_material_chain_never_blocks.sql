-- ============================================================================
-- Process Material: a day already on its own Opening no longer blocks edits
-- ----------------------------------------------------------------------------
-- User (2026-11-10): adjusting a 50cl Bottle line was refused with
-- "50cl Bottle on 02 Nov 2026 would end below 0 (opening 18509 + in 0 - used
-- 47020) -- change that day too". _pm_rechain (20261104180000) walks a
-- material's whole chain on every save and refused when any later day could
-- not take the carried balance. 2 Nov was entered on its own Opening (used
-- 47,020 with nothing in) and never followed the chain, so no 50cl Bottle
-- line on any day could be saved.
--
-- Now:
--   * the chain still carries each balance to the next day wherever it can;
--   * a day that was following the chain and that THIS change would push
--     below 0 -- the saved line itself, or a later day tied to it by days
--     that were all following the chain -- is still refused, naming the day;
--   * a day already standing on its own Opening (not following the chain
--     before this change) that can't take the carried balance keeps its own
--     Opening, like a stock count, and the chain carries on from it.
-- ============================================================================

-- p_changed / p_old_balance: the line just saved and its balance before the
-- save (NULL for a new line or one moved to another day -- it is then left
-- out when telling which later days were following the chain).
CREATE OR REPLACE FUNCTION public._pm_rechain(p_factory uuid, p_material uuid, p_product uuid, p_name text,
                                              p_changed uuid, p_old_balance numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_prev numeric;          -- carried balance, new figures
  v_was numeric;           -- previous line's balance before this change
  v_first boolean := true;
  v_linked boolean;
  v_downstream boolean := false;  -- tied to the saved line by unbroken links
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
    v_linked := v_was IS NOT NULL AND r.opening = v_was;
    v_downstream := r.id = p_changed OR (v_downstream AND v_linked);
    -- Before-change balance of this line, for the next line's check.
    IF r.id IS DISTINCT FROM p_changed THEN
      v_was := r.opening + r.qty_in - r.qty_used + r.replaced;
    ELSIF p_old_balance IS NOT NULL THEN
      v_was := p_old_balance;
    END IF;

    IF NOT v_first AND r.opening IS DISTINCT FROM v_prev THEN
      IF v_prev + r.qty_in - r.qty_used + r.replaced >= 0 THEN
        UPDATE production_material_reports SET opening = v_prev, updated_at = now() WHERE id = r.id;
        r.opening := v_prev;
      ELSIF v_downstream AND v_linked THEN
        RAISE EXCEPTION '% on % would end below 0 (opening % + in % - used %) -- change that day too',
          r.material_name, to_char(r.report_date, 'DD Mon YYYY'), trim_scale(v_prev), trim_scale(r.qty_in),
          trim_scale(r.qty_used);
      END IF;
      -- else: own Opening stands; carry on from it.
    END IF;
    v_prev := r.opening + r.qty_in - r.qty_used + r.replaced;
    v_first := false;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public._pm_rechain(uuid, uuid, uuid, text, uuid, numeric) FROM PUBLIC, anon, authenticated;

-- Old entry point: a re-link with no line just saved.
CREATE OR REPLACE FUNCTION public._pm_rechain(p_factory uuid, p_material uuid, p_product uuid, p_name text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._pm_rechain(p_factory, p_material, p_product, p_name, NULL::uuid, NULL::numeric);
$$;
REVOKE ALL ON FUNCTION public._pm_rechain(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._pm_rechain_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Its own updates (openings) re-enter here: the chain is already in line.
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  PERFORM public._pm_rechain(NEW.factory_id, NEW.material_id, NEW.product_id, NEW.material_name, NEW.id,
    CASE WHEN TG_OP = 'UPDATE' AND OLD.report_date = NEW.report_date
         THEN OLD.opening + OLD.qty_in - OLD.qty_used + OLD.replaced END);
  RETURN NULL;
END;
$$;

-- Once now, every material: those skipped before re-link as far as they can.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT DISTINCT factory_id, material_id, product_id,
                  CASE WHEN material_id IS NULL AND product_id IS NULL THEN material_name END AS name
             FROM production_material_reports LOOP
    PERFORM public._pm_rechain(c.factory_id, c.material_id, c.product_id, c.name);
  END LOOP;
END $$;
