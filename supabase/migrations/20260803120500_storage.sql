-- =============================================================================
-- 20260803120500_storage.sql
-- Storage buckets + policies. Path convention: object name's first folder
-- segment names the entity kind it belongs to, gating access through the
-- same has_page_access()/is_super_admin() helpers RLS already uses.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public) VALUES
  ('attachments', 'attachments', false),  -- GRN/damaged-goods photos, signed delivery notes, QC evidence
  ('avatars', 'avatars', true)             -- user profile photos — low sensitivity, public-read
ON CONFLICT (id) DO NOTHING;

-- ---- attachments: private, folder-per-entity-kind ---------------------------
CREATE POLICY attachments_select ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'attachments' AND (
      is_super_admin()
      OR ((storage.foldername(name))[1] = 'purchase-orders' AND has_page_access('procurement'))
      OR ((storage.foldername(name))[1] = 'goods-received' AND has_page_access('procurement'))
      OR ((storage.foldername(name))[1] = 'quality-control' AND has_page_access('quality-control'))
      OR ((storage.foldername(name))[1] = 'delivery-notes' AND has_page_access('fleet'))
    )
  );

CREATE POLICY attachments_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'attachments' AND (
      is_super_admin()
      OR ((storage.foldername(name))[1] = 'purchase-orders' AND has_page_access('procurement'))
      OR ((storage.foldername(name))[1] = 'goods-received' AND has_page_access('procurement'))
      OR ((storage.foldername(name))[1] = 'quality-control' AND has_page_access('quality-control'))
      OR ((storage.foldername(name))[1] = 'delivery-notes' AND has_page_access('fleet'))
    )
  );
-- No UPDATE/DELETE policy — an uploaded attachment is a point-in-time record of evidence, not editable.

-- ---- avatars: public-read, folder-per-user ----------------------------------
CREATE POLICY avatars_select ON storage.objects FOR SELECT TO authenticated, anon
  USING (bucket_id = 'avatars');

CREATE POLICY avatars_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars' AND (
      is_super_admin() OR (storage.foldername(name))[1] = current_app_user_id()::text
    )
  );

CREATE POLICY avatars_update ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars' AND (
      is_super_admin() OR (storage.foldername(name))[1] = current_app_user_id()::text
    )
  )
  WITH CHECK (
    bucket_id = 'avatars' AND (
      is_super_admin() OR (storage.foldername(name))[1] = current_app_user_id()::text
    )
  );
