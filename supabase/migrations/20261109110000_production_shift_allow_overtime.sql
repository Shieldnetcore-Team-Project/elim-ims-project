-- ============================================================================
-- Production: let the database accept the Over-Time shift
-- ----------------------------------------------------------------------------
-- User report (2026-11-09), entering Sunday Overtime: "new row for relation
-- production violates check constraint production_shift_check".
--
-- The live database still had the rule from 20261015120000 (day / night only):
-- 20261102190000, which widens it, had not taken effect there. Only that rule
-- changes; no batch is touched. Whatever check on the shift is there now is
-- replaced, so this is safe to run again. The last line shows the rule in force.
-- ============================================================================

DO $$
DECLARE v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_constraint c
     WHERE c.conrelid = 'public.production'::regclass AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ~ '\mshift\M'
  LOOP
    EXECUTE format('ALTER TABLE public.production DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;

ALTER TABLE public.production ADD CONSTRAINT production_shift_check
  CHECK (shift IS NULL OR shift IN ('day', 'night', 'overtime'));

SELECT pg_get_constraintdef(oid) AS shift_rule_now_in_force
  FROM pg_constraint
 WHERE conrelid = 'public.production'::regclass AND conname = 'production_shift_check';
