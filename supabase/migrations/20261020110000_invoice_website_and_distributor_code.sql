-- ============================================================================
-- Marketer / distributor invoice: company website and distributor IDs
-- ----------------------------------------------------------------------------
-- The printed invoice for marketer and distributor sales (src/lib/
-- distributor-invoice.ts) carries the company website under the contact
-- lines, and a "Marketer/Distributor ID":
--   marketer     sales_reps.code (SR-01, SR-02, ... -- already generated)
--   distributor  customers.code, added here: DST-0001, DST-0002, ... per
--                factory, generated for every registered customer (on insert,
--                and when a walk-in record is later registered). Walk-in
--                records get no code.
-- Codes are never reused within a factory. Existing registered customers are
-- backfilled in the order they were added.
-- ============================================================================

-- ============ Company website (Settings → Company) ============
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS website text;

-- ============ Distributor ID ============
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS code text;
CREATE UNIQUE INDEX IF NOT EXISTS customers_factory_code_key
  ON public.customers (factory_id, code) WHERE code IS NOT NULL;

CREATE OR REPLACE FUNCTION public._next_customer_code(p_factory uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_next integer;
BEGIN
  -- One numbering at a time per factory, so two inserts can't take the same code.
  PERFORM pg_advisory_xact_lock(hashtext('customers_code:' || p_factory::text));
  SELECT COALESCE(MAX(substring(code FROM 5)::integer), 0) + 1
    INTO v_next
    FROM customers
   WHERE factory_id = p_factory AND code ~ '^DST-[0-9]+$';
  RETURN 'DST-' || lpad(v_next::text, 4, '0');
END;
$$;
REVOKE ALL ON FUNCTION public._next_customer_code(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_customer_code()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.code := OLD.code;  -- never edited by hand
  END IF;
  IF NEW.registered AND (NEW.code IS NULL OR btrim(NEW.code) = '') THEN
    NEW.code := public._next_customer_code(NEW.factory_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_set_code ON public.customers;
CREATE TRIGGER customers_set_code BEFORE INSERT OR UPDATE OF registered, code ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_customer_code();

-- ============ Backfill ============
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, factory_id FROM customers
     WHERE registered AND (code IS NULL OR btrim(code) = '')
     ORDER BY created_at, ctid
  LOOP
    UPDATE customers SET code = public._next_customer_code(r.factory_id) WHERE id = r.id;
  END LOOP;
END
$$;
