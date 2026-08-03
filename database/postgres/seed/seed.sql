-- =============================================================================
-- seed.sql — representative demo data for local development / QA.
--
-- Wherever a stored procedure exists for a workflow step (0011_functions.sql)
-- this drives it rather than inserting the resulting rows by hand — e.g.
-- fn_receive_goods() creates the GRN, its lines AND the inventory IN
-- transactions together, exactly as the application would. Seeded data ends
-- up exactly as internally consistent as data produced by real usage,
-- because it's produced the same way. Same philosophy as the original
-- server/src/db/seed.ts, replayed here as plain SQL.
--
-- Run once, after every file in database/postgres/migrations/ has applied:
--   psql "$DATABASE_URL" -f database/postgres/seed/seed.sql
-- Guarded at the top: refuses to run against a database that already has
-- purchase orders in it, rather than silently duplicating demo data.
--
-- Most rows are looked up downstream by their natural business name (item
-- name, employee full_name, supplier/customer name, role name — all unique
-- within this seed set, though not schema-enforced unique in general).
-- Rows with no natural key of their own (a PO, a batch, a sales order — the
-- generated `code` isn't known until insert time) go through seed_map, a
-- throwaway label -> id lookup for this script only.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM purchase_orders LIMIT 1) THEN
    RAISE EXCEPTION 'seed.sql: purchase_orders is not empty — this script seeds an empty database only; truncate first if you want to reseed.';
  END IF;
END $$;

CREATE TEMP TABLE seed_map (kind TEXT NOT NULL, label TEXT NOT NULL, id UUID NOT NULL, PRIMARY KEY (kind, label)) ON COMMIT DROP;

-- ============================== Roles & access ================================
INSERT INTO app_roles (name, description, scope, status) VALUES
  ('System administrator', 'Full access to every module and setting', 'Global', 'ACTIVE'),
  ('Plant manager', 'Operations, production and quality modules', 'Plant', 'ACTIVE'),
  ('Sales manager', 'Sales, POS and fleet dispatch', 'Commercial', 'ACTIVE'),
  ('Finance officer', 'Finance, payroll and procurement approvals', 'Finance', 'ACTIVE'),
  ('QC analyst', 'Quality control tests and batch sign-off', 'Operations', 'ACTIVE'),
  ('Warehouse clerk', 'Inventory counts and stock movement', 'Operations', 'ACTIVE'),
  ('Driver', 'Fleet & delivery module, own routes only', 'Commercial', 'ACTIVE'),
  ('Viewer', 'Read-only access to reports & analytics', 'Global', 'DRAFT');

INSERT INTO role_page_access (role_id, page_key)
SELECT (SELECT id FROM app_roles WHERE name = 'System administrator'), page_key FROM pages;

INSERT INTO role_page_access (role_id, page_key)
SELECT (SELECT id FROM app_roles WHERE name = 'Plant manager'), page_key
FROM (VALUES ('dashboard'),('production'),('quality-control'),('water-treatment'),('inventory'),('assets'),('reports')) v(page_key);

INSERT INTO role_page_access (role_id, page_key)
SELECT (SELECT id FROM app_roles WHERE name = 'Sales manager'), page_key
FROM (VALUES ('dashboard'),('sales'),('pos'),('fleet'),('reports')) v(page_key);

INSERT INTO role_page_access (role_id, page_key)
SELECT (SELECT id FROM app_roles WHERE name = 'Finance officer'), page_key
FROM (VALUES ('dashboard'),('finance'),('payroll'),('procurement'),('reports')) v(page_key);

INSERT INTO role_page_access (role_id, page_key)
SELECT (SELECT id FROM app_roles WHERE name = 'QC analyst'), page_key
FROM (VALUES ('dashboard'),('quality-control'),('production'),('water-treatment')) v(page_key);

INSERT INTO role_page_access (role_id, page_key)
SELECT (SELECT id FROM app_roles WHERE name = 'Warehouse clerk'), page_key
FROM (VALUES ('dashboard'),('inventory'),('warehouse'),('procurement')) v(page_key);

INSERT INTO role_page_access (role_id, page_key)
SELECT (SELECT id FROM app_roles WHERE name = 'Driver'), page_key
FROM (VALUES ('dashboard'),('fleet')) v(page_key);

INSERT INTO role_page_access (role_id, page_key)
SELECT (SELECT id FROM app_roles WHERE name = 'Viewer'), page_key
FROM (VALUES ('dashboard'),('reports')) v(page_key);

-- ================================= Employees ==================================
INSERT INTO employees (full_name, department_id, job_title_id, hire_date, status) VALUES
  ('System Administrator', NULL,                                                      (SELECT id FROM job_titles WHERE title='Manager'),   '2021-01-11', 'ACTIVE'),
  ('Chidi Okafor',         (SELECT id FROM departments WHERE name='Production'),       (SELECT id FROM job_titles WHERE title='Manager'),   '2020-03-04', 'ACTIVE'),
  ('Fatima Bello',         (SELECT id FROM departments WHERE name='Quality Control'),  (SELECT id FROM job_titles WHERE title='Analyst'),   '2022-06-14', 'ACTIVE'),
  ('Adesuwa Johnson',      (SELECT id FROM departments WHERE name='Quality Control'),  (SELECT id FROM job_titles WHERE title='Analyst'),   '2023-02-20', 'ACTIVE'),
  ('Ezekiel Adegoke',      (SELECT id FROM departments WHERE name='Production'),       (SELECT id FROM job_titles WHERE title='Operator'),  '2021-09-01', 'ACTIVE'),
  ('Blessing Nwosu',       (SELECT id FROM departments WHERE name='Production'),       (SELECT id FROM job_titles WHERE title='Operator'),  '2022-11-18', 'ACTIVE'),
  ('Ifeanyi Ude',          (SELECT id FROM departments WHERE name='Production'),       (SELECT id FROM job_titles WHERE title='Operator'),  '2024-01-08', 'ACTIVE'),
  ('Abe Ojuma',            (SELECT id FROM departments WHERE name='Warehouse'),        (SELECT id FROM job_titles WHERE title='Driver'),    '2021-05-22', 'ACTIVE'),
  ('Samuel Oke',           (SELECT id FROM departments WHERE name='Warehouse'),        (SELECT id FROM job_titles WHERE title='Driver'),    '2022-08-30', 'ACTIVE'),
  ('Bimpe Musa',           (SELECT id FROM departments WHERE name='Warehouse'),        (SELECT id FROM job_titles WHERE title='Driver'),    '2023-04-17', 'ACTIVE'),
  ('Tunde Bakare',         (SELECT id FROM departments WHERE name='Retail'),           (SELECT id FROM job_titles WHERE title='Sales rep'), '2021-07-09', 'ACTIVE'),
  ('Grace Effiong',        (SELECT id FROM departments WHERE name='Retail'),           (SELECT id FROM job_titles WHERE title='Sales rep'), '2022-10-03', 'ACTIVE'),
  ('Halima Oke',           (SELECT id FROM departments WHERE name='Account'),          (SELECT id FROM job_titles WHERE title='Accountant'),'2020-12-01', 'ACTIVE'),
  ('Obinna Eze',           (SELECT id FROM departments WHERE name='Store'),            (SELECT id FROM job_titles WHERE title='Supervisor'),'2023-03-27', 'ACTIVE');

