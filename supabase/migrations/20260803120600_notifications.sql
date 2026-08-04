-- =============================================================================
-- 20260803120600_notifications.sql
-- In-app notifications. Ordered before the realtime-publication migration
-- (20260803120700) since that migration adds this table to the publication.
-- =============================================================================

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,           -- e.g. 'PO_APPROVED', 'LOW_STOCK', 'DELETION_REQUESTED'
  title       TEXT NOT NULL,
  body        TEXT,
  -- Polymorphic pointer, same convention as activity_log.target_type/target_id
  -- (20260101000010) — not a real FK, by the same reasoning documented in
  -- docs/NORMALIZATION.md#polymorphic-references.
  target_type TEXT,
  target_id   TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

-- The only write path — SECURITY DEFINER so any module can notify *any* user
-- (e.g. a warehouse worker's low-stock event reaching a manager) without that
-- caller needing INSERT rights on someone else's notification row. Same
-- "one write API" convention as fn_post_inventory_transaction (20260101000011).
CREATE OR REPLACE FUNCTION fn_notify(
  p_user_id UUID, p_type TEXT, p_title TEXT, p_body TEXT DEFAULT NULL,
  p_target_type TEXT DEFAULT NULL, p_target_id TEXT DEFAULT NULL
) RETURNS notifications
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row notifications;
BEGIN
  INSERT INTO notifications (user_id, type, title, body, target_type, target_id)
  VALUES (p_user_id, p_type, p_title, p_body, p_target_type, p_target_id)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION fn_notify(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_notify(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notif_select ON notifications FOR SELECT TO authenticated
  USING (user_id = current_app_user_id());
CREATE POLICY notif_update ON notifications FOR UPDATE TO authenticated
  USING (user_id = current_app_user_id()) WITH CHECK (user_id = current_app_user_id());
CREATE POLICY notif_delete ON notifications FOR DELETE TO authenticated
  USING (user_id = current_app_user_id());
-- No INSERT policy for `authenticated` at all — fn_notify (SECURITY DEFINER) is the only write path.
