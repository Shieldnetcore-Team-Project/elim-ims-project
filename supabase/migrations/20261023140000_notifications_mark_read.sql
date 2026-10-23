-- ============================================================================
-- Notifications: factory-wide ones can be marked read
-- ----------------------------------------------------------------------------
-- Opening the bell marks its notifications read. Notifications sent to the
-- whole factory (user_id NULL, e.g. "Stock adjustment awaiting approval")
-- are visible to everyone ("read own notifications") but the update policy
-- only allowed user_id = auth.uid(), so marking them read silently changed
-- nothing and the bell's count never went down. Anyone who can see a
-- factory-wide notification may now mark it read (it is then read for the
-- factory, as there is one row for all). Personal ones stay the recipient's.
-- ============================================================================

DROP POLICY IF EXISTS "update own notifications" ON public.notifications;
CREATE POLICY "update own notifications" ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL)
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);