-- =================================== Users =====================================
INSERT INTO users (employee_id, full_name, email, role_id, status, last_active_at) VALUES
  ((SELECT id FROM employees WHERE full_name='System Administrator'), 'System Administrator', 'admin@elimwater.ng',
    (SELECT id FROM app_roles WHERE name='System administrator'), 'ACTIVE', now()),
  ((SELECT id FROM employees WHERE full_name='Chidi Okafor'), 'Chidi Okafor', 'chidi.okafor@elimwater.ng',
    (SELECT id FROM app_roles WHERE name='Plant manager'), 'ACTIVE', now()),
  ((SELECT id FROM employees WHERE full_name='Fatima Bello'), 'Fatima Bello', 'fatima.bello@elimwater.ng',
    (SELECT id FROM app_roles WHERE name='QC analyst'), 'ACTIVE', now()),
  ((SELECT id FROM employees WHERE full_name='Tunde Bakare'), 'Tunde Bakare', 'tunde.bakare@elimwater.ng',
    (SELECT id FROM app_roles WHERE name='Sales manager'), 'ACTIVE', now()),
  ((SELECT id FROM employees WHERE full_name='Halima Oke'), 'Halima Oke', 'halima.oke@elimwater.ng',
    (SELECT id FROM app_roles WHERE name='Finance officer'), 'ACTIVE', now()),
  ((SELECT id FROM employees WHERE full_name='Obinna Eze'), 'Obinna Eze', 'obinna.eze@elimwater.ng',
    (SELECT id FROM app_roles WHERE name='Warehouse clerk'), 'ACTIVE', now()),
  ((SELECT id FROM employees WHERE full_name='Abe Ojuma'), 'Abe Ojuma', 'abe.ojuma@elimwater.ng',
    (SELECT id FROM app_roles WHERE name='Driver'), 'ACTIVE', now()),
  (NULL, 'Kabiru Yakubu', 'kabiru.yakubu@elimwater.ng', (SELECT id FROM app_roles WHERE name='Viewer'), 'INVITED', NULL);

-- Per-user grants layered on top of the role baseline.
INSERT INTO user_page_access (user_id, page_key) VALUES
  ((SELECT id FROM users WHERE full_name='Kabiru Yakubu'), 'inventory'),
  ((SELECT id FROM users WHERE full_name='Obinna Eze'), 'reports');

-- ================================== Masters ====================================
INSERT INTO suppliers (code, name, location_id, phone, email) VALUES
  (fn_next_code('SUP-'), 'Nyanya Preforms Ventures',     (SELECT id FROM locations WHERE name='Nyanya, FCT'), '+234 803 000 0001', 'sales@nyanyapreforms.ng'),
  (fn_next_code('SUP-'), 'Kubwa Packaging Depot',         (SELECT id FROM locations WHERE name='Kubwa, FCT'),  '+234 803 000 0002', 'info@kubwapack.ng'),
  (fn_next_code('SUP-'), 'Garki Chemical Trading Co.',    (SELECT id FROM locations WHERE name='Garki, FCT'),  '+234 803 000 0003', 'orders@garkichem.ng'),
  (fn_next_code('SUP-'), 'Idu Industrial Supplies Ltd.',  (SELECT id FROM locations WHERE name='Idu, FCT'),    '+234 803 000 0004', 'contact@iduindustrial.ng'),
  (fn_next_code('SUP-'), 'Karu Fuel & Lubricants',        (SELECT id FROM locations WHERE name='Karu, Nasarawa'), '+234 803 000 0005', 'sales@karufuel.ng');

INSERT INTO customers (code, name, location_id, phone, email) VALUES
  (fn_next_code('CUS-'), 'Wuse Mini Mart',              (SELECT id FROM locations WHERE name='Wuse, FCT'),   '+234 805 100 0001', 'orders@wusemart.ng'),
  (fn_next_code('CUS-'), 'Garki Superstore',             (SELECT id FROM locations WHERE name='Garki, FCT'),  '+234 805 100 0002', 'procurement@garkisuper.ng'),
  (fn_next_code('CUS-'), 'Lugbe Distribution Ltd.',      (SELECT id FROM locations WHERE name='Lugbe, FCT'),  '+234 805 100 0003', 'info@lugbedist.ng'),
  (fn_next_code('CUS-'), 'Kuje Retail Stores',            (SELECT id FROM locations WHERE name='Kuje, FCT'),   '+234 805 100 0004', 'sales@kujeretail.ng'),
  (fn_next_code('CUS-'), 'Nyanya Trading Enterprises',    (SELECT id FROM locations WHERE name='Nyanya, FCT'), '+234 805 100 0005', 'contact@nyanyatrading.ng'),
  (fn_next_code('CUS-'), 'Mararaba Depot & Sons',         (SELECT id FROM locations WHERE name='Mararaba, Nasarawa'), '+234 805 100 0006', 'depot@mararaba.ng'),
  (fn_next_code('CUS-'), 'Dutse Ventures',                (SELECT id FROM locations WHERE name='Dutse, FCT'),  '+234 805 100 0007', 'orders@dutseventures.ng'),
  (fn_next_code('CUS-'), 'Jikwoyi Stores',                (SELECT id FROM locations WHERE name='Jikwoyi, FCT'),'+234 805 100 0008', 'info@jikwoyistores.ng'),
  (fn_next_code('CUS-'), 'Gwagwalada Trading Co.',        (SELECT id FROM locations WHERE name='Gwagwalada, FCT'), '+234 805 100 0009', 'sales@gwagwaladatc.ng');

