-- ============================================================================
-- DEMO / SAMPLE DATA SEED
-- ----------------------------------------------------------------------------
-- Populates every module (customers, suppliers, employees, raw materials,
-- finished goods, production, production requests, sales, expenses, payroll,
-- cash flow, costing, logistics) with realistic sample rows across both
-- factories, so every page has something to show instead of an empty state.
--
-- Run this ONCE, as the `postgres` role, via the Supabase Dashboard's
-- SQL Editor (Table Editor RLS and RPC permission guards do not apply there).
-- It intentionally does NOT touch `auth.users` / `profiles` / `user_roles`
-- (fabricating fake login accounts via raw SQL is unsafe and unsupported by
-- Supabase Auth) — so the Users and Account Approvals pages will still only
-- show real registered accounts.
--
-- All generated reference numbers (invoices, production runs, receipts,
-- etc.) are prefixed "DEMO-" so this data is trivially identifiable and easy
-- to bulk-delete later — see the cleanup block commented out at the bottom
-- of this file.
-- ============================================================================

DO $$
DECLARE
  v_water uuid;
  v_nylon uuid;
  v_admin_id uuid;

  -- suppliers
  v_sup_purechem uuid;
  v_sup_aquapack uuid;
  v_sup_deltapreform uuid;
  v_sup_polymer uuid;
  v_sup_nylonpack uuid;

  -- customers
  v_cust_everfresh uuid;
  v_cust_blueocean uuid;
  v_cust_greenleaf uuid;
  v_cust_citymart uuid;
  v_cust_sunrise uuid;
  v_cust_metro uuid;
  v_cust_fastwrap uuid;
  v_cust_primeretail uuid;
  v_cust_zenith uuid;

  -- employees
  v_emp_ade uuid;
  v_emp_grace uuid;
  v_emp_michael uuid;
  v_emp_blessing uuid;
  v_emp_emeka uuid;
  v_emp_fatima uuid;
  v_emp_chidi uuid;

  -- product categories
  v_cat_bottled uuid;
  v_cat_sachet uuid;
  v_cat_bags uuid;
  v_cat_rolls uuid;

  -- products
  v_prod_50cl uuid;
  v_prod_75cl uuid;
  v_prod_sachet uuid;
  v_prod_preform uuid;
  v_prod_bagsmall uuid;
  v_prod_baglarge uuid;
  v_prod_roll uuid;
  v_prod_pellet uuid;

  -- raw materials
  v_rm_petpreform uuid;
  v_rm_caps uuid;
  v_rm_shrinkwrap uuid;
  v_rm_chemicals uuid;
  v_rm_ldpe uuid;
  v_rm_hdpe uuid;
  v_rm_masterbatch uuid;

  -- production requests / production
  v_pr_water1 uuid;
  v_pr_water2 uuid;
  v_pr_nylon1 uuid;
  v_prodrun_water1 uuid;
  v_prodrun_nylon1 uuid;

  -- expense categories (looked up, pre-seeded per factory)
  v_ec_utilities_w uuid; v_ec_transport_w uuid; v_ec_maintenance_w uuid; v_ec_office_w uuid;
  v_ec_utilities_n uuid; v_ec_operational_n uuid; v_ec_transport_n uuid;

  -- sales / debts
  v_sale_w1 uuid; v_sale_w2 uuid; v_sale_w3 uuid; v_sale_w4 uuid; v_sale_w5 uuid;
  v_sale_n1 uuid; v_sale_n2 uuid; v_sale_n3 uuid;
  v_debt_w3 uuid; v_debt_w4 uuid; v_debt_n3 uuid;

  -- costing
  v_costing_w uuid;
  v_costing_n uuid;

  -- logistics
  v_vehicle_w uuid; v_vehicle_n uuid;
  v_driver_w uuid; v_driver_n uuid;
  v_route_w uuid; v_route_n uuid;

  v_payroll_month int := extract(month from current_date - interval '1 month')::int;
  v_payroll_year  int := extract(year  from current_date - interval '1 month')::int;
