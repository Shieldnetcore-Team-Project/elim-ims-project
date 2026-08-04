-- Originally authored as database/postgres/migrations/0016_department_realignment.sql — copied here verbatim as the canonical, Supabase-CLI-managed migration history (see supabase/migrations/README.md).
-- =============================================================================
-- 0016_department_realignment.sql
-- Replaces the placeholder department list from 0015_reference_data.sql with
-- the real operating departments. Never edit an already-applied migration —
-- this supersedes 0015's department rows forward, as its own migration.
--
-- Safe to run destructively against departments: as of this migration nothing
-- yet references department_id (employees / material_requests /
-- warehouse_requisitions are all empty on every environment this has shipped
-- to). If that stops being true before you run this, switch the DELETE below
-- to a mapped UPDATE instead.
--
-- Also adds the one genuinely new physical location this department list
-- implies — "Warehouse 1", which posts *empty* returned dispenser bottles,
-- distinct from the Finished Goods Warehouse where *full* ones ship from.
-- =============================================================================

ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT;

DELETE FROM departments;

INSERT INTO departments (name, description) VALUES
  ('Retail',          'Walk-in and depot till sales.'),
  ('Production',      'Water treatment and bottling/sachet fill lines.'),
  ('Quality Control', 'Lab testing for both PET bottle and dispenser bottle lines.'),
  ('Store',           'Raw material and packaging intake store.'),
  ('Warehouse',       'Finished-product warehouse — full goods ready to ship.'),
  ('Warehouse 1',     'Posting of empty dispenser bottles returned for refill.'),
  ('Account',         'Finance, payroll and procurement approvals.'),
  ('Maintenance',     'Plant equipment and fleet upkeep.');

INSERT INTO warehouse_locations (name)
SELECT 'Warehouse 1 (Empty Dispenser Bottles)'
WHERE NOT EXISTS (SELECT 1 FROM warehouse_locations WHERE name = 'Warehouse 1 (Empty Dispenser Bottles)');