INSERT INTO vehicles (code, default_driver_employee_id, odometer_km, status) VALUES
  (fn_next_code('FLT-'), (SELECT id FROM employees WHERE full_name='Abe Ojuma'),   84210.0, 'ACTIVE'),
  (fn_next_code('FLT-'), (SELECT id FROM employees WHERE full_name='Samuel Oke'), 132900.5, 'ACTIVE'),
  (fn_next_code('FLT-'), (SELECT id FROM employees WHERE full_name='Bimpe Musa'),  45870.0, 'ACTIVE'),
  (fn_next_code('FLT-'), NULL,  61200.0, 'SCHEDULED'),
  (fn_next_code('FLT-'), NULL, 118440.0, 'SUSPENDED');

INSERT INTO items (code, name, category_id, type, uom_code, reorder_point, unit_cost) VALUES
  (fn_next_code('RM-'), 'PET preforms',              (SELECT id FROM item_categories WHERE name='Raw material'), 'RAW_MATERIAL', 'unit', 800,  120.00),
  (fn_next_code('RM-'), 'Bottle caps',                (SELECT id FROM item_categories WHERE name='Packaging'),    'PACKAGING',    'unit', 1200, 15.00),
  (fn_next_code('RM-'), 'Labels',                     (SELECT id FROM item_categories WHERE name='Packaging'),    'PACKAGING',    'roll', 300,  850.00),
  (fn_next_code('RM-'), 'Shrink wraps',               (SELECT id FROM item_categories WHERE name='Packaging'),    'PACKAGING',    'roll', 250,  1400.00),
  (fn_next_code('RM-'), 'Packaging nylon',            (SELECT id FROM item_categories WHERE name='Packaging'),    'PACKAGING',    'roll', 400,  980.00),
  (fn_next_code('RM-'), 'Cartons',                    (SELECT id FROM item_categories WHERE name='Packaging'),    'PACKAGING',    'unit', 600,  310.00),
  (fn_next_code('RM-'), 'Chemicals',                  (SELECT id FROM item_categories WHERE name='Consumable'),   'CONSUMABLE',   'kg',   200,  2100.00),
  (fn_next_code('RM-'), 'Water treatment consumables',(SELECT id FROM item_categories WHERE name='Consumable'),   'CONSUMABLE',   'kg',   150,  1800.00),
  (fn_next_code('RM-'), 'Fuel',                       (SELECT id FROM item_categories WHERE name='Consumable'),   'CONSUMABLE',   'L',    500,  950.00),
  (fn_next_code('RM-'), 'Generator diesel',           (SELECT id FROM item_categories WHERE name='Consumable'),   'CONSUMABLE',   'L',    700,  1050.00),
  (fn_next_code('RM-'), 'Lubricants',                 (SELECT id FROM item_categories WHERE name='Consumable'),   'CONSUMABLE',   'L',    100,  3200.00),
  (fn_next_code('RM-'), 'Spare materials',            (SELECT id FROM item_categories WHERE name='Consumable'),   'CONSUMABLE',   'unit', 80,   4500.00);

INSERT INTO items (code, name, category_id, type, uom_code, reorder_point, unit_cost) VALUES
  (fn_next_code('FG-'), '50cl PET',      (SELECT id FROM item_categories WHERE name='Finished goods'), 'FINISHED_GOOD', 'case', 200, 1800.00),
  (fn_next_code('FG-'), 'Sachet (bags)', (SELECT id FROM item_categories WHERE name='Finished goods'), 'FINISHED_GOOD', 'case', 350, 950.00),
  (fn_next_code('FG-'), '20L Dispenser', (SELECT id FROM item_categories WHERE name='Finished goods'), 'FINISHED_GOOD', 'case', 120, 3200.00),
  (fn_next_code('FG-'), '1.5L PET',      (SELECT id FROM item_categories WHERE name='Finished goods'), 'FINISHED_GOOD', 'case', 180, 2400.00),
  (fn_next_code('FG-'), '75cl PET',      (SELECT id FROM item_categories WHERE name='Finished goods'), 'FINISHED_GOOD', 'case', 150, 2100.00);

INSERT INTO assets (code, equipment_name, location_id, last_service_date, next_due_date, status) VALUES
  (fn_next_code('AST-'), 'RO membrane unit 2', (SELECT id FROM warehouse_locations WHERE name='Raw Material Store'), '2026-05-01', '2026-08-01', 'ACTIVE'),
  (fn_next_code('AST-'), 'UV steriliser 1',    (SELECT id FROM warehouse_locations WHERE name='Line A Floor'),       '2026-04-15', '2026-07-15', 'ACTIVE'),
  (fn_next_code('AST-'), 'Bottling line A',    (SELECT id FROM warehouse_locations WHERE name='Line A Floor'),       '2026-06-01', '2026-09-01', 'ACTIVE'),
  (fn_next_code('AST-'), 'Bottling line B',    (SELECT id FROM warehouse_locations WHERE name='Line B Floor'),       '2026-03-20', '2026-06-20', 'SCHEDULED'),
  (fn_next_code('AST-'), 'Forklift FLT-04',    (SELECT id FROM warehouse_locations WHERE name='Yard'),               '2026-02-10', '2026-05-10', 'SUSPENDED'),
  (fn_next_code('AST-'), 'Generator 500kVA',   (SELECT id FROM warehouse_locations WHERE name='Yard'),               '2026-05-25', '2026-08-25', 'ACTIVE');

INSERT INTO settings (setting_key, description, value, updated_by_employee_id, status) VALUES
  ('Company name', 'Legal entity name on invoices and reports', 'Elim Water Factory Ltd.', (SELECT id FROM employees WHERE full_name='System Administrator'), 'ACTIVE'),
  ('Base currency', 'Currency used across finance and sales', 'NGN (₦)', (SELECT id FROM employees WHERE full_name='System Administrator'), 'ACTIVE'),
  ('Timezone', 'Used for all timestamps in the system', 'Africa/Lagos (WAT)', (SELECT id FROM employees WHERE full_name='System Administrator'), 'ACTIVE'),
  ('VAT rate', 'Applied to taxable sales and invoices', '7.5%', (SELECT id FROM employees WHERE full_name='Halima Oke'), 'ACTIVE'),
  ('Default warehouse', 'Warehouse assumed for new inventory items', 'Idu Central Warehouse', (SELECT id FROM employees WHERE full_name='Obinna Eze'), 'ACTIVE'),
  ('Low stock threshold', 'Percent of reorder point that triggers an alert', '20%', (SELECT id FROM employees WHERE full_name='Obinna Eze'), 'ACTIVE'),
  ('Notification email', 'Recipient for system alerts and daily digests', 'ops@elimwater.ng', (SELECT id FROM employees WHERE full_name='System Administrator'), 'ACTIVE'),
  ('Session timeout', 'Idle time before a user is signed out', '30 minutes', (SELECT id FROM employees WHERE full_name='System Administrator'), 'ACTIVE');

