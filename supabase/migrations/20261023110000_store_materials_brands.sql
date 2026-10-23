-- ============================================================================
-- Store materials: each material's brand, and the old system's material list
-- ----------------------------------------------------------------------------
-- 1. raw_materials.brand_id: the brand a material is (Store → Brands,
--    20261023100000_brands.sql). The Store list shows the brand, its pack
--    (Bag, Carton, Piece, Roll), grammage and dealer next to the material, so
--    the many materials called "Preform" are told apart by brand.
--
-- 2. The factory's material list from the old system (88 materials), each
--    tied to its brand by brand name, pack, grammage and dealer, and keeping
--    the date it was added there. Every one starts with no stock: stock comes
--    in through a stock count or a delivery as usual. From the brand:
--      * dealer -> supplier;
--      * pieces per pack (when more than 1) -> pieces per bag/carton, so
--        deliveries are entered in packs and stock is kept in pieces;
--      * preforms (named so, or a bag of a gram weight) get their weight in
--        grams and show in Preform Inventory.
--    Names are kept exactly as entered there, including rows whose name holds
--    the supplier (e.g. "YUNO MOLD" with brand "Preform 29mm"); the Store can
--    rename them with Edit. Packing Nylon had no brand.
--
-- 3. request_new_material takes an optional brand_id. With a brand it reuses
--    only a material of the same name AND brand, so a new brand of Preform is
--    added rather than folded into another brand's Preform. Without one it
--    reuses any material of that name, as before.
-- ============================================================================

ALTER TABLE public.raw_materials
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES public.brands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS raw_materials_brand_idx ON public.raw_materials (brand_id);

