-- ============================================================================
-- LOGISTICS: FULLER VEHICLE DESCRIPTION
-- ----------------------------------------------------------------------------
-- vehicles only had plate_number + a single free-text make_model + capacity.
-- Add the standard fleet-record fields (brand/model split out, type, year,
-- color) plus registration/insurance compliance fields. make_model is left
-- in place, untouched, rather than dropped -- same approach as raw_materials'
-- legacy `category` text column in 20260821090000 -- and backfilled into the
-- new brand/model columns so existing rows aren't blank.
-- ============================================================================

ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS vehicle_type text
    CHECK (vehicle_type IS NULL OR vehicle_type IN ('van','truck','bus','car','motorcycle','tricycle','other')),
  ADD COLUMN IF NOT EXISTS year integer CHECK (year IS NULL OR year BETWEEN 1900 AND 2100),
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS chassis_number text,
  ADD COLUMN IF NOT EXISTS engine_number text,
  ADD COLUMN IF NOT EXISTS registration_expiry_date date,
  ADD COLUMN IF NOT EXISTS insurance_expiry_date date;

UPDATE public.vehicles
SET brand = split_part(make_model, ' ', 1),
    model = NULLIF(btrim(substring(make_model FROM position(' ' IN make_model) + 1)), '')
WHERE brand IS NULL AND make_model IS NOT NULL AND position(' ' IN make_model) > 0;
