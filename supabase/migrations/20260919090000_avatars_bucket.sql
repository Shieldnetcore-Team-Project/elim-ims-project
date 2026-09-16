
-- Public bucket for user profile pictures, uploaded from the new personal
-- settings section (My Account card) every signed-in user gets regardless of
-- whether they hold the "settings" module permission.
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "public read avatars" ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');
CREATE POLICY "auth upload avatars" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars');
CREATE POLICY "auth update avatars" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars');
CREATE POLICY "auth delete avatars" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars');
