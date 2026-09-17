-- ============================================================================
-- SEED EXPENSE CATEGORIES — a starter list of what money gets spent on, both
-- inside and outside the office, so the Expenses page's Category dropdown
-- has real options to pick from immediately instead of starting empty
-- (users can still add more via the existing "+ Add new category" option).
--
-- Seeded for every factory row present, since expense_categories is
-- per-factory. Guarded with NOT EXISTS on (factory_id, name) so this is
-- safe to re-run without creating duplicates.
-- ============================================================================
INSERT INTO public.expense_categories (factory_id, name)
SELECT f.id, v.name
FROM public.factories f
CROSS JOIN (VALUES
  ('Office Supplies'),
  ('Utility Bills (Electricity/Water/Internet)'),
  ('Rent'),
  ('Repairs & Maintenance'),
  ('Staff Welfare & Feeding'),
  ('Cleaning & Sanitation'),
  ('Printing & Stationery'),
  ('Fuel & Transport'),
  ('Vehicle Maintenance'),
  ('Logistics & Delivery'),
  ('Marketing & Advertising'),
  ('Bank Charges'),
  ('Government Levies & Taxes'),
  ('Security'),
  ('Miscellaneous')
) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_categories ec WHERE ec.factory_id = f.id AND ec.name = v.name
);
