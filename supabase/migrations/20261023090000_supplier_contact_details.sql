-- ============================================================================
-- Supplier phone numbers and addresses for the Water Factory
-- ----------------------------------------------------------------------------
-- Contact details for every supplier, taken from the factory's old supplier
-- list, so they show on the Suppliers page and wherever a supplier's phone or
-- address is needed.
--   * A supplier already present under the same name (ignoring case and
--     spacing) gets its phone and address filled in. A phone or address that
--     was already entered in the app is kept as it is.
--   * A supplier not yet in the system is added with its details.
-- The old list gave PANAR's phone only as "080", so it is left blank, and
-- SHAN PACKAGING LTD came with no details. Both can be completed from the
-- Suppliers page. Safe to run again.
-- ============================================================================

CREATE TEMP TABLE supplier_details (name text, phone text, address text);

INSERT INTO supplier_details (name, phone, address) VALUES
  ('Prima',                           '+23470898767',   'Lagos-Abuja'),
  ('Sentric',                         '09087653452',    'Ikorodu - Lagos'),
  ('KRS',                             '09088978332',    'Lagos-Nigeria'),
  ('Lovleen',                         '09876565255',    'Lagos-Nigeria'),
  ('Lasboye',                         '080765355255',   'Abule-odu, Lagos'),
  ('Solidstar',                       '0987656356',     'Abuja-Nigeria'),
  ('Aflac',                           '0908756525',     'Kaduna-Nigeria'),
  ('Blessed',                         '0908756655',     'Kubwa-Abuja'),
  ('Elim',                            '09087667363',    'Elim building'),
  ('Denle',                           '090867635',      'Lagos-Nigeria'),
  ('Scott',                           '0902587100',     'Lagos'),
  ('Ventri',                          '09056231780',    'Lagos'),
  ('Tarabichi',                       '09056210378',    'Lagos'),
  ('Sopex',                           '08023645974',    'Lagos - Isolo'),
  ('Leoplast Industry',               '09015243010',    'Lagos'),
  ('Stanle Straw',                    '08102563041',    'Lagos'),
  ('Sonnex',                          '09065231700',    'Ojota - Lagos'),
  ('Rowlacom',                        '08032145960',    'Ota - Lagos'),
  ('Pentagon',                        '09015243010',    'Lagos - Ojota'),
  ('Quatum Ent. Ltd',                 '070256341836',   'Mandalla, Niger State'),
  ('Bright Butterfly Management ltd', '07081659666',    'Lagos- Nigeria'),
  ('OMKAR NIG LTD',                   '09029860429',    'KAKURI, KADUNA'),
  ('Goldcoin',                        '08091610831',    'Ketu, Lagos.'),
  ('Hana',                            '08105000745',    'Isolo - Lagos'),
  ('Pentagon 29mm',                   '08102540153150', 'Kano'),
  ('Jodele',                          '09054563212',    'Lagos'),
  ('R & R plastic',                   '07045366690',    'isolo Lagos'),
  ('Pentagon 30mm',                   '0812540153150',  'Kano'),
  ('BAGCO MORPACK',                   '08151112975',    'Lagos'),
  ('CITY PRINTS',                     '07052980355',    'Abuja-Nigeria'),
  ('MAPLE Plastic',                   '09087657857',    'Ikeja-Lagos'),
  ('PANAR',                           NULL,             'Lagos'),
  ('YUNO MOLD',                       '09013130333',    'Ogun State'),
  ('SHAN PACKAGING LTD',              NULL,             NULL);

UPDATE public.suppliers x
   SET phone   = COALESCE(NULLIF(btrim(x.phone), ''), d.phone),
       address = COALESCE(NULLIF(btrim(x.address), ''), d.address)
  FROM supplier_details d, public.factories f
 WHERE f.code = 'water'
   AND x.factory_id = f.id
   AND lower(regexp_replace(btrim(x.name), '\s+', ' ', 'g')) = lower(d.name)
   AND (   (NULLIF(btrim(x.phone), '') IS NULL AND d.phone IS NOT NULL)
        OR (NULLIF(btrim(x.address), '') IS NULL AND d.address IS NOT NULL));

INSERT INTO public.suppliers (factory_id, name, phone, address)
SELECT f.id, d.name, d.phone, d.address
  FROM public.factories f
 CROSS JOIN supplier_details d
 WHERE f.code = 'water'
   AND NOT EXISTS (
     SELECT 1 FROM public.suppliers x
      WHERE x.factory_id = f.id
        AND lower(regexp_replace(btrim(x.name), '\s+', ' ', 'g')) = lower(d.name));

DROP TABLE supplier_details;