WITH ins AS (
  INSERT INTO water_treatment_runs (code, source_id, stage_id, volume_l, operator_employee_id, status, tested_at) VALUES
    (fn_next_code('TR-'), (SELECT id FROM water_sources WHERE code='BOREHOLE-01'), (SELECT id FROM treatment_stages WHERE name='Full cycle'),  15400, (SELECT id FROM employees WHERE full_name='Ezekiel Adegoke'), 'PASS',        now() - interval '6 days'),
    (fn_next_code('TR-'), (SELECT id FROM water_sources WHERE code='BOREHOLE-02'), (SELECT id FROM treatment_stages WHERE name='RO stage'),     12800, (SELECT id FROM employees WHERE full_name='Ezekiel Adegoke'), 'PASS',        now() - interval '5 days'),
    (fn_next_code('TR-'), (SELECT id FROM water_sources WHERE code='BOREHOLE-01'), (SELECT id FROM treatment_stages WHERE name='UV stage'),      9600, (SELECT id FROM employees WHERE full_name='Blessing Nwosu'),   'PASS',        now() - interval '4 days'),
    (fn_next_code('TR-'), (SELECT id FROM water_sources WHERE code='BOREHOLE-03'), (SELECT id FROM treatment_stages WHERE name='Ozone stage'),  11200, (SELECT id FROM employees WHERE full_name='Blessing Nwosu'),   'IN_PROGRESS', now() - interval '1 days'),
    (fn_next_code('TR-'), (SELECT id FROM water_sources WHERE code='BOREHOLE-04'), (SELECT id FROM treatment_stages WHERE name='Full cycle'),   13900, (SELECT id FROM employees WHERE full_name='Ifeanyi Ude'),      'FAIL',        now() - interval '3 days')
  RETURNING id, code
)
INSERT INTO seed_map SELECT 'water_run', code, id FROM ins;

-- ===================== Procurement -> receiving -> QC -> inventory =============

-- PO 1: PET preforms + bottle caps from Nyanya Preforms Ventures — approved, received, QC-passed.
WITH ins AS (
  INSERT INTO purchase_orders (code, supplier_id, requested_by_employee_id, status)
  VALUES (fn_next_code('PO-2026-'), (SELECT id FROM suppliers WHERE name='Nyanya Preforms Ventures'), (SELECT id FROM employees WHERE full_name='Obinna Eze'), 'DRAFT')
  RETURNING id
)
INSERT INTO seed_map SELECT 'po', 'PO-preforms', id FROM ins;

INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES
  ((SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms'), (SELECT id FROM items WHERE name='PET preforms'), 5000, 120.00),
  ((SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms'), (SELECT id FROM items WHERE name='Bottle caps'),  6000, 15.00);

UPDATE purchase_orders SET status = 'APPROVED' WHERE id = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms');

SELECT fn_receive_goods(
  (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms'),
  (SELECT id FROM employees WHERE full_name='Obinna Eze'),
  jsonb_build_array(
    jsonb_build_object('item_id', (SELECT id FROM items WHERE name='PET preforms'), 'quantity', 5000),
    jsonb_build_object('item_id', (SELECT id FROM items WHERE name='Bottle caps'),  'quantity', 6000)
  )
);

INSERT INTO quality_control (code, ref_type, ref_id, inspector_employee_id, parameter, result, verdict, tested_at)
SELECT fn_next_code('QC-'), 'GOODS_RECEIVED', gr.id, (SELECT id FROM employees WHERE full_name='Fatima Bello'), 'Batch inspection', 'Within spec', 'PASS', now()
FROM goods_received gr WHERE gr.po_id = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms');

UPDATE goods_received   SET status = 'PASSED'   WHERE po_id = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms');
UPDATE purchase_orders  SET status = 'RECEIVED'  WHERE id   = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms');

-- PO 2: chemicals + water treatment consumables from Garki Chemical Trading Co. — approved, received, QC-passed.
WITH ins AS (
  INSERT INTO purchase_orders (code, supplier_id, requested_by_employee_id, status)
  VALUES (fn_next_code('PO-2026-'), (SELECT id FROM suppliers WHERE name='Garki Chemical Trading Co.'), (SELECT id FROM employees WHERE full_name='Obinna Eze'), 'DRAFT')
  RETURNING id
)
INSERT INTO seed_map SELECT 'po', 'PO-chemicals', id FROM ins;

INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES
  ((SELECT id FROM seed_map WHERE kind='po' AND label='PO-chemicals'), (SELECT id FROM items WHERE name='Chemicals'),                   900, 2100.00),
  ((SELECT id FROM seed_map WHERE kind='po' AND label='PO-chemicals'), (SELECT id FROM items WHERE name='Water treatment consumables'), 600, 1800.00);

UPDATE purchase_orders SET status = 'APPROVED' WHERE id = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-chemicals');

SELECT fn_receive_goods(
  (SELECT id FROM seed_map WHERE kind='po' AND label='PO-chemicals'),
  (SELECT id FROM employees WHERE full_name='Obinna Eze'),
  jsonb_build_array(
    jsonb_build_object('item_id', (SELECT id FROM items WHERE name='Chemicals'),                   'quantity', 900),
    jsonb_build_object('item_id', (SELECT id FROM items WHERE name='Water treatment consumables'), 'quantity', 600)
  )
);

INSERT INTO quality_control (code, ref_type, ref_id, inspector_employee_id, parameter, result, verdict, tested_at)
SELECT fn_next_code('QC-'), 'GOODS_RECEIVED', gr.id, (SELECT id FROM employees WHERE full_name='Adesuwa Johnson'), 'Batch inspection', 'Within spec', 'PASS', now()
FROM goods_received gr WHERE gr.po_id = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-chemicals');

UPDATE goods_received   SET status = 'PASSED'   WHERE po_id = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-chemicals');
UPDATE purchase_orders  SET status = 'RECEIVED'  WHERE id   = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-chemicals');

-- PO 3: packaging materials from Kubwa Packaging Depot — approved, not yet received.
WITH ins AS (
  INSERT INTO purchase_orders (code, supplier_id, requested_by_employee_id, status)
  VALUES (fn_next_code('PO-2026-'), (SELECT id FROM suppliers WHERE name='Kubwa Packaging Depot'), (SELECT id FROM employees WHERE full_name='Obinna Eze'), 'APPROVED')
  RETURNING id
)
INSERT INTO seed_map SELECT 'po', 'PO-packaging', id FROM ins;

INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES
  ((SELECT id FROM seed_map WHERE kind='po' AND label='PO-packaging'), (SELECT id FROM items WHERE name='Labels'),  400, 850.00),
  ((SELECT id FROM seed_map WHERE kind='po' AND label='PO-packaging'), (SELECT id FROM items WHERE name='Cartons'), 700, 310.00);

-- PO 4: fuel & lubricants from Karu Fuel & Lubricants — rejected at approval.
INSERT INTO purchase_orders (code, supplier_id, requested_by_employee_id, status) VALUES
  (fn_next_code('PO-2026-'), (SELECT id FROM suppliers WHERE name='Karu Fuel & Lubricants'), (SELECT id FROM employees WHERE full_name='Obinna Eze'), 'REJECTED');

-- PO 5: spare materials from Idu Industrial Supplies Ltd. — still a draft requisition.
INSERT INTO purchase_orders (code, supplier_id, requested_by_employee_id, status) VALUES
  (fn_next_code('PO-2026-'), (SELECT id FROM suppliers WHERE name='Idu Industrial Supplies Ltd.'), (SELECT id FROM employees WHERE full_name='Obinna Eze'), 'DRAFT');

-- ============================ Warehouse requisitions ===========================
INSERT INTO warehouse_requisitions (code, item_id, quantity, expected_delivery, priority, reason, department_id, requested_by_employee_id, status) VALUES
  (fn_next_code('WR-'), (SELECT id FROM items WHERE name='Shrink wraps'),      150, current_date + 7, 'MEDIUM', 'Stock running low ahead of next delivery', (SELECT id FROM departments WHERE name='Store'),  (SELECT id FROM employees WHERE full_name='Obinna Eze'), 'PENDING'),
  (fn_next_code('WR-'), (SELECT id FROM items WHERE name='Lubricants'),         40, current_date + 3, 'HIGH',   'Needed for scheduled maintenance',          (SELECT id FROM departments WHERE name='Production'), (SELECT id FROM employees WHERE full_name='Chidi Okafor'), 'APPROVED'),
  (fn_next_code('WR-'), (SELECT id FROM items WHERE name='Generator diesel'),  300, current_date + 2, 'URGENT', 'Urgent shortfall on the line',               (SELECT id FROM departments WHERE name='Production'), (SELECT id FROM employees WHERE full_name='Chidi Okafor'), 'ISSUED');

-- ================== Material requests -> issue -> stock movement ===============
WITH ins AS (
  INSERT INTO material_requests (code, requested_by_employee_id, department_id, status, needed_by)
  VALUES (fn_next_code('MR-'), (SELECT id FROM employees WHERE full_name='Chidi Okafor'), (SELECT id FROM departments WHERE name='Production'), 'PENDING', current_date + 2)
  RETURNING id
)
INSERT INTO seed_map SELECT 'mr', 'MR-line-a', id FROM ins;

INSERT INTO material_request_items (request_id, item_id, quantity) VALUES
  ((SELECT id FROM seed_map WHERE kind='mr' AND label='MR-line-a'), (SELECT id FROM items WHERE name='PET preforms'), 3200),
  ((SELECT id FROM seed_map WHERE kind='mr' AND label='MR-line-a'), (SELECT id FROM items WHERE name='Bottle caps'),  3200);

SELECT fn_issue_material_request(
  (SELECT id FROM seed_map WHERE kind='mr' AND label='MR-line-a'),
  (SELECT id FROM employees WHERE full_name='Obinna Eze'),
  (SELECT id FROM warehouse_locations WHERE name='Raw Material Store'),
  (SELECT id FROM warehouse_locations WHERE name='Line A Floor')
);

-- A second request, still pending.
INSERT INTO material_requests (code, requested_by_employee_id, department_id, status, needed_by) VALUES
  (fn_next_code('MR-'), (SELECT id FROM employees WHERE full_name='Chidi Okafor'), (SELECT id FROM departments WHERE name='Production'), 'PENDING', current_date + 5);

-- ========================= Production -> QC -> packaging ========================

-- Batch 1: 50cl PET, Line A — completed, QC pass, packaged.
WITH ins AS (
  INSERT INTO production_batches (code, product_item_id, line_id, shift_id, operator_employee_id, units_target, units_actual, status, water_treatment_run_id, started_at)
  VALUES (
    fn_next_code('PB-'), (SELECT id FROM items WHERE name='50cl PET'),
    (SELECT id FROM production_lines WHERE name='Line A'), (SELECT id FROM shifts WHERE name='Morning'),
    (SELECT id FROM employees WHERE full_name='Ezekiel Adegoke'),
    20000, 19600, 'IN_PROGRESS',
    (SELECT id FROM seed_map WHERE kind='water_run' ORDER BY label LIMIT 1),
    now() - interval '2 days'
  )
  RETURNING id
)
INSERT INTO seed_map SELECT 'batch', 'PB-50cl', id FROM ins;

SELECT fn_complete_production_batch((SELECT id FROM seed_map WHERE kind='batch' AND label='PB-50cl'));

INSERT INTO quality_control (code, ref_type, ref_id, inspector_employee_id, parameter, result, verdict, tested_at) VALUES
  (fn_next_code('QC-'), 'PRODUCTION_BATCH', (SELECT id FROM seed_map WHERE kind='batch' AND label='PB-50cl'), (SELECT id FROM employees WHERE full_name='Fatima Bello'), 'Fill volume & seal', 'Pass', 'PASS', now());

INSERT INTO finished_goods (batch_id, item_id, quantity, packaged_by_employee_id, packaged_at) VALUES
  ((SELECT id FROM seed_map WHERE kind='batch' AND label='PB-50cl'), (SELECT id FROM items WHERE name='50cl PET'), 816, (SELECT id FROM employees WHERE full_name='Blessing Nwosu'), now());

SELECT fn_post_inventory_transaction(
  (SELECT id FROM items WHERE name='50cl PET'), 'IN', 816, 1800.00, 'PRODUCTION',
  (SELECT id FROM seed_map WHERE kind='batch' AND label='PB-50cl'), 'Packaged from batch', (SELECT id FROM employees WHERE full_name='Blessing Nwosu')
);

-- Batch 2: 20L Dispenser, Line B — completed, QC pass, packaged.
WITH ins AS (
  INSERT INTO production_batches (code, product_item_id, line_id, shift_id, operator_employee_id, units_target, units_actual, status, water_treatment_run_id, started_at)
  VALUES (
    fn_next_code('PB-'), (SELECT id FROM items WHERE name='20L Dispenser'),
    (SELECT id FROM production_lines WHERE name='Line B'), (SELECT id FROM shifts WHERE name='Afternoon'),
    (SELECT id FROM employees WHERE full_name='Blessing Nwosu'),
    9000, 8800, 'IN_PROGRESS',
    (SELECT id FROM seed_map WHERE kind='water_run' ORDER BY label OFFSET 1 LIMIT 1),
    now() - interval '1 days'
  )
  RETURNING id
)
INSERT INTO seed_map SELECT 'batch', 'PB-20L', id FROM ins;

SELECT fn_complete_production_batch((SELECT id FROM seed_map WHERE kind='batch' AND label='PB-20L'));

INSERT INTO quality_control (code, ref_type, ref_id, inspector_employee_id, parameter, result, verdict, tested_at) VALUES
  (fn_next_code('QC-'), 'PRODUCTION_BATCH', (SELECT id FROM seed_map WHERE kind='batch' AND label='PB-20L'), (SELECT id FROM employees WHERE full_name='Adesuwa Johnson'), 'Fill volume & seal', 'Pass', 'PASS', now());

INSERT INTO finished_goods (batch_id, item_id, quantity, packaged_by_employee_id, packaged_at) VALUES
  ((SELECT id FROM seed_map WHERE kind='batch' AND label='PB-20L'), (SELECT id FROM items WHERE name='20L Dispenser'), 366, (SELECT id FROM employees WHERE full_name='Ifeanyi Ude'), now());

SELECT fn_post_inventory_transaction(
  (SELECT id FROM items WHERE name='20L Dispenser'), 'IN', 366, 3200.00, 'PRODUCTION',
  (SELECT id FROM seed_map WHERE kind='batch' AND label='PB-20L'), 'Packaged from batch', (SELECT id FROM employees WHERE full_name='Ifeanyi Ude')
);

-- Batch 3: 1.5L PET, Line C — failed QC, no packaging follows.
WITH ins AS (
  INSERT INTO production_batches (code, product_item_id, line_id, shift_id, operator_employee_id, units_target, units_actual, status, started_at)
  VALUES (
    fn_next_code('PB-'), (SELECT id FROM items WHERE name='1.5L PET'),
    (SELECT id FROM production_lines WHERE name='Line C'), (SELECT id FROM shifts WHERE name='Night'),
    (SELECT id FROM employees WHERE full_name='Ezekiel Adegoke'),
    12000, 11400, 'IN_PROGRESS', now() - interval '3 hours'
  )
  RETURNING id
)
INSERT INTO seed_map SELECT 'batch', 'PB-1.5L', id FROM ins;

UPDATE production_batches SET status = 'FAILED', completed_at = now()
WHERE id = (SELECT id FROM seed_map WHERE kind='batch' AND label='PB-1.5L');

INSERT INTO quality_control (code, ref_type, ref_id, inspector_employee_id, parameter, result, verdict, notes, tested_at) VALUES
  (fn_next_code('QC-'), 'PRODUCTION_BATCH', (SELECT id FROM seed_map WHERE kind='batch' AND label='PB-1.5L'), (SELECT id FROM employees WHERE full_name='Fatima Bello'), 'Fill volume & seal', 'Under-fill detected', 'FAIL', 'Line C fill head recalibration required', now());

-- =========================== Sales -> fleet dispatch ============================
WITH ins AS (
  SELECT fn_create_sales_order(
    (SELECT id FROM customers WHERE name='Wuse Mini Mart'), 'INVOICE',
    (SELECT id FROM employees WHERE full_name='Tunde Bakare'),
    jsonb_build_array(jsonb_build_object('item_id', (SELECT id FROM items WHERE name='50cl PET'), 'quantity', 120, 'unit_price', 1800.00))
  ) AS id
)
INSERT INTO seed_map SELECT 'so', 'SO-1', id FROM ins;

WITH ins AS (
  SELECT fn_create_sales_order(
    (SELECT id FROM customers WHERE name='Garki Superstore'), 'INVOICE',
    (SELECT id FROM employees WHERE full_name='Grace Effiong'),
    jsonb_build_array(jsonb_build_object('item_id', (SELECT id FROM items WHERE name='20L Dispenser'), 'quantity', 60, 'unit_price', 3600.00))
  ) AS id
)
INSERT INTO seed_map SELECT 'so', 'SO-2', id FROM ins;

WITH ins AS (
  SELECT fn_create_sales_order(
    (SELECT id FROM customers WHERE name='Lugbe Distribution Ltd.'), 'POS',
    (SELECT id FROM employees WHERE full_name='Tunde Bakare'),
    jsonb_build_array(jsonb_build_object('item_id', (SELECT id FROM items WHERE name='50cl PET'), 'quantity', 40, 'unit_price', 1850.00))
  ) AS id
)
INSERT INTO seed_map SELECT 'so', 'SO-3', id FROM ins;

-- POS sales settle at the till immediately.
UPDATE sales_orders SET status = 'PAID' WHERE id = (SELECT id FROM seed_map WHERE kind='so' AND label='SO-3');

-- SO-1 dispatched and delivered; SO-2 dispatched, still on the road; SO-3 is a POS till sale (no delivery run).
WITH ins AS (
  SELECT fn_dispatch_delivery(
    (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1'),
    (SELECT id FROM vehicles WHERE default_driver_employee_id = (SELECT id FROM employees WHERE full_name='Abe Ojuma')),
    (SELECT id FROM employees WHERE full_name='Abe Ojuma'),
    'Wuse - Garki loop'
  ) AS id
)
INSERT INTO seed_map SELECT 'dr', 'DR-1', id FROM ins;
SELECT fn_mark_delivered((SELECT id FROM seed_map WHERE kind='dr' AND label='DR-1'));

SELECT fn_dispatch_delivery(
  (SELECT id FROM seed_map WHERE kind='so' AND label='SO-2'),
  (SELECT id FROM vehicles WHERE default_driver_employee_id = (SELECT id FROM employees WHERE full_name='Samuel Oke')),
  (SELECT id FROM employees WHERE full_name='Samuel Oke'),
  'Lugbe - Kuje route'
);

-- =================================== Finance ====================================

-- Sale on SO-1: revenue recognised + inventory relieved at cost.
INSERT INTO ledger_entries (account_id, debit, credit, reference_type, reference_id, description) VALUES
  ((SELECT id FROM chart_of_accounts WHERE code='1100'), 216000.00, 0, 'SALES_ORDER', (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1'), 'Invoice raised — Wuse Mini Mart'),
  ((SELECT id FROM chart_of_accounts WHERE code='4000'), 0, 216000.00, 'SALES_ORDER', (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1'), 'Sales revenue — Wuse Mini Mart'),
  ((SELECT id FROM chart_of_accounts WHERE code='5000'), 216000.00, 0, 'SALES_ORDER', (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1'), 'COGS — 120 cases 50cl PET'),
  ((SELECT id FROM chart_of_accounts WHERE code='1200'), 0, 216000.00, 'SALES_ORDER', (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1'), 'Inventory relieved — 120 cases 50cl PET');

INSERT INTO receipts (code, counterparty_type, counterparty_id, amount, method, reference_type, reference_id, status, received_at) VALUES
  (fn_next_code('RCT-'), 'CUSTOMER', (SELECT id FROM customers WHERE name='Wuse Mini Mart'), 216000.00, 'BANK_TRANSFER', 'SALES_ORDER', (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1'), 'CLEARED', now());

INSERT INTO ledger_entries (account_id, debit, credit, reference_type, reference_id, description) VALUES
  ((SELECT id FROM chart_of_accounts WHERE code='1010'), 216000.00, 0, 'SALES_ORDER', (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1'), 'Receipt cleared — Wuse Mini Mart'),
  ((SELECT id FROM chart_of_accounts WHERE code='1100'), 0, 216000.00, 'SALES_ORDER', (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1'), 'Accounts receivable cleared — Wuse Mini Mart');

UPDATE sales_orders SET status = 'PAID' WHERE id = (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1');

-- Purchase on PO-preforms: inventory received on credit, then paid.
INSERT INTO ledger_entries (account_id, debit, credit, reference_type, reference_id, description) VALUES
  ((SELECT id FROM chart_of_accounts WHERE code='1200'), 690000.00, 0, 'PURCHASE_ORDER', (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms'), 'Goods received — PET preforms & bottle caps'),
  ((SELECT id FROM chart_of_accounts WHERE code='2000'), 0, 690000.00, 'PURCHASE_ORDER', (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms'), 'Accounts payable — Nyanya Preforms Ventures');

INSERT INTO payments (code, counterparty_type, counterparty_id, amount, method, reference_type, reference_id, status, paid_at) VALUES
  (fn_next_code('PAY-'), 'SUPPLIER', (SELECT id FROM suppliers WHERE name='Nyanya Preforms Ventures'), 690000.00, 'BANK_TRANSFER', 'PURCHASE_ORDER', (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms'), 'CLEARED', now());

INSERT INTO ledger_entries (account_id, debit, credit, reference_type, reference_id, description) VALUES
  ((SELECT id FROM chart_of_accounts WHERE code='2000'), 690000.00, 0, 'PURCHASE_ORDER', (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms'), 'Accounts payable settled — Nyanya Preforms Ventures'),
  ((SELECT id FROM chart_of_accounts WHERE code='1010'), 0, 690000.00, 'PURCHASE_ORDER', (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms'), 'Payment issued — Nyanya Preforms Ventures');

-- Recurring operating expenses (no PO/GRN behind these — plain EXPENSE references).
INSERT INTO payments (code, counterparty_type, counterparty_label, amount, method, reference_type, status, paid_at) VALUES
  (fn_next_code('PAY-'), 'OTHER', 'Diesel supplier', 182500.00, 'BANK_TRANSFER', 'EXPENSE', 'CLEARED', now() - interval '2 days'),
  (fn_next_code('PAY-'), 'OTHER', 'PHCN / power',    264000.00, 'BANK_TRANSFER', 'EXPENSE', 'CLEARED', now() - interval '1 days');

INSERT INTO ledger_entries (account_id, debit, credit, reference_type, description) VALUES
  ((SELECT id FROM chart_of_accounts WHERE code='5300'), 182500.00, 0, 'EXPENSE', 'Fuel — diesel supplier'),
  ((SELECT id FROM chart_of_accounts WHERE code='1010'), 0, 182500.00, 'EXPENSE', 'Payment issued — diesel supplier'),
  ((SELECT id FROM chart_of_accounts WHERE code='5200'), 264000.00, 0, 'EXPENSE', 'Utilities — PHCN / power'),
  ((SELECT id FROM chart_of_accounts WHERE code='1010'), 0, 264000.00, 'EXPENSE', 'Payment issued — PHCN / power');

-- Payroll: June (paid) and July (mixed) runs for a cross-section of staff.
WITH pay AS (
  SELECT * FROM (VALUES
    ('Chidi Okafor',   450000.00, 369000.00),
    ('Fatima Bello',   280000.00, 229600.00),
    ('Halima Oke',     320000.00, 262400.00),
    ('Ezekiel Adegoke',180000.00, 147600.00),
    ('Abe Ojuma',      150000.00, 123000.00),
    ('Tunde Bakare',   260000.00, 213200.00)
  ) AS t(employee_name, gross, net)
)
INSERT INTO payroll_runs (code, employee_id, period_month, gross, net, status, created_at)
SELECT fn_next_code('PYR-2026-'), (SELECT id FROM employees WHERE full_name = pay.employee_name), '2026-06-01', pay.gross, pay.net, 'PAID', '2026-06-28'
FROM pay;

WITH pay AS (
  SELECT * FROM (VALUES
    ('Chidi Okafor',   450000.00, 369000.00, 'PAID'),
    ('Fatima Bello',   280000.00, 229600.00, 'PAID'),
    ('Halima Oke',     320000.00, 262400.00, 'SCHEDULED'),
    ('Ezekiel Adegoke',180000.00, 147600.00, 'SCHEDULED'),
    ('Abe Ojuma',      150000.00, 123000.00, 'ON_HOLD'),
    ('Tunde Bakare',   260000.00, 213200.00, 'SCHEDULED')
  ) AS t(employee_name, gross, net, status)
)
INSERT INTO payroll_runs (code, employee_id, period_month, gross, net, status, created_at)
SELECT fn_next_code('PYR-2026-'), (SELECT id FROM employees WHERE full_name = pay.employee_name), '2026-07-01', pay.gross, pay.net, pay.status::payroll_status_enum, '2026-07-28'
FROM pay;

INSERT INTO ledger_entries (account_id, debit, credit, reference_type, reference_id, description)
SELECT (SELECT id FROM chart_of_accounts WHERE code='5100'), gross, 0, 'PAYROLL_RUN', id, 'Payroll expense — ' || code FROM payroll_runs WHERE status = 'PAID'
UNION ALL
SELECT (SELECT id FROM chart_of_accounts WHERE code='1010'), 0, gross, 'PAYROLL_RUN', id, 'Payroll paid — ' || code FROM payroll_runs WHERE status = 'PAID';

-- =================================== Reports =====================================
INSERT INTO reports (code, name, scope, owner_employee_id, status, last_run_at) VALUES
  (fn_next_code('RPT-'), 'Weekly production summary', 'Plant-wide', (SELECT id FROM employees WHERE full_name='Chidi Okafor'), 'COMPLETED', now() - interval '1 days'),
  (fn_next_code('RPT-'), 'Monthly revenue report',    'Finance',    (SELECT id FROM employees WHERE full_name='Halima Oke'),   'COMPLETED', now() - interval '3 days'),
  (fn_next_code('RPT-'), 'QC exceptions',              'Operations', (SELECT id FROM employees WHERE full_name='Fatima Bello'), 'COMPLETED', now() - interval '2 days'),
  (fn_next_code('RPT-'), 'Fleet utilisation',           'Commercial', (SELECT id FROM employees WHERE full_name='Tunde Bakare'), 'RUNNING', now()),
  (fn_next_code('RPT-'), 'Inventory ageing',            'Plant-wide', (SELECT id FROM employees WHERE full_name='Obinna Eze'),   'COMPLETED', now() - interval '4 days'),
  (fn_next_code('RPT-'), 'Payroll register',            'Finance',    (SELECT id FROM employees WHERE full_name='Halima Oke'),   'COMPLETED', now() - interval '5 days'),
  (fn_next_code('RPT-'), 'Customer aging',               'Commercial', (SELECT id FROM employees WHERE full_name='Grace Effiong'), 'FAILED', now() - interval '6 hours'),
  (fn_next_code('RPT-'), 'Water quality trend',          'Operations', (SELECT id FROM employees WHERE full_name='Adesuwa Johnson'), 'COMPLETED', now() - interval '2 days');

-- ================================= Activity log ==================================
INSERT INTO activity_log (actor_user_id, action, target_type, target_id, summary, at) VALUES
  ((SELECT id FROM users WHERE full_name='Obinna Eze'),   'created',  'procurement',     (SELECT code FROM purchase_orders WHERE id = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms')), 'Raised PO for PET preforms & bottle caps', now() - interval '4 days'),
  ((SELECT id FROM users WHERE full_name='Chidi Okafor'), 'approved', 'procurement',     (SELECT code FROM purchase_orders WHERE id = (SELECT id FROM seed_map WHERE kind='po' AND label='PO-preforms')), 'Approved PO for PET preforms & bottle caps', now() - interval '4 days'),
  ((SELECT id FROM users WHERE full_name='Fatima Bello'), 'recorded', 'quality-control', 'QC-0001', 'Passed batch inspection on incoming preforms', now() - interval '3 days'),
  ((SELECT id FROM users WHERE full_name='Chidi Okafor'), 'created',  'production',      (SELECT code FROM production_batches WHERE id = (SELECT id FROM seed_map WHERE kind='batch' AND label='PB-50cl')), 'Started 50cl PET run on Line A', now() - interval '2 days'),
  ((SELECT id FROM users WHERE full_name='Tunde Bakare'), 'created',  'sales',           (SELECT code FROM sales_orders WHERE id = (SELECT id FROM seed_map WHERE kind='so' AND label='SO-1')), 'Invoice raised for Wuse Mini Mart', now() - interval '1 days'),
  ((SELECT id FROM users WHERE full_name='Abe Ojuma'),    'updated',  'fleet',           (SELECT code FROM delivery_runs WHERE id = (SELECT id FROM seed_map WHERE kind='dr' AND label='DR-1')), 'Marked delivery run delivered', now()),
  ((SELECT id FROM users WHERE full_name='Halima Oke'),   'recorded', 'finance',         'RCT-0001', 'Recorded receipt against SO-1', now()),
  ((SELECT id FROM users WHERE full_name='System Administrator'), 'updated', 'settings', 'VAT rate', 'Updated VAT rate to 7.5%', now() - interval '10 days');

-- =============================== Deletion requests ================================

-- PENDING: a grounded asset flagged for removal.
INSERT INTO deletion_requests (entity_type, entity_id, entity_label, requested_by_user_id, reason, status, requested_at) VALUES
  ('assets', (SELECT id FROM assets WHERE equipment_name='Forklift FLT-04'), 'Forklift FLT-04',
   (SELECT id FROM users WHERE full_name='Obinna Eze'), 'Decommissioned — beyond economical repair', 'PENDING', now() - interval '2 days');

-- REJECTED: a suspended vehicle, kept for spare parts.
INSERT INTO deletion_requests (entity_type, entity_id, entity_label, requested_by_user_id, reason, status, requested_at, reviewed_by_user_id, reviewed_at, review_note) VALUES
  ('vehicles', (SELECT id FROM vehicles WHERE status='SUSPENDED' AND default_driver_employee_id IS NULL), (SELECT code FROM vehicles WHERE status='SUSPENDED' AND default_driver_employee_id IS NULL),
   (SELECT id FROM users WHERE full_name='Chidi Okafor'), 'Vehicle grounded long-term, remove from fleet list', 'REJECTED',
   now() - interval '6 days', (SELECT id FROM users WHERE full_name='System Administrator'), now() - interval '5 days', 'Still needed for spare parts inventory');

-- APPROVED: a duplicate customer record. Inserted PENDING and then actually
-- updated to APPROVED (rather than inserted pre-approved) so this goes
-- through the real trigger path — trg_deletion_requests_apply (0012) only
-- fires on the PENDING -> APPROVED transition, and stamps customers.deleted_at
-- the moment that UPDATE commits.
WITH ins AS (
  INSERT INTO deletion_requests (entity_type, entity_id, entity_label, requested_by_user_id, reason, status, requested_at)
  VALUES ('customers', (SELECT id FROM customers WHERE name='Dutse Ventures'), 'Dutse Ventures',
          (SELECT id FROM users WHERE full_name='Tunde Bakare'), 'Duplicate of an existing customer record', 'PENDING', now() - interval '5 days')
  RETURNING id
)
UPDATE deletion_requests SET
  status = 'APPROVED',
  reviewed_by_user_id = (SELECT id FROM users WHERE full_name='System Administrator'),
  reviewed_at = now() - interval '4 days',
  review_note = 'Confirmed duplicate, merged into existing account'
WHERE id = (SELECT id FROM ins);
