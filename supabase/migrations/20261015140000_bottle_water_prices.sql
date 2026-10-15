-- ============================================================================
-- Selling prices per pack
-- ----------------------------------------------------------------------------
-- products.unit_price is what the sale form and Warehouse postings fill in
-- when a product is picked, so setting it here makes the price appear
-- automatically for Sales, Warehouse → Distributors / Marketers / Company
-- Retail Shop. Only a price still at 0 is set, so a price someone already
-- changed by hand is left alone. Change it later on Finished Products → Edit.
--
--   35cl Bottle Water    2,550
--   50cl Bottle Water    2,650
--   75cl Bottle Water    1,700
--   1.5Ltr Bottle Water  1,700
-- ============================================================================

UPDATE public.products p
   SET unit_price = v.price, updated_at = now()
  FROM (VALUES
    ('35cl bottle water', 2550),
    ('50cl bottle water', 2650),
    ('75cl bottle water', 1700),
    ('1.5ltr bottle water', 1700)
  ) AS v(name, price)
 WHERE lower(btrim(p.name)) = v.name
   AND COALESCE(p.unit_price, 0) = 0;
