-- ============================================================================
-- Jug types: Old Jug and New Jug
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-23): dispenser jugs are "Old Jug" and "New Jug"
-- (as in Quality Control's jug register, 20261021100000), and the Warehouse
-- (e.g. aniaustin, Store & Warehouse) records empty-jug returns choosing one
-- of them. Warehouse → Dispenser & jugs keeps Record return disabled until a
-- jug type exists, and only a manager (distribution approve) can add one in
-- Setup, so the Warehouse could not record returns.
--
-- Adds the two jug types to the Water Factory where they are missing (by
-- name, ignoring case and spacing). Jug types already set up are kept; a
-- manager can switch any of them off in Setup. Safe to run again.
-- ============================================================================

INSERT INTO public.container_types (factory_id, name)
SELECT f.id, t.name
  FROM public.factories f
 CROSS JOIN (VALUES ('Old Jug'), ('New Jug')) AS t(name)
 WHERE f.code = 'water'
   AND NOT EXISTS (
     SELECT 1 FROM public.container_types c
      WHERE c.factory_id = f.id
        AND lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g')) = lower(t.name));
