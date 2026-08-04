-- =============================================================================
-- 20260803120300_rls_core_tables.sql
-- RLS for master-data tables and every transactional/module table except the
-- append-only ledgers and admin/audit tables (20260803120400) and
-- notifications (20260803120700, defined alongside its own table).
--
-- Two shapes repeat throughout this file:
--   "master"       — SELECT open to any authenticated session (most modules
--                     need to read item/supplier/customer names to render),
--                     INSERT/UPDATE gated to the one page that owns the record.
--   "module table" — SELECT/INSERT/UPDATE all gated to the owning page(s).
-- Neither shape gets a DELETE policy — see 20260803120200's header note.
-- =============================================================================

-- ---- Masters ------------------------------------------------------------
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_select ON items FOR SELECT TO authenticated USING (true);
CREATE POLICY items_insert ON items FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('inventory'));
CREATE POLICY items_update ON items FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('inventory')) WITH CHECK (is_super_admin() OR has_page_access('inventory'));

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY suppliers_select ON suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY suppliers_insert ON suppliers FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY suppliers_update ON suppliers FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('procurement')) WITH CHECK (is_super_admin() OR has_page_access('procurement'));

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_select ON customers FOR SELECT TO authenticated USING (true);
CREATE POLICY customers_insert ON customers FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('sales') OR has_page_access('pos'));
CREATE POLICY customers_update ON customers FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('sales') OR has_page_access('pos')) WITH CHECK (is_super_admin() OR has_page_access('sales') OR has_page_access('pos'));

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;
CREATE POLICY vehicles_select ON vehicles FOR SELECT TO authenticated USING (true);
CREATE POLICY vehicles_insert ON vehicles FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('fleet'));
CREATE POLICY vehicles_update ON vehicles FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('fleet')) WITH CHECK (is_super_admin() OR has_page_access('fleet'));

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
CREATE POLICY assets_select ON assets FOR SELECT TO authenticated USING (true);
CREATE POLICY assets_insert ON assets FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('assets'));
CREATE POLICY assets_update ON assets FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('assets')) WITH CHECK (is_super_admin() OR has_page_access('assets'));

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings_select ON settings FOR SELECT TO authenticated USING (true);
CREATE POLICY settings_insert ON settings FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('settings'));
CREATE POLICY settings_update ON settings FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('settings')) WITH CHECK (is_super_admin() OR has_page_access('settings'));

-- ---- Water treatment (operational log, not a lookup) ---------------------
ALTER TABLE water_treatment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE water_treatment_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY wtr_select ON water_treatment_runs FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('water-treatment'));
CREATE POLICY wtr_insert ON water_treatment_runs FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('water-treatment'));
CREATE POLICY wtr_update ON water_treatment_runs FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('water-treatment')) WITH CHECK (is_super_admin() OR has_page_access('water-treatment'));

-- ---- Procurement / receiving / QC -----------------------------------------
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY po_select ON purchase_orders FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY po_insert ON purchase_orders FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY po_update ON purchase_orders FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('procurement')) WITH CHECK (is_super_admin() OR has_page_access('procurement'));

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY poi_select ON purchase_order_items FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY poi_insert ON purchase_order_items FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY poi_update ON purchase_order_items FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('procurement')) WITH CHECK (is_super_admin() OR has_page_access('procurement'));

ALTER TABLE goods_received ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_received FORCE ROW LEVEL SECURITY;
CREATE POLICY grn_select ON goods_received FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY grn_insert ON goods_received FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY grn_update ON goods_received FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('procurement')) WITH CHECK (is_super_admin() OR has_page_access('procurement'));

ALTER TABLE goods_received_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_received_items FORCE ROW LEVEL SECURITY;
CREATE POLICY grni_select ON goods_received_items FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY grni_insert ON goods_received_items FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('procurement'));
CREATE POLICY grni_update ON goods_received_items FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('procurement')) WITH CHECK (is_super_admin() OR has_page_access('procurement'));

ALTER TABLE quality_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_control FORCE ROW LEVEL SECURITY;
CREATE POLICY qc_select ON quality_control FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('quality-control'));
CREATE POLICY qc_insert ON quality_control FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('quality-control'));
CREATE POLICY qc_update ON quality_control FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('quality-control')) WITH CHECK (is_super_admin() OR has_page_access('quality-control'));

-- ---- Warehouse -------------------------------------------------------------
ALTER TABLE warehouse_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_requisitions FORCE ROW LEVEL SECURITY;
CREATE POLICY wr_select ON warehouse_requisitions FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('warehouse'));
CREATE POLICY wr_insert ON warehouse_requisitions FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('warehouse'));
CREATE POLICY wr_update ON warehouse_requisitions FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('warehouse')) WITH CHECK (is_super_admin() OR has_page_access('warehouse'));

-- ---- Production / packaging -------------------------------------------------
ALTER TABLE material_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY mr_select ON material_requests FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('production'));
CREATE POLICY mr_insert ON material_requests FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('production'));
CREATE POLICY mr_update ON material_requests FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('production')) WITH CHECK (is_super_admin() OR has_page_access('production'));

