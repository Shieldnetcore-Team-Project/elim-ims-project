-- ============================================================================
-- Notifications clear once they're attended to
-- ----------------------------------------------------------------------------
-- The user's rule (2026-10-28): a notification should leave the bell list and
-- the bell count once its task is attended to. Two things kept them there:
--   * read ones stayed in the list (greyed);
--   * a notification sent to everyone (user_id NULL, e.g. "Stock adjustment
--     awaiting approval") could never be marked read: the update policy only
--     lets a user change their own rows, so it stayed unread for good.
--
-- Now:
--   * notification_reads records, per user, that they've dealt with a
--     notification sent to everyone -- it clears for them, not for the rest;
--   * mark_notifications_read(p_ids) marks the caller's own notifications
--     read and records the shared ones in notification_reads;
--   * my_open_notifications(p_factory, p_limit) is what the bell shows: the
--     caller's notifications (own + shared) that are neither read by them nor
--     attended to. "Stock adjustment awaiting approval" counts as attended,
--     for everyone, as soon as that adjustment (by the reference at the start
--     of its text) is no longer pending approval.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.notification_reads (
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);
GRANT SELECT ON public.notification_reads TO authenticated;
GRANT ALL ON public.notification_reads TO service_role;
ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own notification reads" ON public.notification_reads;
CREATE POLICY "own notification reads" ON public.notification_reads FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[])
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_uid uuid := auth.uid(); v_own int; v_shared int;
BEGIN
  IF v_uid IS NULL OR p_ids IS NULL THEN RETURN 0; END IF;
  UPDATE notifications SET read = true
   WHERE id = ANY (p_ids) AND user_id = v_uid AND NOT read;
  GET DIAGNOSTICS v_own = ROW_COUNT;
  INSERT INTO notification_reads (notification_id, user_id)
  SELECT id, v_uid FROM notifications WHERE id = ANY (p_ids) AND user_id IS NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_shared = ROW_COUNT;
  RETURN v_own + v_shared;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_open_notifications(p_factory uuid, p_limit int DEFAULT 30)
RETURNS TABLE(id uuid, title text, body text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT n.id, n.title, n.body, n.created_at
    FROM public.notifications n
   WHERE auth.uid() IS NOT NULL
     AND (n.factory_id = p_factory OR n.factory_id IS NULL)
     AND (
           (n.user_id = auth.uid() AND NOT n.read)
        OR (n.user_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM public.notification_reads r
               WHERE r.notification_id = n.id AND r.user_id = auth.uid()))
         )
     -- An adjustment approval is attended once the adjustment isn't pending.
     AND NOT (
           n.title = 'Stock adjustment awaiting approval'
       AND NOT EXISTS (
             SELECT 1 FROM public.stock_adjustment_requests a
              WHERE a.reference_number = split_part(n.body, ' ', 1)
                AND a.status = 'pending_approval')
         )
   ORDER BY n.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$fn$;
REVOKE ALL ON FUNCTION public.my_open_notifications(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_open_notifications(uuid, int) TO authenticated;

NOTIFY pgrst, 'reload schema';
