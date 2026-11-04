-- ============================================================================
-- Quality Control: "Bottle tracking" is now the "Dispenser" tab
-- ----------------------------------------------------------------------------
-- User (2026-11-04): the tracking table is about the dispensers (Old / New
-- Jug), so it moves into QC's jug tab, renamed "Dispenser" (one Dispenser
-- line, not New / Old). The page's id in the menu changes from
-- "Quality Control › Bottle tracking" to "Quality Control › Dispenser", so
-- every per-user decision on the old page moves to the new one.
-- ============================================================================

INSERT INTO public.user_page_access (user_id, page_id, granted)
SELECT user_id, 'Quality Control › Dispenser', granted
  FROM public.user_page_access WHERE page_id = 'Quality Control › Bottle tracking'
ON CONFLICT (user_id, page_id) DO UPDATE SET granted = EXCLUDED.granted;
DELETE FROM public.user_page_access WHERE page_id = 'Quality Control › Bottle tracking';
