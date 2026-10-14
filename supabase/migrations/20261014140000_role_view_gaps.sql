-- ============================================================================
-- View grants the new Store / Warehouse / QC flows depend on
-- ----------------------------------------------------------------------------
-- Found in review: each role could open its page, but row-level security hid
-- data the page needs, so lists came back empty.
--
--   store_officer (Warehouse)  raw-materials:view
--     Its own Stock tab (/inventory) is gated on raw-materials, and the Store
--     request form lists raw materials to request.
--   store_keeper (Store)       finished-goods:view
--     products are readable only with finished-goods access; requests show
--     and pick the product to be made.
--   qc_officer (QC)            purchase-orders:view
--     The inspection form loads open purchase orders for the delivery.
--
-- View only -- no create/edit rights are added.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action) VALUES
  ('store_officer', 'raw-materials', 'view'),
  ('store_keeper', 'finished-goods', 'view'),
  ('qc_officer', 'purchase-orders', 'view')
ON CONFLICT (role, module, action) DO NOTHING;
