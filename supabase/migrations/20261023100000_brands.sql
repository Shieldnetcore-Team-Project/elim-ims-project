-- ============================================================================
-- Brands: the Store's list of supplier brands and how they are packed
-- ----------------------------------------------------------------------------
-- Store → Brands tab. Each brand is a product line a dealer (supplier)
-- delivers, with its category (how it is packed: Bag, Carton, Piece or Roll),
-- grammage or size as the supplier writes it ("14.8g", "30mm", "22g (Clear)")
-- and how many pieces/rolls/packs come in one unit.
--
-- Seeded with the factory's brand list from the old system, keeping the date
-- each was added there. The old "created by" numbers are user ids from that
-- system with no matching account here, so they are not carried over. Each
-- dealer is matched to the Water Factory supplier of the same name
-- (20261023090000_supplier_contact_details added them all).
--
-- Who: anyone who can see Raw Materials sees the list; create / edit / delete
-- rights on Raw Materials add, change and remove brands.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  -- The dealer. A supplier deleted later leaves the brand without one.
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('Bag', 'Carton', 'Piece', 'Roll')),
  grammage text,
  pack_quantity integer NOT NULL DEFAULT 0 CHECK (pack_quantity >= 0),
  created_by uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brands_factory_idx ON public.brands (factory_id, created_at);
CREATE INDEX IF NOT EXISTS brands_supplier_idx ON public.brands (supplier_id);

DROP TRIGGER IF EXISTS brands_touch ON public.brands;
CREATE TRIGGER brands_touch BEFORE UPDATE ON public.brands
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "brands read" ON public.brands;
CREATE POLICY "brands read" ON public.brands FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'read'::action_key));
DROP POLICY IF EXISTS "brands create" ON public.brands;
CREATE POLICY "brands create" ON public.brands FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key));
DROP POLICY IF EXISTS "brands edit" ON public.brands;
CREATE POLICY "brands edit" ON public.brands FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'edit'::action_key));
DROP POLICY IF EXISTS "brands delete" ON public.brands;
CREATE POLICY "brands delete" ON public.brands FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'raw-materials'::module_key, 'delete'::action_key));
REVOKE ALL ON public.brands FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brands TO authenticated;
GRANT ALL ON public.brands TO service_role;

