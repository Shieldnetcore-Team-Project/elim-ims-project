-- ============================================================================
-- Production managers work the Production page by default
-- ----------------------------------------------------------------------------
-- A production manager (not an admin) runs the production floor: records
-- what was produced, takes stock of what is in the production hall and
-- releases it to the Warehouse. Until now that only worked if an admin
-- ticked the rights one by one per user. This makes it the role default.
--
-- Roles are data (public.roles), and the production manager role was created
-- from the UI, so it is matched by slug or label rather than a fixed slug. The
-- seeded `production` role gets the same set.
--
--   production           view, create, edit, submit, print, export
--     view    -> page, hall stock (production_hall_stock), release history
--     create/edit/submit -> record batches and release_to_warehouse()
--   finished-goods       view   products are readable only with this, and
--                               the page lists products to record and release
--   production-requests  view   the release form links a request
--
-- Checker rights stay off: confirm/reject (Warehouse accepting a release,
-- reversing releases), cancel, approve, post and delete are not granted here.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action)
SELECT r.slug, g.module::module_key, g.action::action_key
FROM public.roles r
CROSS JOIN (VALUES
  ('production', 'view'),
  ('production', 'create'),
  ('production', 'edit'),
  ('production', 'submit'),
  ('production', 'print'),
  ('production', 'export'),
  ('finished-goods', 'view'),
  ('production-requests', 'view')
) AS g(module, action)
WHERE r.slug = 'production'
   OR r.slug ILIKE '%production%manager%'
   OR r.label ILIKE '%production%manager%'
ON CONFLICT (role, module, action) DO NOTHING;