BEGIN
  -- ------------------------------------------------------------------------
  -- Guard: abort if this seed already ran (avoid double-seeding / duplicate
  -- stock decrements on a second accidental run).
  -- ------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.sales WHERE invoice_number = 'DEMO-INV-0001') THEN
    RAISE EXCEPTION 'Demo data already present (DEMO-INV-0001 exists) — aborting to avoid seeding twice.';
  END IF;

  SELECT id INTO v_water FROM public.factories WHERE code = 'water';
  SELECT id INTO v_nylon FROM public.factories WHERE code = 'nylon';
  IF v_water IS NULL OR v_nylon IS NULL THEN
    RAISE EXCEPTION 'Expected factories (water/nylon) not found — run the base schema migrations first.';
  END IF;

  SELECT id INTO v_admin_id FROM auth.users WHERE email = 'joelyahaya7@gmail.com';

  -- ==========================================================================
  -- SUPPLIERS
  -- ==========================================================================
  INSERT INTO public.suppliers (factory_id, name, phone, email, address, materials_supplied, outstanding_balance)
  VALUES (v_water, 'PureChem Nigeria Ltd', '08031234501', 'sales@purechemng.com', 'Km 12 Lagos-Ibadan Expressway, Ogun State', 'Water treatment chemicals', 0)
  RETURNING id INTO v_sup_purechem;

  INSERT INTO public.suppliers (factory_id, name, phone, email, address, materials_supplied, outstanding_balance)
  VALUES (v_water, 'AquaPack Industries', '08031234502', 'orders@aquapack.ng', 'Plot 45 Industrial Layout, Ikeja', 'Shrink wrap film, labels', 0)
  RETURNING id INTO v_sup_aquapack;

  INSERT INTO public.suppliers (factory_id, name, phone, email, address, materials_supplied, outstanding_balance)
  VALUES (v_water, 'Delta Preform Supplies', '08031234503', 'delta.preforms@gmail.com', 'Trans Amadi Industrial Layout, Port Harcourt', 'PET preforms, bottle caps', 75000)
  RETURNING id INTO v_sup_deltapreform;

  INSERT INTO public.suppliers (factory_id, name, phone, email, address, materials_supplied, outstanding_balance)
  VALUES (v_nylon, 'Polymer Traders Ltd', '08031234504', 'info@polymertraders.ng', 'Aba Road Industrial Estate, Aba', 'LDPE / HDPE resin', 120000)
  RETURNING id INTO v_sup_polymer;

  INSERT INTO public.suppliers (factory_id, name, phone, email, address, materials_supplied, outstanding_balance)
  VALUES (v_nylon, 'NylonPack Materials', '08031234505', 'sales@nylonpack.ng', '14 Oshodi Industrial Road, Lagos', 'Colour masterbatch, printing ink', 0)
  RETURNING id INTO v_sup_nylonpack;

  -- ==========================================================================
  -- CUSTOMERS
  -- ==========================================================================
  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_water, 'Everfresh Supermarket', '08051112201', 'procurement@everfresh.ng', 'Allen Avenue, Ikeja, Lagos') RETURNING id INTO v_cust_everfresh;
  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_water, 'Blue Ocean Distributors', '08051112202', 'orders@blueocean.ng', 'Ojota, Lagos') RETURNING id INTO v_cust_blueocean;
  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_water, 'GreenLeaf Restaurants', '08051112203', 'supply@greenleaf.ng', 'Lekki Phase 1, Lagos') RETURNING id INTO v_cust_greenleaf;
  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_water, 'City Mart Stores', '08051112204', 'purchasing@citymart.ng', 'Surulere, Lagos') RETURNING id INTO v_cust_citymart;
  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_water, 'Sunrise Hotels', '08051112205', 'stores@sunrisehotels.ng', 'Victoria Island, Lagos') RETURNING id INTO v_cust_sunrise;

  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_nylon, 'Metro Packaging Co', '08051112206', 'buy@metropack.ng', 'Apapa, Lagos') RETURNING id INTO v_cust_metro;
  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_nylon, 'FastWrap Logistics', '08051112207', 'procurement@fastwrap.ng', 'Ajao Estate, Lagos') RETURNING id INTO v_cust_fastwrap;
  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_nylon, 'Prime Retail Bags', '08051112208', 'orders@primeretail.ng', 'Idumota, Lagos') RETURNING id INTO v_cust_primeretail;
  INSERT INTO public.customers (factory_id, name, phone, email, address) VALUES
    (v_nylon, 'Zenith Traders', '08051112209', 'info@zenithtraders.ng', 'Onitsha, Anambra') RETURNING id INTO v_cust_zenith;

  -- ==========================================================================
  -- EMPLOYEES
  -- ==========================================================================
  INSERT INTO public.employees (factory_id, employee_code, full_name, phone, email, gender, dob, department, position,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    employment_date, status, bank_name, account_number, emergency_contact)
  VALUES (v_water, 'DEMO-EMP-W001', 'Ade Johnson', '08061112301', 'ade.johnson@bluespring.ng', 'Male', current_date - interval '35 years', 'Production', 'Production Supervisor',
    180000, 30000, 20000, 10000, 5000, 0, current_date - interval '3 years', 'active', 'GTBank', '0123456789', '08099990001')
  RETURNING id INTO v_emp_ade;

  INSERT INTO public.employees (factory_id, employee_code, full_name, phone, email, gender, dob, department, position,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    employment_date, status, bank_name, account_number, emergency_contact)
  VALUES (v_water, 'DEMO-EMP-W002', 'Grace Okoro', '08061112302', 'grace.okoro@bluespring.ng', 'Female', current_date - interval '29 years', 'Sales', 'Sales Officer',
    120000, 15000, 15000, 8000, 4000, 0, current_date - interval '2 years', 'active', 'Zenith Bank', '0123456790', '08099990002')
  RETURNING id INTO v_emp_grace;

  INSERT INTO public.employees (factory_id, employee_code, full_name, phone, email, gender, dob, department, position,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    employment_date, status, bank_name, account_number, emergency_contact)
  VALUES (v_water, 'DEMO-EMP-W003', 'Michael Eze', '08061112303', 'michael.eze@bluespring.ng', 'Male', current_date - interval '26 years', 'Production', 'Machine Operator',
    90000, 10000, 10000, 6000, 3000, 0, current_date - interval '1 years', 'active', 'Access Bank', '0123456791', '08099990003')
  RETURNING id INTO v_emp_michael;

  INSERT INTO public.employees (factory_id, employee_code, full_name, phone, email, gender, dob, department, position,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    employment_date, status, bank_name, account_number, emergency_contact)
  VALUES (v_water, 'DEMO-EMP-W004', 'Blessing Nwosu', '08061112304', 'blessing.nwosu@bluespring.ng', 'Female', current_date - interval '32 years', 'Finance', 'Accountant',
    160000, 20000, 15000, 8000, 5000, 0, current_date - interval '4 years', 'active', 'GTBank', '0123456792', '08099990004')
  RETURNING id INTO v_emp_blessing;

  INSERT INTO public.employees (factory_id, employee_code, full_name, phone, email, gender, dob, department, position,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    employment_date, status, bank_name, account_number, emergency_contact)
  VALUES (v_nylon, 'DEMO-EMP-N001', 'Emeka Obi', '08061112305', 'emeka.obi@bluespring.ng', 'Male', current_date - interval '34 years', 'Production', 'Production Supervisor',
    175000, 25000, 18000, 9000, 5000, 0, current_date - interval '3 years', 'active', 'UBA', '0123456793', '08099990005')
  RETURNING id INTO v_emp_emeka;

  INSERT INTO public.employees (factory_id, employee_code, full_name, phone, email, gender, dob, department, position,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    employment_date, status, bank_name, account_number, emergency_contact)
  VALUES (v_nylon, 'DEMO-EMP-N002', 'Fatima Bello', '08061112306', 'fatima.bello@bluespring.ng', 'Female', current_date - interval '27 years', 'Sales', 'Sales Officer',
    115000, 14000, 14000, 7000, 4000, 0, current_date - interval '2 years', 'active', 'Zenith Bank', '0123456794', '08099990006')
  RETURNING id INTO v_emp_fatima;

  INSERT INTO public.employees (factory_id, employee_code, full_name, phone, email, gender, dob, department, position,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances,
    employment_date, status, bank_name, account_number, emergency_contact)
  VALUES (v_nylon, 'DEMO-EMP-N003', 'Chidi Okafor', '08061112307', 'chidi.okafor@bluespring.ng', 'Male', current_date - interval '24 years', 'Production', 'Machine Operator',
    85000, 10000, 10000, 5000, 3000, 0, current_date - interval '8 months', 'active', 'Access Bank', '0123456795', '08099990007')
  RETURNING id INTO v_emp_chidi;

  -- ==========================================================================
  -- PRODUCT CATEGORIES
  -- ==========================================================================
  INSERT INTO public.product_categories (factory_id, name, description) VALUES (v_water, 'Bottled Water', 'PET bottled water, all sizes') RETURNING id INTO v_cat_bottled;
  INSERT INTO public.product_categories (factory_id, name, description) VALUES (v_water, 'Sachet Water', 'Pure water sachets') RETURNING id INTO v_cat_sachet;
  INSERT INTO public.product_categories (factory_id, name, description) VALUES (v_nylon, 'Shopping Bags', 'Nylon shopping / carrier bags') RETURNING id INTO v_cat_bags;
  INSERT INTO public.product_categories (factory_id, name, description) VALUES (v_nylon, 'Packaging Rolls', 'Nylon packaging film rolls') RETURNING id INTO v_cat_rolls;

  -- ==========================================================================
  -- PRODUCTS (finished + semi-finished) — current_stock set to an OPENING
  -- balance here; production/sales below adjust it via UPDATE, same as the
  -- real create_production()/create_sale() RPCs would.
  -- ==========================================================================
  INSERT INTO public.products (factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
  VALUES (v_water, v_cat_bottled, 'WTR-50CL', '50cl Bottled Water', 'carton', 1200, 917.00, 300, 100, true, 'finished') RETURNING id INTO v_prod_50cl;

  INSERT INTO public.products (factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
  VALUES (v_water, v_cat_bottled, 'WTR-75CL', '75cl Bottled Water', 'carton', 1500, 1000.00, 200, 80, true, 'finished') RETURNING id INTO v_prod_75cl;

  INSERT INTO public.products (factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
  VALUES (v_water, v_cat_sachet, 'WTR-SACH', 'Pure Water Sachet (20 bags)', 'bag', 350, 220.00, 0, 200, true, 'finished') RETURNING id INTO v_prod_sachet;

  INSERT INTO public.products (factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
  VALUES (v_water, NULL, 'WTR-PREFORM', 'Water Preform (semi-finished)', 'pcs', 0, 10.00, 0, 1000, true, 'semi_finished') RETURNING id INTO v_prod_preform;

  INSERT INTO public.products (factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
  VALUES (v_nylon, v_cat_bags, 'NYL-BAGSM', 'Nylon Shopping Bag - Small', 'pack', 800, 350.33, 300, 150, true, 'finished') RETURNING id INTO v_prod_bagsmall;

  INSERT INTO public.products (factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
  VALUES (v_nylon, v_cat_bags, 'NYL-BAGLG', 'Nylon Shopping Bag - Large', 'pack', 1200, 850.00, 200, 100, true, 'finished') RETURNING id INTO v_prod_baglarge;

  INSERT INTO public.products (factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
  VALUES (v_nylon, v_cat_rolls, 'NYL-ROLL', 'Packaging Roll - 500m', 'roll', 4500, 3200.00, 0, 30, true, 'finished') RETURNING id INTO v_prod_roll;

  INSERT INTO public.products (factory_id, category_id, sku, name, unit, unit_price, cost_price, current_stock, reorder_level, active, product_type)
  VALUES (v_nylon, NULL, 'NYL-PELLET', 'Recycled Nylon Pellet (semi-finished)', 'kg', 0, 180.00, 0, 500, true, 'semi_finished') RETURNING id INTO v_prod_pellet;

  -- ==========================================================================
  -- RAW MATERIALS — opening stock, then movements below adjust via UPDATE.
  -- ==========================================================================
  INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, reorder_level, supplier_id, remarks)
  VALUES (v_water, 'PET Preforms', 'Packaging', 'pcs', 20000, 20000, 25.00, 5000, v_sup_deltapreform, 'For bottle blowing') RETURNING id INTO v_rm_petpreform;

  INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, reorder_level, supplier_id, remarks)
  VALUES (v_water, 'Bottle Caps', 'Packaging', 'pcs', 25000, 25000, 8.00, 5000, v_sup_deltapreform, NULL) RETURNING id INTO v_rm_caps;

  INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, reorder_level, supplier_id, remarks)
  VALUES (v_water, 'Shrink Wrap Film', 'Packaging', 'roll', 300, 300, 3500.00, 50, v_sup_aquapack, NULL) RETURNING id INTO v_rm_shrinkwrap;

  INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, reorder_level, supplier_id, remarks)
  VALUES (v_water, 'Water Treatment Chemicals', 'Chemicals', 'litre', 500, 500, 1200.00, 100, v_sup_purechem, NULL) RETURNING id INTO v_rm_chemicals;

  INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, reorder_level, supplier_id, remarks)
  VALUES (v_nylon, 'LDPE Resin', 'Polymer', 'kg', 8000, 8000, 950.00, 1500, v_sup_polymer, NULL) RETURNING id INTO v_rm_ldpe;

  INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, reorder_level, supplier_id, remarks)
  VALUES (v_nylon, 'HDPE Resin', 'Polymer', 'kg', 6000, 6000, 1020.00, 1200, v_sup_polymer, NULL) RETURNING id INTO v_rm_hdpe;

  INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, reorder_level, supplier_id, remarks)
  VALUES (v_nylon, 'Colour Masterbatch', 'Additives', 'kg', 400, 400, 2200.00, 100, v_sup_nylonpack, NULL) RETURNING id INTO v_rm_masterbatch;

  -- Opening-stock "received" movement history for each raw material
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after, created_at)
  SELECT factory_id, id, 'received', opening_stock, unit_cost, 'DEMO-OPEN-STOCK', 'Opening balance', v_admin_id, 0, opening_stock, now() - interval '45 days'
  FROM public.raw_materials WHERE id IN (v_rm_petpreform, v_rm_caps, v_rm_shrinkwrap, v_rm_chemicals, v_rm_ldpe, v_rm_hdpe, v_rm_masterbatch);

  -- ==========================================================================
  -- PRODUCTION REQUESTS + PRODUCTION RUNS
  -- ==========================================================================

  -- Water PR1: completed (materials issued + production run recorded)
  INSERT INTO public.production_requests (factory_id, request_number, requested_by_name, requested_by, department, product_id,
    quantity_requested, unit, request_date, approval_status, approved_by_name, approval_date, materials_issued, issued_by_name, issued_at,
    production_status, remarks)
  VALUES (v_water, 'DEMO-PRQ-W0001', 'Ade Johnson', v_admin_id, 'Production', v_prod_50cl, 200, 'carton',
    now() - interval '11 days', 'approved', 'Blessing Nwosu', now() - interval '11 days', true, 'Ade Johnson', now() - interval '10 days',
    'completed', 'Regular bottling run')
  RETURNING id INTO v_pr_water1;

  INSERT INTO public.production_request_items (request_id, material_id, quantity_requested, unit, quantity_issued) VALUES
    (v_pr_water1, v_rm_petpreform, 4800, 'pcs', 4800),
    (v_pr_water1, v_rm_caps, 4800, 'pcs', 4800);

  UPDATE public.raw_materials SET current_stock = current_stock - 4800 WHERE id = v_rm_petpreform;
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_water, v_rm_petpreform, 'used_for_production', 4800, 'DEMO-PRQ-W0001', 'Issued for production request', v_admin_id, 20000, 15200, now() - interval '10 days');

  UPDATE public.raw_materials SET current_stock = current_stock - 4800 WHERE id = v_rm_caps;
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_water, v_rm_caps, 'used_for_production', 4800, 'DEMO-PRQ-W0001', 'Issued for production request', v_admin_id, 25000, 20200, now() - interval '10 days');

  INSERT INTO public.production (factory_id, production_number, production_date, product_id, quantity_produced, unit,
    production_cost, supervisor, batch_number, remarks, created_by, production_request_id, created_at)
  VALUES (v_water, 'DEMO-PRD-W0001', current_date - 10, v_prod_50cl, 200, 'carton', 160000, 'Ade Johnson', 'BATCH-W-0001', 'Linked to DEMO-PRQ-W0001', v_admin_id, v_pr_water1, now() - interval '10 days')
  RETURNING id INTO v_prodrun_water1;

  UPDATE public.production_requests SET production_status = 'completed', production_id = v_prodrun_water1 WHERE id = v_pr_water1;
  UPDATE public.products SET current_stock = current_stock + 200 WHERE id = v_prod_50cl;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_water, v_prod_50cl, 'produced', 200, 'DEMO-PRD-W0001', 'Production run', v_admin_id, 300, 500, now() - interval '10 days');

  -- Water PR2: materials issued, production not yet run
  INSERT INTO public.production_requests (factory_id, request_number, requested_by_name, requested_by, department, product_id,
    quantity_requested, unit, request_date, approval_status, approved_by_name, approval_date, materials_issued, issued_by_name, issued_at,
    production_status, remarks)
  VALUES (v_water, 'DEMO-PRQ-W0002', 'Ade Johnson', v_admin_id, 'Production', v_prod_75cl, 150, 'carton',
    now() - interval '4 days', 'approved', 'Blessing Nwosu', now() - interval '4 days', true, 'Ade Johnson', now() - interval '3 days',
    'materials_issued', 'Awaiting production run')
  RETURNING id INTO v_pr_water2;

  INSERT INTO public.production_request_items (request_id, material_id, quantity_requested, unit, quantity_issued) VALUES
    (v_pr_water2, v_rm_petpreform, 3600, 'pcs', 3600),
    (v_pr_water2, v_rm_caps, 3600, 'pcs', 3600);

  UPDATE public.raw_materials SET current_stock = current_stock - 3600 WHERE id = v_rm_petpreform;
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_water, v_rm_petpreform, 'used_for_production', 3600, 'DEMO-PRQ-W0002', 'Issued for production request', v_admin_id, 15200, 11600, now() - interval '3 days');

  UPDATE public.raw_materials SET current_stock = current_stock - 3600 WHERE id = v_rm_caps;
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_water, v_rm_caps, 'used_for_production', 3600, 'DEMO-PRQ-W0002', 'Issued for production request', v_admin_id, 20200, 16600, now() - interval '3 days');

  -- Water PR3: pending, nothing issued yet
  INSERT INTO public.production_requests (factory_id, request_number, requested_by_name, requested_by, department, product_id,
    quantity_requested, unit, request_date, approval_status, materials_issued, production_status, remarks)
  VALUES (v_water, 'DEMO-PRQ-W0003', 'Michael Eze', v_admin_id, 'Production', v_prod_sachet, 500, 'bag',
    now() - interval '1 days', 'pending', false, 'pending', 'Awaiting supervisor approval');
  INSERT INTO public.production_request_items (request_id, material_id, quantity_requested, unit, quantity_issued)
  SELECT id, v_rm_chemicals, 50, 'litre', 0 FROM public.production_requests WHERE request_number = 'DEMO-PRQ-W0003';

  -- Nylon PR1: completed
  INSERT INTO public.production_requests (factory_id, request_number, requested_by_name, requested_by, department, product_id,
    quantity_requested, unit, request_date, approval_status, approved_by_name, approval_date, materials_issued, issued_by_name, issued_at,
    production_status, remarks)
  VALUES (v_nylon, 'DEMO-PRQ-N0001', 'Emeka Obi', v_admin_id, 'Production', v_prod_bagsmall, 300, 'pack',
    now() - interval '10 days', 'approved', 'Amina Yusuf', now() - interval '10 days', true, 'Emeka Obi', now() - interval '9 days',
    'completed', 'Regular bag production run')
  RETURNING id INTO v_pr_nylon1;

  INSERT INTO public.production_request_items (request_id, material_id, quantity_requested, unit, quantity_issued) VALUES
    (v_pr_nylon1, v_rm_ldpe, 90, 'kg', 90),
    (v_pr_nylon1, v_rm_masterbatch, 3, 'kg', 3);

  UPDATE public.raw_materials SET current_stock = current_stock - 90 WHERE id = v_rm_ldpe;
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_nylon, v_rm_ldpe, 'used_for_production', 90, 'DEMO-PRQ-N0001', 'Issued for production request', v_admin_id, 8000, 7910, now() - interval '9 days');

  UPDATE public.raw_materials SET current_stock = current_stock - 3 WHERE id = v_rm_masterbatch;
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_nylon, v_rm_masterbatch, 'used_for_production', 3, 'DEMO-PRQ-N0001', 'Issued for production request', v_admin_id, 400, 397, now() - interval '9 days');

  INSERT INTO public.production (factory_id, production_number, production_date, product_id, quantity_produced, unit,
    production_cost, supervisor, batch_number, remarks, created_by, production_request_id, created_at)
  VALUES (v_nylon, 'DEMO-PRD-N0001', current_date - 9, v_prod_bagsmall, 300, 'pack', 95000, 'Emeka Obi', 'BATCH-N-0001', 'Linked to DEMO-PRQ-N0001', v_admin_id, v_pr_nylon1, now() - interval '9 days')
  RETURNING id INTO v_prodrun_nylon1;

  UPDATE public.production_requests SET production_status = 'completed', production_id = v_prodrun_nylon1 WHERE id = v_pr_nylon1;
  UPDATE public.products SET current_stock = current_stock + 300 WHERE id = v_prod_bagsmall;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_nylon, v_prod_bagsmall, 'produced', 300, 'DEMO-PRD-N0001', 'Production run', v_admin_id, 300, 600, now() - interval '9 days');

  -- Nylon PR2: materials issued, production pending
  INSERT INTO public.production_requests (factory_id, request_number, requested_by_name, requested_by, department, product_id,
    quantity_requested, unit, request_date, approval_status, approved_by_name, approval_date, materials_issued, issued_by_name, issued_at,
    production_status, remarks)
  VALUES (v_nylon, 'DEMO-PRQ-N0002', 'Emeka Obi', v_admin_id, 'Production', v_prod_baglarge, 200, 'pack',
    now() - interval '3 days', 'approved', 'Amina Yusuf', now() - interval '3 days', true, 'Emeka Obi', now() - interval '2 days',
    'materials_issued', 'Awaiting production run');
  INSERT INTO public.production_request_items (request_id, material_id, quantity_requested, unit, quantity_issued)
  SELECT id, v_rm_hdpe, 80, 'kg', 80 FROM public.production_requests WHERE request_number = 'DEMO-PRQ-N0002';
  INSERT INTO public.production_request_items (request_id, material_id, quantity_requested, unit, quantity_issued)
  SELECT id, v_rm_masterbatch, 4, 'kg', 4 FROM public.production_requests WHERE request_number = 'DEMO-PRQ-N0002';

  UPDATE public.raw_materials SET current_stock = current_stock - 80 WHERE id = v_rm_hdpe;
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_nylon, v_rm_hdpe, 'used_for_production', 80, 'DEMO-PRQ-N0002', 'Issued for production request', v_admin_id, 6000, 5920, now() - interval '2 days');

  UPDATE public.raw_materials SET current_stock = current_stock - 4 WHERE id = v_rm_masterbatch;
  INSERT INTO public.raw_material_movements (factory_id, material_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_nylon, v_rm_masterbatch, 'used_for_production', 4, 'DEMO-PRQ-N0002', 'Issued for production request', v_admin_id, 397, 393, now() - interval '2 days');

  -- Standalone production runs (no linked request) for extra history
  INSERT INTO public.production (factory_id, production_number, production_date, product_id, quantity_produced, unit, production_cost, supervisor, batch_number, remarks, created_by, created_at)
  VALUES (v_water, 'DEMO-PRD-W0002', current_date - 20, v_prod_sachet, 800, 'bag', 45000, 'Michael Eze', 'BATCH-W-0002', NULL, v_admin_id, now() - interval '20 days');
  UPDATE public.products SET current_stock = current_stock + 800 WHERE id = v_prod_sachet;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_water, v_prod_sachet, 'produced', 800, 'DEMO-PRD-W0002', 'Production run', v_admin_id, 0, 800, now() - interval '20 days');

  INSERT INTO public.production (factory_id, production_number, production_date, product_id, quantity_produced, unit, production_cost, supervisor, batch_number, remarks, created_by, created_at)
  VALUES (v_water, 'DEMO-PRD-W0003', current_date - 25, v_prod_preform, 5000, 'pcs', 50000, 'Ade Johnson', 'BATCH-W-0003', 'Semi-finished stock build-up', v_admin_id, now() - interval '25 days');
  UPDATE public.products SET current_stock = current_stock + 5000 WHERE id = v_prod_preform;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_water, v_prod_preform, 'produced', 5000, 'DEMO-PRD-W0003', 'Production run', v_admin_id, 0, 5000, now() - interval '25 days');

  INSERT INTO public.production (factory_id, production_number, production_date, product_id, quantity_produced, unit, production_cost, supervisor, batch_number, remarks, created_by, created_at)
  VALUES (v_nylon, 'DEMO-PRD-N0002', current_date - 18, v_prod_roll, 150, 'roll', 180000, 'Emeka Obi', 'BATCH-N-0002', NULL, v_admin_id, now() - interval '18 days');
  UPDATE public.products SET current_stock = current_stock + 150 WHERE id = v_prod_roll;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_nylon, v_prod_roll, 'produced', 150, 'DEMO-PRD-N0002', 'Production run', v_admin_id, 0, 150, now() - interval '18 days');

  INSERT INTO public.production (factory_id, production_number, production_date, product_id, quantity_produced, unit, production_cost, supervisor, batch_number, remarks, created_by, created_at)
  VALUES (v_nylon, 'DEMO-PRD-N0003', current_date - 22, v_prod_pellet, 2000, 'kg', 120000, 'Chidi Okafor', 'BATCH-N-0003', 'Recycled feedstock', v_admin_id, now() - interval '22 days');
  UPDATE public.products SET current_stock = current_stock + 2000 WHERE id = v_prod_pellet;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after, created_at)
  VALUES (v_nylon, v_prod_pellet, 'produced', 2000, 'DEMO-PRD-N0003', 'Production run', v_admin_id, 0, 2000, now() - interval '22 days');

  -- ==========================================================================
  -- SALES (+ sale_items, payments_received, debts, debt_payments, customer aggregates)
  -- ==========================================================================

  -- Water Sale 1: Everfresh — paid in full, cash
  INSERT INTO public.sales (factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, created_by, created_at)
  VALUES (v_water, 'DEMO-INV-0001', current_date - 10, v_cust_everfresh, 'Everfresh Supermarket', '08051112201', 90000, 0, 6750, 96750, 96750, 0, 'cash', 'Grace Okoro', v_admin_id, now() - interval '10 days')
  RETURNING id INTO v_sale_w1;
  INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, line_total) VALUES
    (v_sale_w1, v_prod_50cl, 50, 1200, 60000),
    (v_sale_w1, v_prod_75cl, 20, 1500, 30000);
  UPDATE public.products SET current_stock = current_stock - 50 WHERE id = v_prod_50cl;
  UPDATE public.products SET current_stock = current_stock - 20 WHERE id = v_prod_75cl;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, user_id, created_at) VALUES
    (v_water, v_prod_50cl, 'sold', 50, 'DEMO-INV-0001', v_admin_id, now() - interval '10 days'),
    (v_water, v_prod_75cl, 'sold', 20, 'DEMO-INV-0001', v_admin_id, now() - interval '10 days');
  INSERT INTO public.payments_received (factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_water, 'DEMO-RCP-0001', v_cust_everfresh, v_sale_w1, 96750, 'cash', current_date - 10, v_admin_id, 'Payment at point of sale', now() - interval '10 days');
  UPDATE public.customers SET total_purchases = total_purchases + 96750 WHERE id = v_cust_everfresh;

  -- Water Sale 2: walk-in — paid in full, cash
  INSERT INTO public.sales (factory_id, invoice_number, sale_date, customer_name, subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, created_by, created_at)
  VALUES (v_water, 'DEMO-INV-0002', current_date - 8, 'Walk-in Customer', 35000, 0, 2625, 37625, 37625, 0, 'cash', 'Grace Okoro', v_admin_id, now() - interval '8 days')
  RETURNING id INTO v_sale_w2;
  INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, line_total) VALUES (v_sale_w2, v_prod_sachet, 100, 350, 35000);
  UPDATE public.products SET current_stock = current_stock - 100 WHERE id = v_prod_sachet;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, user_id, created_at) VALUES
    (v_water, v_prod_sachet, 'sold', 100, 'DEMO-INV-0002', v_admin_id, now() - interval '8 days');
  INSERT INTO public.payments_received (factory_id, receipt_number, sale_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_water, 'DEMO-RCP-0002', v_sale_w2, 37625, 'cash', current_date - 8, v_admin_id, 'Payment at point of sale', now() - interval '8 days');

  -- Water Sale 3: Blue Ocean — partial payment (creates a debt, later part-paid)
  INSERT INTO public.sales (factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, created_by, created_at)
  VALUES (v_water, 'DEMO-INV-0003', current_date - 6, v_cust_blueocean, 'Blue Ocean Distributors', '08051112202', 190000, 0, 14250, 204250, 150000, 54250, 'transfer', 'Grace Okoro', v_admin_id, now() - interval '6 days')
  RETURNING id INTO v_sale_w3;
  INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, line_total) VALUES
    (v_sale_w3, v_prod_50cl, 100, 1200, 120000),
    (v_sale_w3, v_prod_sachet, 200, 350, 70000);
  UPDATE public.products SET current_stock = current_stock - 100 WHERE id = v_prod_50cl;
  UPDATE public.products SET current_stock = current_stock - 200 WHERE id = v_prod_sachet;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, user_id, created_at) VALUES
    (v_water, v_prod_50cl, 'sold', 100, 'DEMO-INV-0003', v_admin_id, now() - interval '6 days'),
    (v_water, v_prod_sachet, 'sold', 200, 'DEMO-INV-0003', v_admin_id, now() - interval '6 days');
  INSERT INTO public.payments_received (factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_water, 'DEMO-RCP-0003', v_cust_blueocean, v_sale_w3, 150000, 'transfer', current_date - 6, v_admin_id, 'Payment at point of sale', now() - interval '6 days');
  INSERT INTO public.debts (factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status, created_at)
  VALUES (v_water, v_cust_blueocean, v_sale_w3, 204250, 150000, 54250, 'partial', now() - interval '6 days')
  RETURNING id INTO v_debt_w3;
  UPDATE public.customers SET total_purchases = total_purchases + 204250, outstanding_balance = outstanding_balance + 54250 WHERE id = v_cust_blueocean;

  -- Follow-up part-payment against that debt, 2 days ago
  INSERT INTO public.payments_received (factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_water, 'DEMO-RCP-0004', v_cust_blueocean, v_sale_w3, 30000, 'transfer', current_date - 2, v_admin_id, 'Part-payment against outstanding balance', now() - interval '2 days');
  INSERT INTO public.debt_payments (debt_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_debt_w3, 30000, 'transfer', current_date - 2, v_admin_id, 'Part-payment against DEMO-INV-0003', now() - interval '2 days');
  UPDATE public.debts SET amount_paid = amount_paid + 30000, outstanding = outstanding - 30000, status = 'partial' WHERE id = v_debt_w3;
  UPDATE public.sales SET amount_paid = amount_paid + 30000, balance = balance - 30000 WHERE id = v_sale_w3;
  UPDATE public.customers SET outstanding_balance = outstanding_balance - 30000 WHERE id = v_cust_blueocean;

  -- Water Sale 4: City Mart — full credit, unpaid
  INSERT INTO public.sales (factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, created_by, created_at)
  VALUES (v_water, 'DEMO-INV-0004', current_date - 4, v_cust_citymart, 'City Mart Stores', '08051112204', 45000, 0, 3375, 48375, 0, 48375, 'credit', 'Grace Okoro', v_admin_id, now() - interval '4 days')
  RETURNING id INTO v_sale_w4;
  INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, line_total) VALUES (v_sale_w4, v_prod_75cl, 30, 1500, 45000);
  UPDATE public.products SET current_stock = current_stock - 30 WHERE id = v_prod_75cl;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, user_id, created_at) VALUES
    (v_water, v_prod_75cl, 'sold', 30, 'DEMO-INV-0004', v_admin_id, now() - interval '4 days');
  INSERT INTO public.debts (factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status, created_at)
  VALUES (v_water, v_cust_citymart, v_sale_w4, 48375, 0, 48375, 'unpaid', now() - interval '4 days')
  RETURNING id INTO v_debt_w4;
  UPDATE public.customers SET total_purchases = total_purchases + 48375, outstanding_balance = outstanding_balance + 48375 WHERE id = v_cust_citymart;

  -- Water Sale 5: Sunrise Hotels — paid in full, POS
  INSERT INTO public.sales (factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, created_by, created_at)
  VALUES (v_water, 'DEMO-INV-0005', current_date - 1, v_cust_sunrise, 'Sunrise Hotels', '08051112205', 105000, 0, 7875, 112875, 112875, 0, 'pos', 'Grace Okoro', v_admin_id, now() - interval '1 days')
  RETURNING id INTO v_sale_w5;
  INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, line_total) VALUES (v_sale_w5, v_prod_sachet, 300, 350, 105000);
  UPDATE public.products SET current_stock = current_stock - 300 WHERE id = v_prod_sachet;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, user_id, created_at) VALUES
    (v_water, v_prod_sachet, 'sold', 300, 'DEMO-INV-0005', v_admin_id, now() - interval '1 days');
  INSERT INTO public.payments_received (factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_water, 'DEMO-RCP-0005', v_cust_sunrise, v_sale_w5, 112875, 'pos', current_date - 1, v_admin_id, 'Payment at point of sale', now() - interval '1 days');
  UPDATE public.customers SET total_purchases = total_purchases + 112875 WHERE id = v_cust_sunrise;

  -- Nylon Sale 1: Metro Packaging — paid in full, cash
  INSERT INTO public.sales (factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, created_by, created_at)
  VALUES (v_nylon, 'DEMO-INV-0006', current_date - 9, v_cust_metro, 'Metro Packaging Co', '08051112206', 104000, 0, 7800, 111800, 111800, 0, 'cash', 'Fatima Bello', v_admin_id, now() - interval '9 days')
  RETURNING id INTO v_sale_n1;
  INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, line_total) VALUES
    (v_sale_n1, v_prod_bagsmall, 100, 800, 80000),
    (v_sale_n1, v_prod_baglarge, 20, 1200, 24000);
  UPDATE public.products SET current_stock = current_stock - 100 WHERE id = v_prod_bagsmall;
  UPDATE public.products SET current_stock = current_stock - 20 WHERE id = v_prod_baglarge;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, user_id, created_at) VALUES
    (v_nylon, v_prod_bagsmall, 'sold', 100, 'DEMO-INV-0006', v_admin_id, now() - interval '9 days'),
    (v_nylon, v_prod_baglarge, 'sold', 20, 'DEMO-INV-0006', v_admin_id, now() - interval '9 days');
  INSERT INTO public.payments_received (factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_nylon, 'DEMO-RCP-0006', v_cust_metro, v_sale_n1, 111800, 'cash', current_date - 9, v_admin_id, 'Payment at point of sale', now() - interval '9 days');
  UPDATE public.customers SET total_purchases = total_purchases + 111800 WHERE id = v_cust_metro;

  -- Nylon Sale 2: walk-in — paid in full, transfer
  INSERT INTO public.sales (factory_id, invoice_number, sale_date, customer_name, subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, created_by, created_at)
  VALUES (v_nylon, 'DEMO-INV-0007', current_date - 5, 'Walk-in Customer', 45000, 0, 3375, 48375, 48375, 0, 'transfer', 'Fatima Bello', v_admin_id, now() - interval '5 days')
  RETURNING id INTO v_sale_n2;
  INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, line_total) VALUES (v_sale_n2, v_prod_roll, 10, 4500, 45000);
  UPDATE public.products SET current_stock = current_stock - 10 WHERE id = v_prod_roll;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, user_id, created_at) VALUES
    (v_nylon, v_prod_roll, 'sold', 10, 'DEMO-INV-0007', v_admin_id, now() - interval '5 days');
  INSERT INTO public.payments_received (factory_id, receipt_number, sale_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_nylon, 'DEMO-RCP-0007', v_sale_n2, 48375, 'transfer', current_date - 5, v_admin_id, 'Payment at point of sale', now() - interval '5 days');

  -- Nylon Sale 3: FastWrap — partial payment (creates a debt)
  INSERT INTO public.sales (factory_id, invoice_number, sale_date, customer_id, customer_name, customer_phone, subtotal, discount, vat, grand_total, amount_paid, balance, payment_method, sales_person, created_by, created_at)
  VALUES (v_nylon, 'DEMO-INV-0008', current_date - 3, v_cust_fastwrap, 'FastWrap Logistics', '08051112207', 142500, 0, 10688, 153188, 100000, 53188, 'transfer', 'Fatima Bello', v_admin_id, now() - interval '3 days')
  RETURNING id INTO v_sale_n3;
  INSERT INTO public.sale_items (sale_id, product_id, quantity, unit_price, line_total) VALUES
    (v_sale_n3, v_prod_bagsmall, 150, 800, 120000),
    (v_sale_n3, v_prod_roll, 5, 4500, 22500);
  UPDATE public.products SET current_stock = current_stock - 150 WHERE id = v_prod_bagsmall;
  UPDATE public.products SET current_stock = current_stock - 5 WHERE id = v_prod_roll;
  INSERT INTO public.inventory_movements (factory_id, product_id, movement_type, quantity, reference, user_id, created_at) VALUES
    (v_nylon, v_prod_bagsmall, 'sold', 150, 'DEMO-INV-0008', v_admin_id, now() - interval '3 days'),
    (v_nylon, v_prod_roll, 'sold', 5, 'DEMO-INV-0008', v_admin_id, now() - interval '3 days');
  INSERT INTO public.payments_received (factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks, created_at)
  VALUES (v_nylon, 'DEMO-RCP-0008', v_cust_fastwrap, v_sale_n3, 100000, 'transfer', current_date - 3, v_admin_id, 'Payment at point of sale', now() - interval '3 days');
  INSERT INTO public.debts (factory_id, customer_id, sale_id, total_amount, amount_paid, outstanding, status, created_at)
  VALUES (v_nylon, v_cust_fastwrap, v_sale_n3, 153188, 100000, 53188, 'partial', now() - interval '3 days')
  RETURNING id INTO v_debt_n3;
  UPDATE public.customers SET total_purchases = total_purchases + 153188, outstanding_balance = outstanding_balance + 53188 WHERE id = v_cust_fastwrap;

  -- ==========================================================================
  -- EXPENSES
  -- ==========================================================================
  SELECT id INTO v_ec_utilities_w FROM public.expense_categories WHERE factory_id = v_water AND name = 'Utilities';
  SELECT id INTO v_ec_transport_w FROM public.expense_categories WHERE factory_id = v_water AND name = 'Transportation';
  SELECT id INTO v_ec_maintenance_w FROM public.expense_categories WHERE factory_id = v_water AND name = 'Maintenance';
  SELECT id INTO v_ec_office_w FROM public.expense_categories WHERE factory_id = v_water AND name = 'Office Expenses';
  SELECT id INTO v_ec_utilities_n FROM public.expense_categories WHERE factory_id = v_nylon AND name = 'Utilities';
  SELECT id INTO v_ec_operational_n FROM public.expense_categories WHERE factory_id = v_nylon AND name = 'Operational Expenses';
  SELECT id INTO v_ec_transport_n FROM public.expense_categories WHERE factory_id = v_nylon AND name = 'Transportation';

  INSERT INTO public.expenses (factory_id, expense_date, category_id, description, vendor, payment_method, amount, requested_by_name, approval_status, approved_by, approved_at, recorded_by, created_at) VALUES
    (v_water, current_date - 15, v_ec_office_w, 'Stationery and printing', 'Office Point Ltd', 'cash', 15000, 'Blessing Nwosu', 'approved', 'Blessing Nwosu', now() - interval '14 days', v_admin_id, now() - interval '15 days'),
    (v_water, current_date - 12, v_ec_utilities_w, 'Electricity bill - August', 'PHCN / EKEDC', 'transfer', 85000, 'Blessing Nwosu', 'approved', 'Blessing Nwosu', now() - interval '11 days', v_admin_id, now() - interval '12 days'),
    (v_water, current_date - 7, v_ec_transport_w, 'Diesel for delivery van', 'Total Filling Station', 'cash', 45000, 'Ade Johnson', 'approved', 'Blessing Nwosu', now() - interval '6 days', v_admin_id, now() - interval '7 days'),
    (v_water, current_date - 2, v_ec_maintenance_w, 'Bottling machine servicing', 'TechFix Engineering', 'transfer', 120000, 'Ade Johnson', 'pending', NULL, NULL, v_admin_id, now() - interval '2 days'),
    (v_nylon, current_date - 11, v_ec_utilities_n, 'Electricity bill - August', 'PHCN / EKEDC', 'transfer', 95000, 'Amina Yusuf', 'approved', 'Amina Yusuf', now() - interval '10 days', v_admin_id, now() - interval '11 days'),
    (v_nylon, current_date - 6, v_ec_operational_n, 'Machine lubricants', 'Industrial Supplies Co', 'cash', 32000, 'Emeka Obi', 'rejected', 'Amina Yusuf', now() - interval '5 days', v_admin_id, now() - interval '6 days'),
    (v_nylon, current_date - 3, v_ec_transport_n, 'Fuel for logistics truck', 'NNPC Filling Station', 'cash', 38000, 'Emeka Obi', 'approved', 'Amina Yusuf', now() - interval '2 days', v_admin_id, now() - interval '3 days');

  -- ==========================================================================
  -- PAYROLL (last completed month)
  -- ==========================================================================
  INSERT INTO public.payroll (factory_id, employee_id, period_month, period_year, basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, other_allowances, gross_salary, paye, pension, loans, advance, other_deductions, net_salary, payment_method, payment_date, status, bank_name, account_number, created_at) VALUES
    (v_water, v_emp_ade, v_payroll_month, v_payroll_year, 180000, 30000, 20000, 10000, 5000, 0, 245000, 17000, 14400, 0, 0, 0, 213600, 'transfer', (date_trunc('month', current_date) - interval '1 day')::date, 'paid', 'GTBank', '0123456789', now() - interval '20 days'),
    (v_water, v_emp_grace, v_payroll_month, v_payroll_year, 120000, 15000, 15000, 8000, 4000, 0, 162000, 11000, 9600, 0, 0, 0, 141400, 'transfer', (date_trunc('month', current_date) - interval '1 day')::date, 'paid', 'Zenith Bank', '0123456790', now() - interval '20 days'),
    (v_water, v_emp_michael, v_payroll_month, v_payroll_year, 90000, 10000, 10000, 6000, 3000, 0, 119000, 8000, 7200, 0, 0, 0, 103800, 'transfer', (date_trunc('month', current_date) - interval '1 day')::date, 'paid', 'Access Bank', '0123456791', now() - interval '20 days'),
    (v_water, v_emp_blessing, v_payroll_month, v_payroll_year, 160000, 20000, 15000, 8000, 5000, 0, 208000, 14500, 12800, 20000, 0, 0, 160700, 'transfer', (date_trunc('month', current_date) - interval '1 day')::date, 'paid', 'GTBank', '0123456792', now() - interval '20 days'),
    (v_nylon, v_emp_emeka, v_payroll_month, v_payroll_year, 175000, 25000, 18000, 9000, 5000, 0, 232000, 16000, 14000, 0, 0, 0, 202000, 'transfer', (date_trunc('month', current_date) - interval '1 day')::date, 'paid', 'UBA', '0123456793', now() - interval '20 days'),
    (v_nylon, v_emp_fatima, v_payroll_month, v_payroll_year, 115000, 14000, 14000, 7000, 4000, 0, 154000, 10500, 9200, 0, 0, 0, 134300, 'transfer', (date_trunc('month', current_date) - interval '1 day')::date, 'paid', 'Zenith Bank', '0123456794', now() - interval '20 days'),
    (v_nylon, v_emp_chidi, v_payroll_month, v_payroll_year, 85000, 10000, 10000, 5000, 3000, 0, 113000, 7500, 6800, 0, 0, 0, 98700, 'transfer', NULL, 'pending', 'Access Bank', '0123456795', now() - interval '2 days');

  -- ==========================================================================
  -- CASH TRANSACTIONS (Receipts & Payments / Cash Flow — "other" categories)
  -- ==========================================================================
  INSERT INTO public.cash_transactions (factory_id, transaction_number, transaction_date, transaction_type, category, description, amount, payment_method, payer_payee, recorded_by_name, recorded_by, created_at) VALUES
    (v_water, 'DEMO-RCT-0001', current_date - 20, 'receipt', 'other_inflow', 'Scrap PET bottle sales', 8000, 'cash', 'Local scrap buyer', 'Blessing Nwosu', v_admin_id, now() - interval '20 days'),
    (v_water, 'DEMO-RCT-0002', current_date - 14, 'receipt', 'donation_endowment', 'Community water donation refund', 5000, 'cash', 'Ikeja LCDA', 'Blessing Nwosu', v_admin_id, now() - interval '14 days'),
    (v_water, 'DEMO-PMT-0001', current_date - 9, 'payment', 'other_outflow', 'Bank charges', 3500, 'transfer', 'GTBank', 'Blessing Nwosu', v_admin_id, now() - interval '9 days'),
    (v_nylon, 'DEMO-RCT-0003', current_date - 13, 'receipt', 'other_inflow', 'Scrap nylon sale', 12000, 'cash', 'Local recycler', 'Amina Yusuf', v_admin_id, now() - interval '13 days'),
    (v_nylon, 'DEMO-PMT-0002', current_date - 8, 'payment', 'other_outflow', 'Bank charges', 2800, 'transfer', 'UBA', 'Amina Yusuf', v_admin_id, now() - interval '8 days');

  -- ==========================================================================
  -- COSTING SHEETS
  -- ==========================================================================
  INSERT INTO public.costing_sheets (factory_id, product_id, sheet_number, yield_quantity, labor_cost, overhead_cost, material_cost, total_cost, unit_cost, applied_to_product, notes, created_by, created_at)
  VALUES (v_water, v_prod_50cl, 'DEMO-CST-W0001', 200, 15000, 10000, 158400, 183400, 917.00, true, 'Standard costing for 50cl bottled water batch', v_admin_id, now() - interval '10 days')
  RETURNING id INTO v_costing_w;
  INSERT INTO public.costing_sheet_items (sheet_id, material_id, quantity, unit_cost, line_total) VALUES
    (v_costing_w, v_rm_petpreform, 4800, 25.00, 120000),
    (v_costing_w, v_rm_caps, 4800, 8.00, 38400);

  INSERT INTO public.costing_sheets (factory_id, product_id, sheet_number, yield_quantity, labor_cost, overhead_cost, material_cost, total_cost, unit_cost, applied_to_product, notes, created_by, created_at)
  VALUES (v_nylon, v_prod_bagsmall, 'DEMO-CST-N0001', 300, 8000, 5000, 92100, 105100, 350.33, true, 'Standard costing for small nylon bag batch', v_admin_id, now() - interval '9 days')
  RETURNING id INTO v_costing_n;
  INSERT INTO public.costing_sheet_items (sheet_id, material_id, quantity, unit_cost, line_total) VALUES
    (v_costing_n, v_rm_ldpe, 90, 950.00, 85500),
    (v_costing_n, v_rm_masterbatch, 3, 2200.00, 6600);

  -- ==========================================================================
  -- LOGISTICS
  -- ==========================================================================
  INSERT INTO public.vehicles (factory_id, plate_number, make_model, capacity, status) VALUES (v_water, 'ABC-123-XY', 'Toyota Hiace', '1000kg', 'active') RETURNING id INTO v_vehicle_w;
  INSERT INTO public.vehicles (factory_id, plate_number, make_model, capacity, status) VALUES (v_nylon, 'XYZ-456-KJ', 'Mitsubishi Canter', '3000kg', 'active') RETURNING id INTO v_vehicle_n;

  INSERT INTO public.drivers (factory_id, full_name, phone, license_number, status) VALUES (v_water, 'Emmanuel Success', '08071112401', 'LIC-W-001', 'active') RETURNING id INTO v_driver_w;
  INSERT INTO public.drivers (factory_id, full_name, phone, license_number, status) VALUES (v_nylon, 'Ibrahim Musa', '08071112402', 'LIC-N-001', 'active') RETURNING id INTO v_driver_n;

  INSERT INTO public.delivery_routes (factory_id, name, description) VALUES (v_water, 'Lagos Mainland Route', 'Ikeja, Surulere, Ojota') RETURNING id INTO v_route_w;
  INSERT INTO public.delivery_routes (factory_id, name, description) VALUES (v_nylon, 'Lagos Island / Apapa Route', 'Apapa, Ajao Estate, Idumota') RETURNING id INTO v_route_n;

  INSERT INTO public.deliveries (factory_id, delivery_number, sale_id, vehicle_id, driver_id, route_id, destination, status, scheduled_date, departed_at, delivered_at, created_by, created_at)
  VALUES (v_water, 'DEMO-DEL-W0001', v_sale_w1, v_vehicle_w, v_driver_w, v_route_w, 'Everfresh Supermarket, Allen Avenue, Ikeja', 'delivered', current_date - 10, now() - interval '10 days' + interval '1 hour', now() - interval '10 days' + interval '3 hours', v_admin_id, now() - interval '10 days');

  INSERT INTO public.deliveries (factory_id, delivery_number, sale_id, vehicle_id, driver_id, route_id, destination, status, scheduled_date, departed_at, created_by, created_at)
  VALUES (v_water, 'DEMO-DEL-W0002', v_sale_w3, v_vehicle_w, v_driver_w, v_route_w, 'Blue Ocean Distributors, Ojota', 'in_transit', current_date - 6, now() - interval '6 days' + interval '1 hour', v_admin_id, now() - interval '6 days');

  INSERT INTO public.deliveries (factory_id, delivery_number, sale_id, vehicle_id, driver_id, route_id, destination, status, scheduled_date, departed_at, delivered_at, created_by, created_at)
  VALUES (v_nylon, 'DEMO-DEL-N0001', v_sale_n1, v_vehicle_n, v_driver_n, v_route_n, 'Metro Packaging Co, Apapa', 'delivered', current_date - 9, now() - interval '9 days' + interval '1 hour', now() - interval '9 days' + interval '4 hours', v_admin_id, now() - interval '9 days');

  INSERT INTO public.deliveries (factory_id, delivery_number, sale_id, vehicle_id, driver_id, route_id, destination, status, scheduled_date, created_by, created_at)
  VALUES (v_nylon, 'DEMO-DEL-N0002', v_sale_n3, v_vehicle_n, v_driver_n, v_route_n, 'FastWrap Logistics, Ajao Estate', 'pending', current_date + 1, v_admin_id, now() - interval '3 days');

  -- ==========================================================================
  -- NOTIFICATIONS (only if the current super admin account was found)
  -- ==========================================================================
  IF v_admin_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, factory_id, title, body, created_at) VALUES
      (v_admin_id, v_water, 'Sample data loaded', 'Demo customers, products, sales, production and expenses have been added to both factories so you can explore every page.', now());
  END IF;

  RAISE NOTICE 'Demo data seeded successfully: % suppliers, % customers, % employees, % products, % raw materials, % sales, % expenses, % payroll rows.',
    5, 9, 7, 8, 7, 8, 7, 7;
