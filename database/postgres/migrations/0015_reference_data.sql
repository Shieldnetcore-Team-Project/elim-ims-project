-- =============================================================================
-- 0015_reference_data.sql
-- Structural reference data the application depends on to run at all — as
-- opposed to seed/seed.sql, which is representative demo/transactional data.
-- This migration is idempotent-safe to rerun in a fresh environment; it is
-- not demo data and should ship to every environment including production.
-- =============================================================================

INSERT INTO uoms (code, name) VALUES
  ('unit', 'Unit'), ('case', 'Case'), ('L', 'Litre'), ('kg', 'Kilogram'), ('roll', 'Roll'), ('pack', 'Pack');

INSERT INTO item_categories (name) VALUES
  ('Raw material'), ('Packaging'), ('Consumable'), ('Finished goods');

INSERT INTO departments (name) VALUES
  ('Production'), ('Water Treatment'), ('Quality Control'), ('Sales'),
  ('Fleet & Delivery'), ('Finance'), ('Human Resources'), ('Warehouse');

INSERT INTO job_titles (title) VALUES
  ('Operator'), ('Supervisor'), ('Analyst'), ('Driver'),
  ('Accountant'), ('Sales rep'), ('Manager'), ('Technician');

INSERT INTO production_lines (name) VALUES ('Line A'), ('Line B'), ('Line C');
INSERT INTO shifts (name) VALUES ('Morning'), ('Afternoon'), ('Night');
INSERT INTO treatment_stages (name) VALUES ('RO stage'), ('UV stage'), ('Ozone stage'), ('Full cycle');

INSERT INTO water_sources (code, description) VALUES
  ('BOREHOLE-01', 'Plant borehole 1'), ('BOREHOLE-02', 'Plant borehole 2'),
  ('BOREHOLE-03', 'Plant borehole 3'), ('BOREHOLE-04', 'Plant borehole 4');

-- Towns/areas around the Abuja plant — external locations for customers,
-- suppliers and delivery routes.
INSERT INTO locations (name) VALUES
  ('Gwagwalada, FCT'), ('Kubwa, FCT'), ('Lugbe, FCT'), ('Nyanya, FCT'), ('Karu, Nasarawa'),
  ('Dutse, FCT'), ('Idu, FCT'), ('Wuse, FCT'), ('Garki, FCT'), ('Jikwoyi, FCT'),
  ('Mararaba, Nasarawa'), ('Kuje, FCT');

-- Internal stock locations — deliberately distinct from `locations` above.
INSERT INTO warehouse_locations (name) VALUES
  ('Raw Material Store'), ('Packaging Store'), ('Line A Floor'), ('Line B Floor'),
  ('Line C Floor'), ('Finished Goods Warehouse'), ('Cold Room'), ('Yard');

INSERT INTO chart_of_accounts (code, name, account_type) VALUES
  ('1000', 'Cash', 'ASSET'),
  ('1010', 'Bank', 'ASSET'),
  ('1100', 'Accounts Receivable', 'ASSET'),
  ('1200', 'Inventory', 'ASSET'),
  ('2000', 'Accounts Payable', 'LIABILITY'),
  ('3000', 'Owner''s Equity', 'EQUITY'),
  ('4000', 'Sales Revenue', 'REVENUE'),
  ('5000', 'Cost of Goods Sold', 'EXPENSE'),
  ('5100', 'Payroll Expense', 'EXPENSE'),
  ('5200', 'Utilities Expense', 'EXPENSE'),
  ('5300', 'Fuel Expense', 'EXPENSE'),
  ('5400', 'Maintenance Expense', 'EXPENSE');

-- Every screen the app can gate per-user/per-role access to (see
-- shared/src/moduleConfig.ts NAV_GROUPS in the application repo).
INSERT INTO pages (page_key, label, module_group) VALUES
  ('dashboard', 'Dashboard', 'Overview'),
  ('inventory', 'Inventory', 'Operations'),
  ('procurement', 'Procurement', 'Operations'),
  ('warehouse', 'Warehouse', 'Operations'),
  ('production', 'Production', 'Operations'),
  ('quality-control', 'Quality Control', 'Operations'),
  ('water-treatment', 'Water Treatment', 'Operations'),
  ('sales', 'Sales', 'Commercial'),
  ('pos', 'Point of Sale', 'Commercial'),
  ('fleet', 'Fleet & Delivery', 'Commercial'),
  ('finance', 'Finance', 'Finance & people'),
  ('hr', 'Human Resources', 'Finance & people'),
  ('payroll', 'Payroll', 'Finance & people'),
  ('assets', 'Assets & Maintenance', 'Plant & insight'),
  ('reports', 'Reports & Analytics', 'Plant & insight'),
  ('users', 'Users', 'Administration'),
  ('roles', 'Roles & Permissions', 'Administration'),
  ('activity-log', 'Audit Log', 'Administration'),
  ('settings', 'Settings', 'Administration'),
  ('control-panel', 'Admin Panel', 'Administration'),
  ('delete-requests', 'Delete Requests', 'Administration');

-- Tables participating in the deletion-approval workflow (see
-- trg_deletion_requests_apply, 0012).
INSERT INTO deletable_entities (entity_type, table_name, id_column) VALUES
  ('items', 'items', 'id'),
  ('suppliers', 'suppliers', 'id'),
  ('customers', 'customers', 'id'),
  ('employees', 'employees', 'id'),
  ('users', 'users', 'id'),
  ('vehicles', 'vehicles', 'id'),
  ('assets', 'assets', 'id'),
  ('purchase_orders', 'purchase_orders', 'id'),
  ('material_requests', 'material_requests', 'id'),
  ('warehouse_requisitions', 'warehouse_requisitions', 'id'),
  ('sales_orders', 'sales_orders', 'id');
