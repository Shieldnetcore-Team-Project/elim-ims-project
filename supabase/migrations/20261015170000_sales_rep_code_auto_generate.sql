-- ============================================================================
-- SALES REPS / OUTLETS: AUTO-GENERATE CODE
-- ----------------------------------------------------------------------------
-- The rep code was free text that had to be typed in (and collided on
-- UNIQUE (factory_id, code)). Generate it on insert instead, numbered per
-- factory and kind:
--   rep     SR-01, SR-02, ...
--   outlet  OUTLET-01, OUTLET-02, ...  (matches seed_retail_outlet's OUTLET-01)
-- The next number follows the highest existing one, so codes are never reused
-- within a factory. A BEFORE INSERT trigger (same shape as employees_set_code
-- in 20260913100000) covers every insert path: Distribution → Reps & Outlets,
-- Warehouse "Post → Marketers → New marketer", and seed_marketers().
--
-- Existing rows without a code are backfilled in the order they were added.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._next_sales_rep_code(p_factory uuid, p_kind text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prefix text := CASE WHEN p_kind = 'outlet' THEN 'OUTLET-' ELSE 'SR-' END;
  v_next integer;
BEGIN
  -- One numbering at a time per factory, so two inserts can't take the same code.
  PERFORM pg_advisory_xact_lock(hashtext('sales_reps_code:' || p_factory::text));
  SELECT COALESCE(MAX(substring(code FROM length(v_prefix) + 1)::integer), 0) + 1
    INTO v_next
    FROM sales_reps
   WHERE factory_id = p_factory
     AND code ~ ('^' || v_prefix || '[0-9]+$');
  RETURN v_prefix || lpad(v_next::text, 2, '0');
END;
$$;
REVOKE ALL ON FUNCTION public._next_sales_rep_code(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_sales_rep_code()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.code IS NULL OR btrim(NEW.code) = '' THEN
    NEW.code := public._next_sales_rep_code(NEW.factory_id, NEW.kind);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_reps_set_code ON public.sales_reps;
CREATE TRIGGER sales_reps_set_code BEFORE INSERT ON public.sales_reps
  FOR EACH ROW EXECUTE FUNCTION public.set_sales_rep_code();

-- ============ Backfill ============
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, factory_id, kind FROM sales_reps
     WHERE code IS NULL OR btrim(code) = ''
     ORDER BY created_at, ctid
  LOOP
    UPDATE sales_reps SET code = public._next_sales_rep_code(r.factory_id, r.kind)
     WHERE id = r.id;
  END LOOP;
END
$$;