ALTER TABLE material_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_request_items FORCE ROW LEVEL SECURITY;
CREATE POLICY mri_select ON material_request_items FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('production'));
CREATE POLICY mri_insert ON material_request_items FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('production'));
CREATE POLICY mri_update ON material_request_items FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('production')) WITH CHECK (is_super_admin() OR has_page_access('production'));

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY sm_select ON stock_movements FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('production') OR has_page_access('warehouse'));
CREATE POLICY sm_insert ON stock_movements FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('production') OR has_page_access('warehouse'));
-- No UPDATE policy — a stock movement is a point-in-time fact once issued, same reasoning as the append-only ledgers (20260803120400), even though no trigger currently enforces it at the table level.

ALTER TABLE production_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY pb_select ON production_batches FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('production'));
CREATE POLICY pb_insert ON production_batches FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('production'));
CREATE POLICY pb_update ON production_batches FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('production') OR has_page_access('quality-control')) WITH CHECK (is_super_admin() OR has_page_access('production') OR has_page_access('quality-control'));

ALTER TABLE finished_goods ENABLE ROW LEVEL SECURITY;
ALTER TABLE finished_goods FORCE ROW LEVEL SECURITY;
CREATE POLICY fg_select ON finished_goods FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('production') OR has_page_access('inventory'));
CREATE POLICY fg_insert ON finished_goods FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('production'));
-- No UPDATE policy — a packaging record is a point-in-time fact, same reasoning as stock_movements above.

-- ---- Sales / fleet -----------------------------------------------------------
ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY so_select ON sales_orders FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('sales') OR has_page_access('pos'));
CREATE POLICY so_insert ON sales_orders FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('sales') OR has_page_access('pos'));
CREATE POLICY so_update ON sales_orders FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('sales') OR has_page_access('pos')) WITH CHECK (is_super_admin() OR has_page_access('sales') OR has_page_access('pos'));

ALTER TABLE sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY soi_select ON sales_order_items FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('sales') OR has_page_access('pos'));
CREATE POLICY soi_insert ON sales_order_items FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('sales') OR has_page_access('pos'));
CREATE POLICY soi_update ON sales_order_items FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('sales') OR has_page_access('pos')) WITH CHECK (is_super_admin() OR has_page_access('sales') OR has_page_access('pos'));

ALTER TABLE delivery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY dr_select ON delivery_runs FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('fleet'));
CREATE POLICY dr_insert ON delivery_runs FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('fleet'));
CREATE POLICY dr_update ON delivery_runs FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('fleet')) WITH CHECK (is_super_admin() OR has_page_access('fleet'));

-- ---- Finance / payroll -------------------------------------------------------
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_select ON payments FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('finance'));
CREATE POLICY payments_insert ON payments FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('finance'));
-- No UPDATE policy — a payment is a point-in-time financial fact; corrections belong in a future reversal mechanism, not a mutable row.

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY receipts_select ON receipts FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('finance'));
CREATE POLICY receipts_insert ON receipts FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('finance'));
-- No UPDATE policy — same reasoning as payments.

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_select ON payroll_runs FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('payroll'));
CREATE POLICY payroll_insert ON payroll_runs FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('payroll'));
CREATE POLICY payroll_update ON payroll_runs FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('payroll')) WITH CHECK (is_super_admin() OR has_page_access('payroll'));

-- ---- HR / RBAC ---------------------------------------------------------------
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY employees_select ON employees FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('hr'));
CREATE POLICY employees_insert ON employees FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('hr'));
CREATE POLICY employees_update ON employees FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('hr')) WITH CHECK (is_super_admin() OR has_page_access('hr'));

ALTER TABLE app_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY app_roles_select ON app_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY app_roles_insert ON app_roles FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('roles'));
CREATE POLICY app_roles_update ON app_roles FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('roles')) WITH CHECK (is_super_admin() OR has_page_access('roles'));

-- users: self-service read/limited-update, admin-only insert. handle_new_user
-- (20260803120000) is SECURITY DEFINER and bypasses RLS entirely — this
-- INSERT policy only gates writes attempted from a normal (non-DEFINER) session.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT TO authenticated
  USING (is_super_admin() OR has_page_access('users') OR id = current_app_user_id());
CREATE POLICY users_insert ON users FOR INSERT TO authenticated
  WITH CHECK (is_super_admin());
CREATE POLICY users_update ON users FOR UPDATE TO authenticated
  USING (is_super_admin() OR has_page_access('users') OR id = current_app_user_id())
  WITH CHECK (
    is_super_admin() OR has_page_access('users')
    -- A self-service update may not change one's own role — only an admin
    -- (or someone with the 'users' page) may reassign role_id.
    OR (id = current_app_user_id() AND role_id IS NOT DISTINCT FROM (SELECT role_id FROM users WHERE id = current_app_user_id()))
  );

-- ---- Reports -------------------------------------------------------------
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;
CREATE POLICY reports_select ON reports FOR SELECT TO authenticated USING (is_super_admin() OR has_page_access('reports'));
CREATE POLICY reports_insert ON reports FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('reports'));
CREATE POLICY reports_update ON reports FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('reports')) WITH CHECK (is_super_admin() OR has_page_access('reports'));