-- ---------- 2. The old system's materials ----------
-- Times are Nigeria time (WAT, +01).
CREATE TEMP TABLE legacy_materials (
  sn int, name text, brand text, category text, grammage text, dealer text, added timestamptz
);
INSERT INTO legacy_materials VALUES
  ( 1, 'Preform',                   'Prima',                           'Bag',    '14.8g',       'Prima',                           '2021-05-31 15:56:15+01'),
  ( 2, 'Preform',                   'Prima',                           'Bag',    '16.5g',       'Prima',                           '2021-05-31 15:57:49+01'),
  ( 3, 'Preform',                   'Prima',                           'Bag',    '19.5g',       'Prima',                           '2021-05-31 15:58:15+01'),
  ( 4, 'Bottle Cap',                'Prima',                           'Carton', '28mm',        'Prima',                           '2021-05-31 15:58:44+01'),
  ( 5, 'Bottle cap',                'Prima',                           'Carton', '30mm',        'Prima',                           '2021-05-31 15:59:02+01'),
  ( 6, 'Preform',                   'Lovleen',                         'Bag',    '22g',         'Lovleen',                         '2021-05-31 15:59:33+01'),
  ( 7, 'Preform',                   'Lovleen',                         'Bag',    '20g',         'Lovleen',                         '2021-05-31 15:59:48+01'),
  ( 8, 'New Jug',                   'Elim',                            'Piece',  '700g',        'Elim',                            '2021-05-31 16:00:14+01'),
  ( 9, 'Water Nylon',               'Aflac',                           'Roll',   '32g',         'Aflac',                           '2021-05-31 16:01:11+01'),
  (10, 'Preform',                   'Sentric',                         'Bag',    '16g',         'Sentric',                         '2021-05-31 16:01:52+01'),
  (11, 'Preform',                   'Sentric',                         'Bag',    '19g',         'Sentric',                         '2021-05-31 16:02:10+01'),
  (12, 'Preform',                   'KRS',                             'Bag',    '18.5g',       'KRS',                             '2021-05-31 16:02:25+01'),
  (13, 'Preform',                   'Denle',                           'Piece',  '700g',        'Denle',                           '2021-05-31 16:02:43+01'),
  (14, 'Shrink Nylon',              'Lasboye',                         'Roll',   '0.9g',        'Lasboye',                         '2021-05-31 16:03:21+01'),
  (15, 'Packing Nylon',             NULL,                              NULL,     NULL,          NULL,                              '2021-05-31 16:04:00+01'),
  (16, 'Jug Nylon',                 'SolidStar',                       'Piece',  '0.9g',        'Solidstar',                       '2021-05-31 16:04:33+01'),
  (17, 'Shrink Nylon',              'Blessed',                         'Roll',   '0.9g',        'Blessed',                         '2021-05-31 16:05:25+01'),
  (18, 'Preform',                   'Prima',                           'Bag',    '34g',         'Prima',                           '2021-05-31 16:14:27+01'),
  (19, 'Preform',                   'Scott',                           'Bag',    '22g',         'Scott',                           '2021-05-31 16:19:22+01'),
  (20, 'Jug Label',                 'Tarabichi',                       'Piece',  '0.15g',       'Tarabichi',                       '2021-05-31 17:30:41+01'),
  (21, '50cl Label',                'Ventri',                          'Piece',  '0.15g',       'Ventri',                          '2021-05-31 17:41:19+01'),
  (22, '75cl Label',                'Ventri',                          'Piece',  '0.15g',       'Ventri',                          '2021-05-31 17:42:55+01'),
  (23, '35cl Label',                'Ventri',                          'Piece',  '0.15g',       'Ventri',                          '2021-06-02 11:50:28+01'),
  (24, '100cl Label',               'Ventri',                          'Piece',  '0.15g',       'Ventri',                          '2021-06-02 11:54:00+01'),
  (25, '150cl Label',               'Ventri',                          'Piece',  '0.15g',       'Ventri',                          '2021-06-02 11:54:34+01'),
  (26, 'Empties Jug Parking Nylon', 'SolidStar',                       'Piece',  '0.9g',        'Solidstar',                       '2021-06-02 12:02:42+01'),
  (27, 'Tamperproof',               'Sopex',                           'Piece',  '0.15g',       'Sopex',                           '2021-06-02 12:26:38+01'),
  (28, 'Empties Cup',               'Leoplast Industry',               'Piece',  '0.2g',        'Leoplast Industry',               '2021-06-02 12:49:29+01'),
  (29, 'Cup Shrink Nylon',          'Leoplast Industry',               'Piece',  '0.09g',       'Leoplast Industry',               '2021-06-02 12:57:32+01'),
  (30, 'Straw',                     'Stanle straw',                    'Piece',  '0.09g',       'Stanle Straw',                    '2021-06-05 11:35:04+01'),
  (31, 'Jug Cap',                   'Aflac',                           'Piece',  '0.9g',        'Aflac',                           '2021-06-07 08:36:03+01'),
  (32, 'Cup Film',                  'Leoplast Industry',               'Piece',  '0.2g',        'Leoplast Industry',               '2021-06-07 08:36:24+01'),
  (33, 'Preform',                   'Sonnex',                          'Bag',    '16.7g',       'Sonnex',                          '2021-06-08 14:59:07+01'),
  (34, 'Shrink Nylon',              'Rowlacom',                        'Roll',   '32g',         'Rowlacom',                        '2021-06-08 15:17:39+01'),
  (35, 'Parking Nylon',             'Rowlacom',                        'Piece',  '0.09g',       'Rowlacom',                        '2021-06-08 15:21:16+01'),
  (36, 'Jug Nylon',                 'Rowlacom',                        'Piece',  '0.09g',       'Rowlacom',                        '2021-06-08 15:21:54+01'),
  (37, 'Preform',                   'Lovleen',                         'Bag',    '22g (Clear)', 'Lovleen',                         '2021-06-10 17:17:32+01'),
  (38, 'Prima',                     'Clear',                           'Bag',    '18g',         'Prima',                           '2021-06-22 11:49:32+01'),
  (39, 'Shrink Nylon',              'Aflac',                           'Roll',   '32g',         'Aflac',                           '2021-06-22 12:47:27+01'),
  (40, 'Botlle cap',                'Jodele',                          'Carton', '30mm',        'Pentagon',                        '2021-06-23 14:32:03+01'),
  (41, 'Preform',                   'Lovleeen',                        'Bag',    '16.5g',       'Lovleen',                         '2021-06-25 18:07:21+01'),
  (42, 'Bottle Cap',                'Sonnex',                          'Carton', '30mm',        'Sonnex',                          '2021-07-02 14:26:24+01'),
  (43, 'Shrink Nylon',              'Quatum Ent. Ltd',                 'Roll',   '0.2g',        'Quatum Ent. Ltd',                 '2021-07-16 15:22:45+01'),
  (44, 'Preform',                   'Prima Voltic Blue',               'Bag',    '18g',         'Prima',                           '2021-07-16 15:50:32+01'),
  (45, 'Jug seal',                  'Tarabichi',                       'Piece',  '0.15g',       'Tarabichi',                       '2021-07-31 16:51:26+01'),
  (46, 'Water Nylon',               'Bright Butterfly Management ltd', 'Roll',   '32g',         'Bright Butterfly Management ltd', '2021-07-31 17:08:26+01'),
  (47, 'Jug Nylon',                 'Bright Butterfly',                'Piece',  '0.9g',        'Bright Butterfly Management ltd', '2021-07-31 17:13:33+01'),
  (48, 'PREFORM',                   'KRS',                             'Bag',    '20.5g',       'KRS',                             '2022-01-17 17:12:15+01'),
  (49, 'Bottle Cap 1',              'PRIMA 1',                         'Piece',  '30mm',        'Prima',                           '2022-05-03 16:35:24+01'),
  (50, 'Preform',                   'Sentric',                         'Bag',    '18g',         'Sentric',                         '2022-06-21 10:49:27+01'),
  (51, 'KRS',                       'KRS',                             'Bag',    '15g',         'KRS',                             '2023-02-08 15:14:11+01'),
  (52, 'Shrink Nylon',              'OMKAR NIG LTD',                   'Roll',   '0.09g',       'OMKAR NIG LTD',                   '2023-03-09 14:57:46+01'),
  (53, 'Bottle Cap 1',              'Jodele 1',                        'Bag',    '30mm',        'Pentagon',                        '2025-02-22 13:00:50+01'),
  (54, 'Preform',                   'Sentric',                         'Bag',    '14.8g',       'Sentric',                         '2025-03-03 13:59:35+01'),
  (55, 'Jug Cap',                   'Lovleen',                         'Piece',  '0.9g',        'Lovleen',                         '2025-03-19 11:56:50+01'),
  (56, 'Bottle cap',                'Hana',                            'Piece',  '30mm',        'Hana',                            '2025-03-24 07:24:45+01'),
  (57, 'Preform',                   'Hana',                            'Bag',    '18g',         'Hana',                            '2025-03-24 07:31:07+01'),
  (58, 'Preform',                   'Hana',                            'Bag',    '14g',         'Hana',                            '2025-03-24 07:34:27+01'),
  (59, 'Preform',                   'Hana',                            'Bag',    '16.5g',       'Hana',                            '2025-04-18 14:09:39+01'),
  (60, 'Preform',                   'Sentric 1 (29 mm)',               'Bag',    '16g',         'Sentric',                         '2025-10-14 11:10:45+01'),
  (61, 'Preform1',                  'Sentric 1(29mm)',                 'Bag',    '13g',         'Sentric',                         '2025-10-14 11:20:36+01'),
  (62, 'Shrink Nylon',              'Hana',                            'Roll',   '0.9g',        'Hana',                            '2025-11-21 16:39:18+01'),
  (63, 'Bottle Cap',                'Sentric (29mm)',                  'Piece',  '29mm',        'Sentric',                         '2025-11-26 15:54:57+01'),
  (64, 'preform',                   'Sentric (29mm) Preform',          'Piece',  '14g',         'Sentric',                         '2025-12-01 15:49:06+01'),
  (65, 'Bottle Cap 29mm',           'Pentagon 29mm',                   'Piece',  '29mm',        'Pentagon',                        '2025-12-06 15:36:11+01'),
  (66, 'Bottle Cap',                'Jodele',                          'Carton', '29mm',        'Jodele',                          '2025-12-13 13:12:11+01'),
  (67, 'Preform 29mm',              'KRS',                             'Bag',    '14.5g',       'KRS',                             '2025-12-15 15:01:52+01'),
  (68, 'preform',                   'Hana 29mm preform',               'Piece',  '14g',         'Hana',                            '2025-12-22 15:32:49+01'),
  (69, 'preform',                   'Hana 29mm preform',               'Piece',  '16g',         'Hana',                            '2025-12-22 15:34:37+01'),
  (70, 'Bottle Cap',                'R&R Plastics',                    'Carton', '29mm',        'R & R plastic',                   '2025-12-22 15:39:17+01'),
  (71, 'Preform',                   'Pentagon',                        'Piece',  '13g',         'Pentagon',                        '2026-01-07 17:23:07+01'),
  (72, 'Pentagon',                  'Bottle Cap',                      'Bag',    '30mm',        'Pentagon',                        '2026-01-13 12:22:36+01'),
  (73, 'BAGCO MORPACK',             'Shrink Nylon',                    'Roll',   '0.9g',        'BAGCO MORPACK',                   '2026-01-21 16:26:43+01'),
  (74, 'Sentric',                   'Preform',                         'Bag',    '27gr',        'Sentric',                         '2026-02-26 08:00:21+01'),
  (75, 'CITY PRINTS',               'Parking Nylon',                   'Piece',  '0.9g',        'CITY PRINTS',                     '2026-02-26 14:14:23+01'),
  (76, 'Pentagon 29mm',             'Preform',                         'Bag',    '16g',         'Pentagon 29mm',                   '2026-03-04 12:50:30+01'),
  (77, 'MAPLE Plastic',             'Shrink Nylon',                    'Roll',   '32g',         'MAPLE Plastic',                   '2026-03-10 12:23:17+01'),
  (78, 'OMKAR',                     'Sachet Roll',                     'Roll',   '34g',         'OMKAR NIG LTD',                   '2026-03-30 18:15:05+01'),
  (79, 'PRIMA',                     'Preform 29mm',                    'Bag',    '13g',         'Prima',                           '2026-04-07 17:02:35+01'),
  (80, 'Preform 29mm',              'Prima',                           'Bag',    '16.5g',       'Prima',                           '2026-04-14 16:59:57+01'),
  (81, 'Bottle cap',                'PANAR Bottle Cap',                'Carton', '29mm',        'PANAR',                           '2026-05-25 11:26:58+01'),
  (82, 'KRS',                       'Preform 29mm',                    'Bag',    '13g',         'KRS',                             '2026-06-03 13:37:19+01'),
  (83, 'Maple',                     'Sachet Roll',                     'Roll',   '32g',         'MAPLE Plastic',                   '2026-06-29 08:57:26+01'),
  (84, 'YUNO MOLD',                 'Preform 29mm',                    'Bag',    '14g',         'YUNO MOLD',                       '2026-07-25 15:52:31+01'),
  (85, 'YUNO MOLD',                 'Preform 29mm',                    'Bag',    '12,5gr',      'YUNO MOLD',                       '2026-07-25 15:53:41+01'),
  (86, 'YUNO MOLD',                 'Bottle Cap',                      'Carton', '29mm',        'YUNO MOLD',                       '2026-07-25 15:53:56+01'),
  (87, 'Prima',                     'Preform 29mm',                    'Bag',    '14g',         'YUNO MOLD',                       '2026-09-29 17:49:32+01'),
  (88, 'SHAN PACKAGING',            'Bottle Cap',                      'Carton', '29mm',        'SHAN PACKAGING LTD',              '2026-10-01 17:46:25+01');

