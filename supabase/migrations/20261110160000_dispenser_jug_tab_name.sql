-- ============================================================================
-- Quality Control tab "Dispenser" is now "Dispenser Jug"
-- ----------------------------------------------------------------------------
-- User (2026-11-10): "change ... the tab Dispenser to Dispenser Jug". The page
-- id follows the menu label, so each person's tick / untick moves to the new
-- name. Run after 20261110150000. Data only; safe to re-run.
-- ============================================================================

UPDATE public.user_page_access o
   SET page_id = 'Quality Control › Dispenser Jug'
 WHERE o.page_id = 'Quality Control › Dispenser'
   AND NOT EXISTS (SELECT 1 FROM public.user_page_access n
                    WHERE n.user_id = o.user_id AND n.page_id = 'Quality Control › Dispenser Jug');
DELETE FROM public.user_page_access WHERE page_id = 'Quality Control › Dispenser';
