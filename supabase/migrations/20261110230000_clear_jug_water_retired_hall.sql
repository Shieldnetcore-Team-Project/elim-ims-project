-- ============================================================================
-- Clear "Jug + Water (retired)" from the production hall (160 pieces)
-- ----------------------------------------------------------------------------
-- User (2026-11-10), Production page -> Available in the production hall:
-- "clear the 160 pieces in the system". The old Dispenser Jug+Water product
-- (now "Jug + Water (retired)") still shows 160 in the hall.
--
-- As every hall clearance (20261029120000): nothing is deleted -- one
-- production_hall_clearances row of exactly what that product has in the
-- hall, so its hall is 0. Warehouse stock, releases and every other product
-- are not touched. Audit-logged. Safe to re-run (a second run finds 0).
-- ============================================================================

DO $$
DECLARE
  p record;
  v_qty numeric;
BEGIN
  FOR p IN
    SELECT * FROM public.products
     WHERE lower(btrim(name)) LIKE 'jug + water (retired%'
        OR regexp_replace(lower(name), '\s', '', 'g') IN ('dispenserjug+water', 'dispenserwater+jug')
  LOOP
    v_qty := public._production_hall_available(p.factory_id, p.id);
    IF v_qty > 0 THEN
      INSERT INTO public.production_hall_clearances(factory_id, product_id, quantity, reason)
      VALUES (p.factory_id, p.id, v_qty,
              'Cleared on request (2026-11-10): the old Dispenser Jug+Water product, retired');
      INSERT INTO public.audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
      VALUES (NULL, p.factory_id, 'clear_production_hall', 'products', p.id::text,
              jsonb_build_object('product', p.name, 'cleared', v_qty,
                                 'reason', 'Clear the 160 pieces of Jug + Water (retired) in the hall'));
      RAISE NOTICE 'Cleared % of % from the production hall', v_qty, p.name;
    END IF;
  END LOOP;
END $$;