CREATE TEMP TABLE legacy_materials_resolved AS
SELECT l.*, f.id AS factory_id, b.id AS brand_id, b.supplier_id, b.pack_quantity,
       -- A preform: named so (material or brand), or a bag of a gram weight.
       COALESCE(l.name ~* 'preform' OR l.brand ~* 'preform'
                OR (l.category = 'Bag' AND l.grammage ~* '^[0-9]+([.,][0-9]+)?\s*g'), false) AS preform,
       NULLIF(replace(substring(l.grammage FROM '^([0-9]+(?:[.,][0-9]+)?)\s*g'), ',', '.'), '')::numeric AS grams
  FROM legacy_materials l
  JOIN public.factories f ON f.code = 'water'
  LEFT JOIN LATERAL (
    SELECT b.id, b.supplier_id, b.pack_quantity
      FROM public.brands b
      LEFT JOIN public.suppliers s ON s.id = b.supplier_id
     WHERE b.factory_id = f.id
       AND lower(b.name) = lower(l.brand)
       AND b.category = l.category
       AND b.grammage IS NOT DISTINCT FROM l.grammage
       AND lower(regexp_replace(btrim(s.name), '\s+', ' ', 'g')) = lower(l.dealer)
     ORDER BY b.created_at
     LIMIT 1
  ) b ON true;

