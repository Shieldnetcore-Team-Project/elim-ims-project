-- =============================================================================
-- 0014_indexes.sql
-- PostgreSQL does not auto-index foreign keys (unlike the PK/UNIQUE side of
-- a relationship, which already has one via the constraint). Every FK
-- column that is queried directly — as an equality filter or a join —
-- gets one here. Also: partial indexes for the handful of "pending queue"
-- queries every workflow module runs on page load, and indexes to support
-- range scans on timestamp columns.
-- =============================================================================

-- ---- People & access -------------------------------------------------------
CREATE INDEX idx_employees_department       ON employees(department_id);
CREATE INDEX idx_employees_job_title        ON employees(job_title_id);
CREATE INDEX idx_employees_status           ON employees(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_role                 ON users(role_id);
CREATE INDEX idx_users_status               ON users(status) WHERE deleted_at IS NULL;

-- ---- Masters ----------------------------------------------------------
CREATE INDEX idx_suppliers_location         ON suppliers(location_id);
CREATE INDEX idx_customers_location         ON customers(location_id);
CREATE INDEX idx_vehicles_driver            ON vehicles(default_driver_employee_id);
CREATE INDEX idx_assets_location            ON assets(location_id);
CREATE INDEX idx_settings_updated_by        ON settings(updated_by_employee_id);
CREATE INDEX idx_items_category             ON items(category_id);
CREATE INDEX idx_items_uom                  ON items(uom_code);
CREATE INDEX idx_water_runs_source          ON water_treatment_runs(source_id);
CREATE INDEX idx_water_runs_stage           ON water_treatment_runs(stage_id);
CREATE INDEX idx_water_runs_operator        ON water_treatment_runs(operator_employee_id);
CREATE INDEX idx_water_runs_tested_at       ON water_treatment_runs(tested_at);

-- ---- Procurement / receiving / QC --------------------------------------
CREATE INDEX idx_po_supplier                ON purchase_orders(supplier_id);
CREATE INDEX idx_po_requested_by            ON purchase_orders(requested_by_employee_id);
CREATE INDEX idx_po_status_pending          ON purchase_orders(status) WHERE status IN ('DRAFT','AWAITING_APPROVAL');
CREATE INDEX idx_po_items_item              ON purchase_order_items(item_id);
CREATE INDEX idx_grn_po                     ON goods_received(po_id);
CREATE INDEX idx_grn_received_by            ON goods_received(received_by_employee_id);
CREATE INDEX idx_grn_status_pending         ON goods_received(status) WHERE status = 'PENDING_QC';
CREATE INDEX idx_grn_items_item             ON goods_received_items(item_id);
CREATE INDEX idx_qc_ref                     ON quality_control(ref_type, ref_id);
CREATE INDEX idx_qc_inspector               ON quality_control(inspector_employee_id);

-- ---- Inventory / warehouse ----------------------------------------------
CREATE INDEX idx_inv_item                   ON inventory_transactions(item_id);
CREATE INDEX idx_inv_source                 ON inventory_transactions(source_type, source_id);
CREATE INDEX idx_inv_actor                  ON inventory_transactions(actor_employee_id);
CREATE INDEX idx_inv_created_at             ON inventory_transactions(created_at);
CREATE INDEX idx_inv_item_created_at        ON inventory_transactions(item_id, created_at);
CREATE INDEX idx_wr_item                    ON warehouse_requisitions(item_id);
CREATE INDEX idx_wr_department              ON warehouse_requisitions(department_id);
CREATE INDEX idx_wr_requested_by            ON warehouse_requisitions(requested_by_employee_id);
CREATE INDEX idx_wr_status_pending          ON warehouse_requisitions(status) WHERE status = 'PENDING';

-- ---- Production / packaging ----------------------------------------------
CREATE INDEX idx_mr_requested_by            ON material_requests(requested_by_employee_id);
CREATE INDEX idx_mr_department              ON material_requests(department_id);
CREATE INDEX idx_mr_status_pending          ON material_requests(status) WHERE status = 'PENDING';
CREATE INDEX idx_mri_item                   ON material_request_items(item_id);
CREATE INDEX idx_sm_request                 ON stock_movements(request_id);
CREATE INDEX idx_sm_item                    ON stock_movements(item_id);
CREATE INDEX idx_sm_from_location           ON stock_movements(from_location_id);
CREATE INDEX idx_sm_to_location             ON stock_movements(to_location_id);
CREATE INDEX idx_sm_moved_by                ON stock_movements(moved_by_employee_id);
CREATE INDEX idx_pb_product                 ON production_batches(product_item_id);
CREATE INDEX idx_pb_line                    ON production_batches(line_id);
CREATE INDEX idx_pb_shift                   ON production_batches(shift_id);
CREATE INDEX idx_pb_operator                ON production_batches(operator_employee_id);
CREATE INDEX idx_pb_water_run               ON production_batches(water_treatment_run_id);
CREATE INDEX idx_pb_status                  ON production_batches(status);
CREATE INDEX idx_fg_batch                   ON finished_goods(batch_id);
CREATE INDEX idx_fg_item                    ON finished_goods(item_id);
CREATE INDEX idx_fg_packaged_by             ON finished_goods(packaged_by_employee_id);

-- ---- Sales / fleet -------------------------------------------------------
CREATE INDEX idx_so_customer                ON sales_orders(customer_id);
CREATE INDEX idx_so_rep                     ON sales_orders(rep_employee_id);
CREATE INDEX idx_so_status                  ON sales_orders(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_so_channel                 ON sales_orders(channel);
CREATE INDEX idx_soi_item                   ON sales_order_items(item_id);
CREATE INDEX idx_dr_sales_order             ON delivery_runs(sales_order_id);
CREATE INDEX idx_dr_vehicle                 ON delivery_runs(vehicle_id);
CREATE INDEX idx_dr_driver                  ON delivery_runs(driver_employee_id);
CREATE INDEX idx_dr_status_active           ON delivery_runs(status) WHERE status IN ('SCHEDULED','ACTIVE');

-- ---- Finance ---------------------------------------------------------
CREATE INDEX idx_ledger_account             ON ledger_entries(account_id);
CREATE INDEX idx_ledger_reference           ON ledger_entries(reference_type, reference_id);
CREATE INDEX idx_ledger_entry_date          ON ledger_entries(entry_date);
CREATE INDEX idx_payments_counterparty      ON payments(counterparty_type, counterparty_id);
CREATE INDEX idx_payments_reference         ON payments(reference_type, reference_id);
CREATE INDEX idx_payments_status            ON payments(status);
CREATE INDEX idx_receipts_counterparty      ON receipts(counterparty_type, counterparty_id);
CREATE INDEX idx_receipts_reference         ON receipts(reference_type, reference_id);
CREATE INDEX idx_receipts_status            ON receipts(status);
CREATE INDEX idx_payroll_employee           ON payroll_runs(employee_id);
CREATE INDEX idx_payroll_status             ON payroll_runs(status);

-- ---- Reports / audit / deletion -------------------------------------------
CREATE INDEX idx_reports_owner              ON reports(owner_employee_id);
CREATE INDEX idx_reports_status             ON reports(status);
CREATE INDEX idx_activity_actor             ON activity_log(actor_user_id);
CREATE INDEX idx_activity_target            ON activity_log(target_type, target_id);
CREATE INDEX idx_activity_at                ON activity_log(at);
CREATE INDEX idx_deletion_entity            ON deletion_requests(entity_type, entity_id);
CREATE INDEX idx_deletion_status_pending    ON deletion_requests(status) WHERE status = 'PENDING';
CREATE INDEX idx_deletion_requested_by      ON deletion_requests(requested_by_user_id);
CREATE INDEX idx_deletion_reviewed_by       ON deletion_requests(reviewed_by_user_id);
