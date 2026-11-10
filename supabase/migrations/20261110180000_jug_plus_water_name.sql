-- ============================================================================
-- "Dispenser Jug+Water" is renamed "Jug + Water" -- nothing else changes
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "there should be nothing like Dispenser Jug + Water,
-- lets just have Jug + Water in the entire system", then: "it should be there
-- but as Jug + Water ... so we can see the record for it daily".
--
-- Only the name changes: the product stays on every list (active as it is),
-- with its stock, postings, sales and daily records; all history shows the
-- new name. If an old unused product already holds the name "Jug + Water"
-- (one name per factory), that one is renamed "Jug + Water (old)" first.
-- The dispenser product assignment (Gideon, 'dispenser|jug water') also
-- matches "Jug + Water", so he keeps seeing it.
-- Audit-logged. Data only; safe to re-run.
-- ============================================================================

DO $$
DECLARE
  p record;
  o record;
BEGIN
  FOR p IN
    SELECT * FROM public.products
     WHERE regexp_replace(lower(name), '\s', '', 'g') IN ('dispenserjug+water', 'dispenserwater+jug',
                                                          'dispenserjugwater', 'dispenserjug&water',
                                                          'dispenserjugandwater')
     ORDER BY created_at
     FOR UPDATE
  LOOP
    -- Free the name if another product holds it.
    FOR o IN SELECT * FROM public.products
              WHERE factory_id = p.factory_id AND id <> p.id AND lower(btrim(name)) = 'jug + water' FOR UPDATE LOOP
      UPDATE public.products
         SET name = CASE WHEN EXISTS (SELECT 1 FROM public.products x
                                       WHERE x.factory_id = o.factory_id AND lower(btrim(x.name)) = 'jug + water (old)')
                         THEN 'Jug + Water (old ' || left(o.id::text, 4) || ')' ELSE 'Jug + Water (old)' END,
             updated_at = now()
       WHERE id = o.id;
      INSERT INTO public.audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
      VALUES (NULL, o.factory_id, 'rename_product', 'products', o.id::text,
              jsonb_build_object('name', o.name),
              jsonb_build_object('reason', 'Name "Jug + Water" given to the Dispenser Jug+Water product (2026-11-10)'));
    END LOOP;

    UPDATE public.products SET name = 'Jug + Water', updated_at = now() WHERE id = p.id;
    INSERT INTO public.audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (NULL, p.factory_id, 'rename_product', 'products', p.id::text,
            jsonb_build_object('name', p.name),
            jsonb_build_object('name', 'Jug + Water',
                               'reason', 'Only "Jug + Water" in the system, not "Dispenser Jug+Water" (user, 2026-11-10)'));
  END LOOP;
END $$;

-- The dispenser assignment also matches "Jug + Water".
DO $$
BEGIN
  IF to_regclass('public.user_product_rules') IS NOT NULL THEN
    UPDATE public.user_product_rules
       SET name_pattern = 'dispenser|jug\s*\+?\s*water'
     WHERE name_pattern = 'dispenser|jug water';
  END IF;
END $$;