INSERT INTO public.raw_materials (
  factory_id, name, brand_id, supplier_id, unit, pieces_per_bag, grams_per_piece, is_preform,
  opening_stock, current_stock, unit_cost, current_value, approval_status, active,
  created_by, created_at, updated_at)
SELECT r.factory_id, r.name, r.brand_id, r.supplier_id,
       CASE WHEN r.pack_quantity > 1 THEN 'Piece' WHEN r.category = 'Roll' THEN 'Roll' ELSE 'Piece' END,
       CASE WHEN r.pack_quantity > 1 THEN r.pack_quantity END,
       CASE WHEN r.preform AND r.grams > 0 AND r.grams <= 10000 THEN r.grams END,
       r.preform,
       0, 0, 0, 0, 'approved', true,
       NULL, r.added, r.added
  FROM legacy_materials_resolved r
 WHERE NOT EXISTS (
   SELECT 1 FROM public.raw_materials x
    WHERE x.factory_id = r.factory_id AND x.name = r.name
      AND x.brand_id IS NOT DISTINCT FROM r.brand_id AND x.created_at = r.added)
 ORDER BY r.sn;

-- Each material's dealer is its preferred supplier.
INSERT INTO public.material_suppliers (factory_id, material_id, supplier_id, is_preferred)
SELECT m.factory_id, m.id, m.supplier_id, true
  FROM public.raw_materials m
  JOIN legacy_materials_resolved r
    ON r.factory_id = m.factory_id AND r.name = m.name
   AND r.brand_id IS NOT DISTINCT FROM m.brand_id AND r.added = m.created_at
 WHERE m.supplier_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.material_suppliers ms
                    WHERE ms.material_id = m.id AND ms.is_preferred)
