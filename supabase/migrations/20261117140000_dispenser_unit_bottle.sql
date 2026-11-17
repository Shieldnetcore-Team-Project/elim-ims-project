-- ============================================================================
-- Dispenser products are counted in Bottles, not Pieces
-- ----------------------------------------------------------------------------
-- User request (2026-11-17): "change dispenser unit in the entire system from
-- piece to bottle". Every page, print and report reads products.unit (or a
-- function returning it), so the finished dispenser products -- Dispenser
-- Water, Jug + Water, Empty Jug, Dispenser/Jug Water (Old/New Jug) -- move to
-- 'Bottle'. Records that kept their own copy of the unit (batches, releases,
-- damage records, sales returns) follow, so old and new lines read the same.
--
-- Rename only: no quantity, price or stock changes. The Store's jugs follow
-- (second block below). The products admin-only trigger lets a
-- migration (no signed-in user) through. Safe to run more than once.
-- ============================================================================

INSERT INTO public.units_of_measure (name, code) VALUES ('Bottle', 'BOTTLE')
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
  v_ids uuid[];
  v_piece constant text := '^(piece|pieces|pc|pcs)$';
BEGIN
  SELECT array_agg(id) INTO v_ids
    FROM public.products
   WHERE product_type = 'finished'
     AND name ~* '(dispenser|jug)'
     AND btrim(COALESCE(unit, '')) ~* v_piece;
  IF v_ids IS NULL THEN RETURN; END IF;

  UPDATE public.products SET unit = 'Bottle', updated_at = now() WHERE id = ANY (v_ids);

  UPDATE public.production SET unit = 'Bottle'
   WHERE product_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;
  UPDATE public.production_releases SET unit = 'Bottle'
   WHERE product_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;
  UPDATE public.damage_records SET unit = 'Bottle'
   WHERE product_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;
  UPDATE public.sales_returns SET unit = 'Bottle'
   WHERE product_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;

  RAISE NOTICE 'Dispenser products now in Bottles: %', array_length(v_ids, 1);
END $$;

-- ---------------------------------------------------- Store jugs (QC page) --
-- User (2026-11-17, QC stock by material showing "600 Piece" for New Jug):
-- the jugs themselves -- New Jug, Old Jug, Empty Dispenser Bottle (Old/New)
-- -- are Bottles too, wherever they show (Store, QC, Production, reports).
-- Their caps, labels, nylon, seals and handles stay as they are.
DO $$
DECLARE
  v_ids uuid[];
  v_piece constant text := '^(piece|pieces|pc|pcs)$';
BEGIN
  SELECT array_agg(id) INTO v_ids
    FROM public.raw_materials
   WHERE name ~* '(jug|dispenser bottle)'
     AND name !~* '(nylon|label|cap|seal|handle|sleeve|parking|shrink|film)'
     AND btrim(COALESCE(unit, '')) ~* v_piece;
  IF v_ids IS NULL THEN RETURN; END IF;

  UPDATE public.raw_materials SET unit = 'Bottle' WHERE id = ANY (v_ids);

  UPDATE public.goods_receipts SET unit = 'Bottle'
   WHERE material_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;
  UPDATE public.purchase_orders SET unit = 'Bottle'
   WHERE material_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;
  UPDATE public.production_request_items SET unit = 'Bottle'
   WHERE material_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;
  UPDATE public.production_material_reports SET unit = 'Bottle'
   WHERE material_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;
  UPDATE public.damage_records SET unit = 'Bottle'
   WHERE material_id = ANY (v_ids) AND btrim(COALESCE(unit, '')) ~* v_piece;

  RAISE NOTICE 'Store jug materials now in Bottles: %', array_length(v_ids, 1);
END $$;

-- A brand's type ("Elim · 700g · Piece") may now be Bottle; the jug brands --
-- those only jug materials use -- take it.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.brands'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE public.brands DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.brands ADD CONSTRAINT brands_category_check
  CHECK (category IN ('Bag', 'Bottle', 'Carton', 'Piece', 'Roll'));

UPDATE public.brands b SET category = 'Bottle'
 WHERE b.category = 'Piece'
   AND EXISTS (SELECT 1 FROM public.raw_materials m WHERE m.brand_id = b.id AND m.unit = 'Bottle')
   AND NOT EXISTS (SELECT 1 FROM public.raw_materials m
                    WHERE m.brand_id = b.id AND COALESCE(m.unit, '') <> 'Bottle');

NOTIFY pgrst, 'reload schema';
