-- ============================================================================
-- No minimum quantity on a sale -- Retail or Warehouse
-- ----------------------------------------------------------------------------
-- User (2026-10-29): "no minimum limit to what retail and warehouse can sale,
-- make sure of that in the code or the system". The Warehouse could not post
-- fewer than 5 packs to a distributor. Nothing in the app or in these
-- migrations sets such a minimum (a 1-pack posting passes the tests), so if
-- the live database refuses it, the rule was added there directly.
--
-- _drop_sale_minimums() removes such a rule wherever it can sit on a sale:
--   * a CHECK constraint on sale_items / sales that holds a quantity to more
--     than "> 0" (e.g. quantity >= 5);
--   * a trigger on sale_items / sales whose function refuses a quantity
--     below a number (quantity < 5, qty < 5, "minimum"...).
-- Only those are dropped; the normal "quantity > 0" check and every other
-- trigger stay. Each removal is written to the audit log and shown as a
-- NOTICE in the SQL Editor. Run once now; safe to run again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._drop_sale_minimums()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_dropped jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
     WHERE c.conrelid IN ('public.sale_items'::regclass, 'public.sales'::regclass)
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ~* '(quantity|qty)'
       AND pg_get_constraintdef(c.oid) !~* '^CHECK \(\(?(quantity|qty) > \(?0(\)::numeric)?\)?\)$'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    v_dropped := v_dropped || jsonb_build_object('kind', 'constraint', 'table', r.tbl, 'name', r.conname, 'definition', r.def);
    RAISE NOTICE 'Dropped constraint % on %: %', r.conname, r.tbl, r.def;
  END LOOP;

  FOR r IN
    SELECT t.tgrelid::regclass::text AS tbl, t.tgname, p.proname
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid IN ('public.sale_items'::regclass, 'public.sales'::regclass)
       AND NOT t.tgisinternal
       AND (p.prosrc ~* '(quantity|qty)[^;]{0,40}<=?\s*\(?[2-9][0-9]*'
            OR p.prosrc ~* 'minimum\s+(per|order|quantity|qty|of)')
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', r.tgname, r.tbl);
    v_dropped := v_dropped || jsonb_build_object('kind', 'trigger', 'table', r.tbl, 'name', r.tgname, 'function', r.proname);
    RAISE NOTICE 'Dropped trigger % on % (function %)', r.tgname, r.tbl, r.proname;
  END LOOP;

  IF jsonb_array_length(v_dropped) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), NULL, 'drop_sale_minimums', 'sales', NULL,
            jsonb_build_object('dropped', v_dropped, 'reason', 'No minimum quantity on Retail or Warehouse sales'));
  ELSE
    RAISE NOTICE 'No minimum-quantity rule found on sales -- nothing to remove';
  END IF;
  RETURN v_dropped;
END;
$$;
REVOKE ALL ON FUNCTION public._drop_sale_minimums() FROM PUBLIC, anon, authenticated;

SELECT public._drop_sale_minimums();