ON CONFLICT (material_id, supplier_id) DO NOTHING;

DROP TABLE legacy_materials_resolved;
DROP TABLE legacy_materials;

-- ---------- 3. request_new_material: brand-aware reuse ----------
CREATE OR REPLACE FUNCTION public.request_new_material(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_name text := payload->>'name';
  v_category_id uuid := NULLIF(payload->>'category_id','')::uuid;
  v_unit text := payload->>'unit';
  v_opening numeric := COALESCE((payload->>'opening_stock')::numeric, 0);
  v_unit_cost numeric := COALESCE((payload->>'unit_cost')::numeric, 0);
  v_supplier_id uuid := NULLIF(payload->>'supplier_id','')::uuid;
  v_brand_id uuid := NULLIF(payload->>'brand_id','')::uuid;
  v_reorder numeric := COALESCE((payload->>'reorder_level')::numeric, 0);
  v_minimum numeric := COALESCE((payload->>'minimum_stock')::numeric, 0);
  v_remarks text := payload->>'remarks';
  v_can_stock boolean;
  v_id uuid;
BEGIN
  v_can_stock := public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key);
  IF NOT v_can_stock
     AND NOT public.has_permission(v_uid, 'production-requests'::module_key, 'submit'::action_key)
     AND NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_name IS NULL OR btrim(v_name) = '' THEN RAISE EXCEPTION 'Material name is required'; END IF;
  IF v_unit IS NULL OR btrim(v_unit) = '' THEN RAISE EXCEPTION 'Unit is required'; END IF;
  IF v_brand_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM brands WHERE id = v_brand_id AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Brand not found for this factory';
  END IF;

  -- Already in the list? Reuse it rather than adding a duplicate. With a
  -- brand, only the same name of the same brand counts.
  SELECT id INTO v_id FROM raw_materials
   WHERE factory_id = v_factory
     AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g'))
     AND (v_brand_id IS NULL OR brand_id = v_brand_id)
     AND COALESCE(approval_status, 'approved') <> 'rejected'
   ORDER BY active DESC, created_at
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_id, 'existing', true);
  END IF;

  -- Requesters name the material; only the Store records stock and cost.
  IF NOT v_can_stock THEN
    v_opening := 0;
    v_unit_cost := 0;
  END IF;

  INSERT INTO raw_materials(factory_id, name, category_id, unit, opening_stock, current_stock, unit_cost, current_value,
                             supplier_id, brand_id, reorder_level, minimum_stock, remarks, approval_status, active, created_by)
  VALUES (v_factory, btrim(v_name), v_category_id, btrim(v_unit), v_opening, v_opening, v_unit_cost, v_opening * v_unit_cost,
          v_supplier_id, v_brand_id, v_reorder, v_minimum, v_remarks, 'approved', true, v_uid)
  RETURNING id INTO v_id;

  IF v_opening > 0 THEN
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_factory, v_id, 'opening_balance', v_opening, v_unit_cost, btrim(v_name), 'Opening balance', v_uid, 0, v_opening);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create_new_material', 'raw_materials', v_id::text, payload);

  RETURN jsonb_build_object('id', v_id, 'existing', false);
END; $$;
GRANT EXECUTE ON FUNCTION public.request_new_material(jsonb) TO authenticated;
