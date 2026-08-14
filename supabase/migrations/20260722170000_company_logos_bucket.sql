
-- Public bucket: company logos are meant to be displayed everywhere (sidebar, PDFs,
-- printed documents) without needing a signed URL refreshed on every render.
INSERT INTO storage.buckets (id, name, public)
VALUES ('company-logos', 'company-logos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "public read company logos" ON storage.objects FOR SELECT
  USING (bucket_id = 'company-logos');
CREATE POLICY "anon upload company logos" ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'company-logos');
CREATE POLICY "anon update company logos" ON storage.objects FOR UPDATE TO anon, authenticated
  USING (bucket_id = 'company-logos');
CREATE POLICY "anon delete company logos" ON storage.objects FOR DELETE TO anon, authenticated
  USING (bucket_id = 'company-logos');

-- Factories only ever had a SELECT policy -- Settings needs to rename/manage them.
GRANT UPDATE ON public.factories TO anon, authenticated;
CREATE POLICY "manage factories" ON public.factories FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
