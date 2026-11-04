-- ============================================================================
-- Dispenser & jugs moves from the Warehouse to Quality Control
-- ----------------------------------------------------------------------------
-- User (2026-11-04): "move this page to quality control page, the whole of
-- it". The page is now a tab of Quality Control; its id in the menu changes
-- from "Warehouse › Dispenser & jugs" to "Quality Control › Dispenser & jugs",
-- so every per-user decision on the old page moves to the new one (QC staff
-- were given it on 2026-11-04). Safe to run again.
-- ============================================================================

INSERT INTO public.user_page_access (user_id, page_id, granted)
SELECT user_id, 'Quality Control › Dispenser & jugs', granted
  FROM public.user_page_access WHERE page_id = 'Warehouse › Dispenser & jugs'
ON CONFLICT (user_id, page_id) DO UPDATE SET granted = EXCLUDED.granted;
DELETE FROM public.user_page_access WHERE page_id = 'Warehouse › Dispenser & jugs';
