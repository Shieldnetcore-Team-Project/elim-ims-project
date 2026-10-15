-- ============================================================================
-- The Warehouse adds distributors itself
-- ----------------------------------------------------------------------------
-- The warehouse manager posts finished products to marketers, distributors and
-- the Company Retail Shop (Warehouse "Post" menu), and adds a new marketer or
-- distributor on the spot while doing so:
--
--   marketer     a sales_reps row (kind 'rep') -- needs distribution:create,
--                which store_officer already holds
--   distributor  a registered customer -- needs customers:create (the
--                customers write policy), which store_officer lacked; edit is
--                added so she can correct a distributor's phone/address
--
-- Every posting lands on that marketer's or distributor's account: a dispatch
-- on the marketer's account, a sale on the distributor's customer account.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action) VALUES
  ('store_officer', 'customers', 'create'),
  ('store_officer', 'customers', 'edit')
ON CONFLICT (role, module, action) DO NOTHING;
