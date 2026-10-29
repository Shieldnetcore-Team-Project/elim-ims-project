-- ============================================================================
-- Retail › "Sales & POS" is now "Retail › POS"
-- ----------------------------------------------------------------------------
-- User (2026-10-29): the tab is renamed POS, and it lists the Retail Shop's
-- sales only (src/routes/_app.sales.tsx). Page access is stored per user by
-- page name (user_page_access.page_id = "<menu> › <tab>"), so the stored
-- grants and blocks move to the new name -- otherwise a user blocked from
-- the page would see it again, and one granted it would lose it. Where a
-- user somehow has both names, the new one is kept. Safe to run again.
-- ============================================================================

DELETE FROM public.user_page_access o
 WHERE o.page_id = 'Retail › Sales & POS'
   AND EXISTS (SELECT 1 FROM public.user_page_access n
                WHERE n.user_id = o.user_id AND n.page_id = 'Retail › POS');
UPDATE public.user_page_access SET page_id = 'Retail › POS' WHERE page_id = 'Retail › Sales & POS';
