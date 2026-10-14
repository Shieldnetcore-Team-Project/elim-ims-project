-- ============================================================================
-- Water is the only factory: production scope is always WATER
-- ----------------------------------------------------------------------------
-- profiles.production_scope and production_types.production_scope date from
-- when there was also a nylon factory, and both defaulted to 'BOTH'. With just
-- the water production factory, every user and type belongs to it, so set
-- them all to WATER and make that the default for new rows.
-- has_production_scope_access() lets a WATER user act on the water factory,
-- so nobody loses access. The CHECK constraints are left as they are so
-- older code paths that still pass NYLON/BOTH don't start failing.
-- production.production_scope on past runs is history and is not rewritten.
-- ============================================================================

UPDATE public.profiles
SET production_scope = 'WATER'
WHERE production_scope <> 'WATER';

ALTER TABLE public.profiles ALTER COLUMN production_scope SET DEFAULT 'WATER';

UPDATE public.production_types
SET production_scope = 'WATER', updated_at = now()
WHERE production_scope <> 'WATER';

ALTER TABLE public.production_types ALTER COLUMN production_scope SET DEFAULT 'WATER';
