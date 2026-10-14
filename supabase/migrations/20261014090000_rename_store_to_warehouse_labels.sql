-- ============================================================================
-- Rename "Store" to "Warehouse" in display labels
-- ----------------------------------------------------------------------------
-- The finished-goods store is now called the Warehouse across the app. Only
-- the human-readable labels change: the role slug stays 'store_officer' so
-- existing user_roles rows, permissions and RLS checks are untouched.
-- ============================================================================

UPDATE public.roles
SET label = 'Warehouse Officer'
WHERE slug = 'store_officer' AND label = 'Store Officer';

UPDATE public.workflow_configs
SET maker_label = 'Warehouse Officer'
WHERE module = 'finished-goods' AND maker_label = 'Store Officer';

UPDATE public.workflow_configs
SET checker_label = 'Warehouse',
    description = 'Production batch posted by Production, accepted with actual/damaged/rejected counts by the Warehouse before entering sale-able finished-goods stock.'
WHERE module = 'production' AND checker_label = 'Store';

-- The Users page department dropdown now offers "Inventory / Warehouse";
-- move existing profiles over so they still match an option.
UPDATE public.profiles
SET department = 'Inventory / Warehouse'
WHERE department = 'Inventory / Store';
