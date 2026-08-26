-- ============================================================================
-- CLEANUP: drop the five confirmed-dead functions (spec section 74)
-- ----------------------------------------------------------------------------
-- adjust_raw_material/adjust_finished_stock, receive_raw_material,
-- delete_production, and create_costing_sheet were all superseded by
-- dual-control replacements (post_stock_adjustment, confirm_goods_receipt,
-- confirm_production_batch's design has no delete path, submit_costing_sheet
-- respectively) and had EXECUTE revoked from authenticated at that time.
-- 20260826093000 additionally closed the PUBLIC-execute loophole that made
-- those revokes ineffective. Confirmed zero frontend callers (grepped the
-- whole src tree) and confirmed the replacement RPCs are what every current
-- page actually calls. Dropping outright rather than leaving them inert:
-- an unreachable function with a permission-check bug (like the ambiguity
-- fixed in the same migration) is a landmine for the next person who reads
-- or copies it, and there is no data attached to a function to lose.
-- ============================================================================

DROP FUNCTION IF EXISTS public.adjust_raw_material(jsonb);
DROP FUNCTION IF EXISTS public.adjust_finished_stock(jsonb);
DROP FUNCTION IF EXISTS public.receive_raw_material(jsonb);
DROP FUNCTION IF EXISTS public.delete_production(uuid);
DROP FUNCTION IF EXISTS public.create_costing_sheet(jsonb);
