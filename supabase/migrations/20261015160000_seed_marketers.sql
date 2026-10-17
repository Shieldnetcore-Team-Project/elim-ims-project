-- ============================================================================
-- The company's marketers
-- ----------------------------------------------------------------------------
-- Seeds the water factory's marketers as active sales_reps (kind 'rep'), so
-- they appear in every marketer dropdown: Warehouse "Post → Marketers", the
-- distributor's "Under marketer", Customers → Marketer, Cash Ledger
-- "Collected by marketer", Bottle Tracking, and Performance & Commission.
--
-- seed_marketers() skips a name the factory already has (case-insensitive),
-- so it is safe to re-run; go_live_reset.sql runs it after wiping.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_marketers()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_factory uuid;
  v_added integer;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN RETURN 0; END IF;
  INSERT INTO sales_reps (factory_id, full_name, status, kind)
  SELECT v_factory, n.full_name, 'active', 'rep'
    FROM unnest(ARRAY[
           'Abiodun', 'Godwin', 'Emma', 'Malla', 'Sunday', 'Courage', 'Abacha',
           'Christopher Ayuba'
         ]) WITH ORDINALITY AS n(full_name, ord)
   WHERE NOT EXISTS (
           SELECT 1 FROM sales_reps r
            WHERE r.factory_id = v_factory AND lower(trim(r.full_name)) = lower(n.full_name))
   ORDER BY n.ord;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_added;
END;
$$;
REVOKE ALL ON FUNCTION public.seed_marketers() FROM PUBLIC, anon, authenticated;

SELECT public.seed_marketers();
