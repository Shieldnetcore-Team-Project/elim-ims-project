-- ============================================================================
-- Role dropdown: QC and Warehouse
-- ----------------------------------------------------------------------------
-- QC is a new role for the Quality Control page: it inspects supplier
-- deliveries (goods-receiving submit) before the Warehouse accepts them.
-- Warehouse is the existing store_officer role under its new name; the slug
-- stays so current assignments and permissions carry over.
-- super_admin can adjust either from Role Management / Permission Matrix.
-- ============================================================================

INSERT INTO public.roles (slug, label, description, is_system) VALUES
  ('qc_officer', 'QC', 'Quality Control: inspects supplier deliveries before the Warehouse accepts them into raw materials.', true)
ON CONFLICT (slug) DO NOTHING;

UPDATE public.roles
SET label = 'Warehouse',
    description = 'Warehouse: accepts QC-inspected deliveries and production batches into stock, and manages finished products.',
    updated_at = now()
WHERE slug = 'store_officer';

-- QC records inspections (maker); the Warehouse confirms or rejects them.
-- View on raw materials, suppliers and the dashboard so the inspection form's
-- pickers and the landing page load.
INSERT INTO public.role_permissions (role, module, action)
SELECT 'qc_officer', 'goods-receiving', a FROM unnest(ARRAY['view','submit','cancel']::action_key[]) a
UNION ALL
SELECT 'qc_officer', m::module_key, 'view'::action_key FROM unnest(ARRAY['raw-materials','suppliers','dashboard']) m
ON CONFLICT DO NOTHING;
