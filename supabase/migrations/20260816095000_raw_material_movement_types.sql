-- ============================================================================
-- RAW MATERIAL MOVEMENT TYPES — add the spec-17 transaction types
-- ----------------------------------------------------------------------------
-- movement_type is a real Postgres ENUM (unlike module_key/action_key, which
-- are text DOMAINs) -- a value added via ALTER TYPE ... ADD VALUE cannot be
-- used in the same transaction that added it, and every migration file here
-- runs as one transaction. So this file ONLY adds values; nothing that uses
-- them. Same pattern already used once in
-- 20260723090000_add_used_for_production_movement_type.sql.
--
-- Mapping of spec 17's 9 required transaction types onto this enum:
--   OPENING_BALANCE        -> opening_balance (new)
--   RECEIPT                 -> received (existing)
--   ISSUE_TO_PRODUCTION     -> used_for_production (existing)
--   RETURN_FROM_PRODUCTION  -> return_from_production (new)
--   ADJUSTMENT               -> adjusted (existing)
--   TRANSFER                 -> transferred (existing)
--   DAMAGE                   -> damaged (existing)
--   EXPIRY                   -> expiry (new)
--   CORRECTION                -> correction (new)
-- issued/produced/sold/returned remain finished-goods concepts on the shared
-- inventory_movements table and are untouched here.
-- ============================================================================

ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'opening_balance';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'return_from_production';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'expiry';
ALTER TYPE public.movement_type ADD VALUE IF NOT EXISTS 'correction';