-- ---------- The brand list from the old system ----------
-- Names, dealers and grammage exactly as they were entered there. Times are
-- Nigeria time (WAT, +01).
INSERT INTO public.brands (factory_id, name, supplier_id, category, grammage, pack_quantity, created_by, created_at)
SELECT f.id, b.name,
       (SELECT s.id FROM public.suppliers s
         WHERE s.factory_id = f.id
           AND lower(regexp_replace(btrim(s.name), '\s+', ' ', 'g')) = lower(b.dealer)
         ORDER BY s.created_at LIMIT 1),
       b.category, b.grammage, b.qty, NULL, b.added::timestamptz
  FROM public.factories f
 CROSS JOIN (VALUES
   ('Prima',                           'Prima',                           'Bag',    '14.8g',       1152, '2021-05-31 15:26:16+01'),
   ('Prima',                           'Prima',                           'Bag',    '16.5g',       1152, '2021-05-31 15:26:56+01'),
   ('Prima',                           'Prima',                           'Bag',    '19.5g',        960, '2021-05-31 15:27:27+01'),
   ('Prima',                           'Prima',                           'Carton', '28mm',        4800, '2021-05-31 15:30:05+01'),
   ('Prima',                           'Prima',                           'Carton', '30mm',        5000, '2021-05-31 15:30:26+01'),
   ('Lovleen',                         'Lovleen',                         'Bag',    '22g',          550, '2021-05-31 15:31:57+01'),
   ('Lovleen',                         'Lovleen',                         'Bag',    '20g',          600, '2021-05-31 15:32:26+01'),
   ('Elim',                            'Elim',                            'Piece',  '700g',           1, '2021-05-31 15:35:35+01'),
   ('Aflac',                           'Aflac',                           'Roll',   '32g',            1, '2021-05-31 15:41:04+01'),
   ('Sentric',                         'Sentric',                         'Bag',    '16g',         1250, '2021-05-31 15:42:06+01'),
   ('Sentric',                         'Sentric',                         'Bag',    '19g',         1052, '2021-05-31 15:42:45+01'),
   ('KRS',                             'KRS',                             'Bag',    '18.5g',       1080, '2021-05-31 15:45:44+01'),
   ('Denle',                           'Denle',                           'Piece',  '700g',           1, '2021-05-31 15:48:12+01'),
   ('Lasboye',                         'Lasboye',                         'Roll',   '0.9g',           1, '2021-05-31 15:51:54+01'),
   ('SolidStar',                       'Solidstar',                       'Piece',  '0.9g',           1, '2021-05-31 15:53:34+01'),
   ('Blessed',                         'Blessed',                         'Roll',   '0.9g',           1, '2021-05-31 15:55:00+01'),
   ('Prima',                           'Prima',                           'Bag',    '34g',          350, '2021-05-31 16:13:51+01'),
   ('Scott',                           'Scott',                           'Bag',    '22g',          500, '2021-05-31 16:18:55+01'),
   ('Tarabichi',                       'Tarabichi',                       'Piece',  '0.15g',          1, '2021-05-31 17:27:33+01'),
   ('Ventri',                          'Ventri',                          'Piece',  '0.15g',          1, '2021-05-31 17:40:05+01'),
   ('Sopex',                           'Sopex',                           'Piece',  '0.15g',          1, '2021-06-02 12:25:44+01'),
   ('Leoplast Industry',               'Leoplast Industry',               'Piece',  '0.2g',           1, '2021-06-02 12:46:43+01'),
   ('Leoplast Industry',               'Leoplast Industry',               'Piece',  '0.09g',          1, '2021-06-02 12:56:52+01'),
   ('Stanle straw',                    'Stanle Straw',                    'Piece',  '0.09g',          1, '2021-06-05 11:34:12+01'),
   ('Sonnex',                          'Sonnex',                          'Bag',    '16.7g',       1296, '2021-06-08 14:56:32+01'),
   ('Rowlacom',                        'Rowlacom',                        'Piece',  '0.09g',          1, '2021-06-08 15:17:00+01'),
   ('Lovleen',                         'Lovleen',                         'Bag',    '22g (Clear)',  455, '2021-06-10 14:51:37+01'),
   ('Clear',                           'Prima',                           'Bag',    '18g',          960, '2021-06-22 11:41:30+01'),
   ('Aflac',                           'Aflac',                           'Piece',  '0.9g',           1, '2021-06-22 12:13:36+01'),
   ('Rowlacom',                        'Rowlacom',                        'Roll',   '32g',            1, '2021-06-22 12:52:43+01'),
   ('Jodele',                          'Pentagon',                        'Carton', '30mm',        4500, '2021-06-23 14:29:57+01'),
   ('Lovleeen',                        'Lovleen',                         'Bag',    '16.5g',        720, '2021-06-25 18:06:26+01'),
   ('Sonnex',                          'Sonnex',                          'Carton', '30mm',        4800, '2021-07-02 14:24:47+01'),
   ('Quatum Ent. Ltd',                 'Quatum Ent. Ltd',                 'Roll',   '0.2g',           1, '2021-07-16 15:21:53+01'),
   ('Prima Voltic Blue',               'Prima',                           'Bag',    '18g',          960, '2021-07-16 15:48:03+01'),
   ('Bright Butterfly',                'Bright Butterfly Management ltd', 'Piece',  '0.9g',           1, '2021-07-31 16:58:24+01'),
   ('Bright Butterfly Management ltd', 'Bright Butterfly Management ltd', 'Roll',   '32g',            1, '2021-07-31 17:05:12+01'),
   ('KRS',                             'KRS',                             'Bag',    '20.5g',       1025, '2022-01-17 17:07:30+01'),
   ('PRIMA 1',                         'Prima',                           'Piece',  '30mm',        4500, '2022-05-03 16:33:38+01'),
   ('Sentric',                         'Sentric',                         'Bag',    '18g',         1110, '2022-06-21 10:48:15+01'),
   ('KRS',                             'KRS',                             'Bag',    '15g',         1330, '2023-02-08 15:12:12+01'),
   ('OMKAR NIG LTD',                   'OMKAR NIG LTD',                   'Roll',   '0.09g',          1, '2023-03-09 14:54:11+01'),
   ('50cl PVC-Label',                  'Goldcoin',                        'Piece',  '0.9g',           0, '2024-02-14 13:36:15+01'),
   ('75cl PVC-Label',                  'Goldcoin',                        'Piece',  '0.15g',          0, '2024-02-14 13:37:47+01'),
   ('Jodele',                          'Pentagon',                        'Bag',    '30mm',        4000, '2025-02-22 12:49:37+01'),
   ('Jodele 1',                        'Pentagon',                        'Bag',    '30mm',        4000, '2025-02-22 12:57:57+01'),
   ('Sentric',                         'Sentric',                         'Bag',    '14.8g',       1330, '2025-03-03 13:51:44+01'),
   ('Lovleen',                         'Lovleen',                         'Piece',  '0.9g',           1, '2025-03-19 11:53:28+01'),
   ('Hana',                            'Hana',                            'Piece',  '30mm',        4000, '2025-03-24 07:23:54+01'),
   ('Hana',                            'Hana',                            'Bag',    '18g',         1100, '2025-03-24 07:29:22+01'),
   ('Hana',                            'Hana',                            'Bag',    '14g',         1425, '2025-03-24 07:33:56+01'),
   ('Hana',                            'Hana',                            'Bag',    '16.5g',       1190, '2025-04-18 14:08:45+01'),
   ('Sentric 1 (29 mm)',               'Sentric',                         'Bag',    '16g',         1250, '2025-10-14 11:07:11+01'),
   ('Sentric 1(29mm)',                 'Sentric',                         'Bag',    '13g',         1538, '2025-10-14 11:13:59+01'),
   ('Hana',                            'Hana',                            'Roll',   '0.9g',           1, '2025-11-21 16:38:12+01'),
   ('Sentric (29mm)',                  'Sentric',                         'Piece',  '29mm',        6000, '2025-11-26 15:52:56+01'),
   ('Sentric (29mm) Preform',          'Sentric',                         'Piece',  '14g',         1428, '2025-12-01 15:47:40+01'),
   ('Pentagon 29mm',                   'Pentagon',                        'Piece',  '29mm',        6500, '2025-12-06 15:31:41+01'),
   ('Jodele',                          'Jodele',                          'Carton', '29mm',        9000, '2025-12-13 13:10:58+01'),
   ('KRS',                             'KRS',                             'Bag',    '14.5g',       1379, '2025-12-15 15:00:46+01'),
   ('Hana 29mm preform',               'Hana',                            'Piece',  '14g',         1428, '2025-12-22 15:31:30+01'),
   ('Hana 29mm preform',               'Hana',                            'Piece',  '16g',         1250, '2025-12-22 15:34:19+01'),
   ('R&R Plastics',                    'R & R plastic',                   'Carton', '29mm',        7000, '2025-12-22 15:38:41+01'),
   ('Pentagon',                        'Pentagon',                        'Piece',  '13g',         1539, '2026-01-07 17:21:41+01'),
   ('Bottle Cap',                      'Pentagon',                        'Bag',    '30mm',        4000, '2026-01-13 11:56:53+01'),
   ('Shrink Nylon',                    'BAGCO MORPACK',                   'Roll',   '0.9g',           1, '2026-01-21 16:22:05+01'),
   ('Preform',                         'Sentric',                         'Bag',    '27gr',         740, '2026-02-26 07:22:46+01'),
   ('Parking Nylon',                   'CITY PRINTS',                     'Piece',  '0.9g',           1, '2026-02-26 14:12:40+01'),
   ('Preform',                         'Pentagon 29mm',                   'Bag',    '16g',         1250, '2026-03-04 12:47:00+01'),
   ('Shrink Nylon',                    'MAPLE Plastic',                   'Roll',   '32g',            1, '2026-03-10 12:20:05+01'),
   ('Sachet Roll',                     'OMKAR NIG LTD',                   'Roll',   '34g',            1, '2026-03-30 18:13:07+01'),
   ('Preform 29mm',                    'Prima',                           'Bag',    '13g',         1440, '2026-04-07 17:00:36+01'),
   ('Preform 29mm',                    'Prima',                           'Bag',    '16.5g',       1056, '2026-04-14 17:06:49+01'),
   ('PANAR Bottle Cap',                'PANAR',                           'Carton', '29mm',        6500, '2026-05-25 11:21:09+01'),
   ('Preform 29mm',                    'KRS',                             'Bag',    '13g',         1538, '2026-05-29 12:40:00+01'),
   ('Sachet Roll',                     'MAPLE Plastic',                   'Roll',   '32g',            1, '2026-06-29 08:54:32+01'),
   ('Preform 29mm',                    'YUNO MOLD',                       'Bag',    '14g',         1428, '2026-07-25 15:39:52+01'),
   ('Preform 29mm',                    'YUNO MOLD',                       'Bag',    '12,5gr',      1600, '2026-07-25 15:47:37+01'),
   ('Bottle Cap',                      'YUNO MOLD',                       'Carton', '29mm',        8800, '2026-07-25 15:49:59+01'),
   ('Preform',                         'Prima',                           'Bag',    '14g',         1440, '2026-09-29 17:52:54+01'),
   ('Bottle Cap',                      'SHAN PACKAGING LTD',              'Carton', '29mm',        9500, '2026-10-01 17:44:25+01')
 ) AS b(name, dealer, category, grammage, qty, added)
 WHERE f.code = 'water'
   AND NOT EXISTS (
     SELECT 1 FROM public.brands x
      WHERE x.factory_id = f.id AND x.name = b.name AND x.category = b.category
        AND x.grammage IS NOT DISTINCT FROM b.grammage AND x.created_at = b.added::timestamptz);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND tablename = 'brands') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.brands;
  END IF;
END $$;