END $$;

-- ============================================================================
-- CLEANUP (uncomment and run later to remove ALL demo data — respects FKs by
-- deleting children before parents; leaves factories/settings/expense
-- categories/product categories in place since those aren't demo-specific)
-- ============================================================================
-- BEGIN;
--   DELETE FROM public.notifications WHERE title = 'Sample data loaded';
--   DELETE FROM public.deliveries WHERE delivery_number LIKE 'DEMO-%';
--   DELETE FROM public.drivers WHERE license_number LIKE 'LIC-%';
--   DELETE FROM public.vehicles WHERE plate_number IN ('ABC-123-XY','XYZ-456-KJ');
--   DELETE FROM public.delivery_routes WHERE name IN ('Lagos Mainland Route','Lagos Island / Apapa Route');
--   DELETE FROM public.costing_sheet_items WHERE sheet_id IN (SELECT id FROM public.costing_sheets WHERE sheet_number LIKE 'DEMO-%');
--   DELETE FROM public.costing_sheets WHERE sheet_number LIKE 'DEMO-%';
--   DELETE FROM public.cash_transactions WHERE transaction_number LIKE 'DEMO-%';
--   DELETE FROM public.payroll WHERE employee_id IN (SELECT id FROM public.employees WHERE employee_code LIKE 'DEMO-%');
--   DELETE FROM public.expenses WHERE requested_by_name IN ('Blessing Nwosu','Ade Johnson','Amina Yusuf','Emeka Obi') AND created_at > now() - interval '1 hour';
--   DELETE FROM public.debt_payments WHERE debt_id IN (SELECT id FROM public.debts WHERE sale_id IN (SELECT id FROM public.sales WHERE invoice_number LIKE 'DEMO-%'));
--   DELETE FROM public.debts WHERE sale_id IN (SELECT id FROM public.sales WHERE invoice_number LIKE 'DEMO-%');
--   DELETE FROM public.payments_received WHERE receipt_number LIKE 'DEMO-%';
--   DELETE FROM public.sale_items WHERE sale_id IN (SELECT id FROM public.sales WHERE invoice_number LIKE 'DEMO-%');
--   DELETE FROM public.sales WHERE invoice_number LIKE 'DEMO-%';
--   DELETE FROM public.inventory_movements WHERE reference LIKE 'DEMO-%';
--   DELETE FROM public.production_request_items WHERE request_id IN (SELECT id FROM public.production_requests WHERE request_number LIKE 'DEMO-%');
--   DELETE FROM public.production WHERE production_number LIKE 'DEMO-%';
--   DELETE FROM public.production_requests WHERE request_number LIKE 'DEMO-%';
--   DELETE FROM public.raw_material_movements WHERE reference LIKE 'DEMO-%';
--   DELETE FROM public.raw_materials WHERE name IN ('PET Preforms','Bottle Caps','Shrink Wrap Film','Water Treatment Chemicals','LDPE Resin','HDPE Resin','Colour Masterbatch');
--   DELETE FROM public.products WHERE sku LIKE 'WTR-%' OR sku LIKE 'NYL-%';
--   DELETE FROM public.product_categories WHERE name IN ('Bottled Water','Sachet Water','Shopping Bags','Packaging Rolls');
--   DELETE FROM public.employees WHERE employee_code LIKE 'DEMO-%';
--   DELETE FROM public.customers WHERE name IN ('Everfresh Supermarket','Blue Ocean Distributors','GreenLeaf Restaurants','City Mart Stores','Sunrise Hotels','Metro Packaging Co','FastWrap Logistics','Prime Retail Bags','Zenith Traders');
--   DELETE FROM public.suppliers WHERE name IN ('PureChem Nigeria Ltd','AquaPack Industries','Delta Preform Supplies','Polymer Traders Ltd','NylonPack Materials');
-- COMMIT;
