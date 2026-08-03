-- =============================================================================
-- 0013_views.sql
-- Read-side conveniences. None of these store anything — every one is a
-- live query over the base tables, so none of the totals or classifications
-- they expose can ever drift from the source rows.
-- =============================================================================

-- Current on-hand balance per item, plus the IN_STOCK/LOW_STOCK/OUT_OF_STOCK
-- classification the Inventory module status column needs.
CREATE VIEW v_inventory_status AS
SELECT
  i.id, i.code, i.name, ic.name AS category, i.type, i.uom_code, i.reorder_point, i.unit_cost,
  COALESCE(t.on_hand, 0) AS on_hand,
  CASE
    WHEN COALESCE(t.on_hand, 0) <= 0 THEN 'OUT_OF_STOCK'
    WHEN COALESCE(t.on_hand, 0) <= i.reorder_point THEN 'LOW_STOCK'
    ELSE 'IN_STOCK'
  END AS status
FROM items i
JOIN item_categories ic ON ic.id = i.category_id
LEFT JOIN (
  SELECT item_id, SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) AS on_hand
  FROM inventory_transactions
  GROUP BY item_id
) t ON t.item_id = i.id
WHERE i.deleted_at IS NULL;

CREATE VIEW v_low_stock_alerts AS
SELECT id, code, name, uom_code, on_hand, reorder_point
FROM v_inventory_status
WHERE status IN ('LOW_STOCK', 'OUT_OF_STOCK')
ORDER BY on_hand ASC;

-- Purchase order header + computed total (never stored, see 0005).
CREATE VIEW v_purchase_order_totals AS
SELECT
  po.id, po.code, po.supplier_id, s.name AS supplier_name, po.status,
  COALESCE(SUM(poi.quantity * poi.unit_price), 0) AS total_amount,
  po.created_at
FROM purchase_orders po
JOIN suppliers s ON s.id = po.supplier_id
LEFT JOIN purchase_order_items poi ON poi.po_id = po.id
WHERE po.deleted_at IS NULL
GROUP BY po.id, po.code, po.supplier_id, s.name, po.status, po.created_at;

CREATE VIEW v_sales_order_summary AS
SELECT
  so.id, so.code, so.customer_id, c.name AS customer_name, l.name AS customer_location,
  so.channel, so.rep_employee_id, e.full_name AS rep_name, so.status, so.total_amount, so.created_at
FROM sales_orders so
JOIN customers c ON c.id = so.customer_id
LEFT JOIN locations l ON l.id = c.location_id
LEFT JOIN employees e ON e.id = so.rep_employee_id
WHERE so.deleted_at IS NULL;

-- Accounts-receivable aging: invoiced value not yet collected, per customer.
CREATE VIEW v_customer_outstanding_balance AS
SELECT c.id AS customer_id, c.code, c.name, fn_customer_outstanding_balance(c.id) AS outstanding
FROM customers c
WHERE c.deleted_at IS NULL;

-- Accounts-payable aging: approved/received PO value not yet paid, per supplier.
CREATE VIEW v_supplier_payables AS
SELECT s.id AS supplier_id, s.code, s.name, fn_supplier_outstanding_balance(s.id) AS payable
FROM suppliers s
WHERE s.deleted_at IS NULL;

CREATE VIEW v_production_yield AS
SELECT
  pb.id, pb.code, i.name AS product_name, pl.name AS line, sh.name AS shift,
  e.full_name AS operator, pb.units_target, pb.units_actual,
  CASE WHEN pb.units_target > 0 THEN round(pb.units_actual / pb.units_target * 100, 1) END AS yield_pct,
  pb.status, pb.started_at, pb.completed_at
FROM production_batches pb
JOIN items i ON i.id = pb.product_item_id
LEFT JOIN production_lines pl ON pl.id = pb.line_id
LEFT JOIN shifts sh ON sh.id = pb.shift_id
LEFT JOIN employees e ON e.id = pb.operator_employee_id;

CREATE VIEW v_delivery_performance AS
SELECT
  dr.id, dr.code, so.code AS sales_order_code, c.name AS customer_name,
  v.code AS vehicle_code, e.full_name AS driver_name, dr.route, dr.status,
  dr.dispatched_at, dr.delivered_at,
  CASE WHEN dr.delivered_at IS NOT NULL THEN dr.delivered_at - dr.dispatched_at END AS turnaround
FROM delivery_runs dr
JOIN sales_orders so ON so.id = dr.sales_order_id
JOIN customers c ON c.id = so.customer_id
JOIN vehicles v ON v.id = dr.vehicle_id
LEFT JOIN employees e ON e.id = dr.driver_employee_id;

-- Tenure is derived from hire_date rather than stored as free text (see 0003).
CREATE VIEW v_employee_directory AS
SELECT
  emp.id, emp.code, emp.full_name, d.name AS department, jt.title AS job_title,
  emp.hire_date, age(current_date, emp.hire_date) AS tenure, emp.status
FROM employees emp
LEFT JOIN departments d ON d.id = emp.department_id
LEFT JOIN job_titles jt ON jt.id = emp.job_title_id
WHERE emp.deleted_at IS NULL;

-- Replaces the stored, driftable app_roles.members counter (see 0003).
CREATE VIEW v_role_member_counts AS
SELECT r.id AS role_id, r.name, r.description, r.scope, r.status, COUNT(u.id) AS members
FROM app_roles r
LEFT JOIN users u ON u.role_id = r.id AND u.deleted_at IS NULL
GROUP BY r.id, r.name, r.description, r.scope, r.status;

-- Effective page access = role baseline UNION per-user grants.
CREATE VIEW v_effective_page_access AS
SELECT u.id AS user_id, rpa.page_key
FROM users u
JOIN role_page_access rpa ON rpa.role_id = u.role_id
UNION
SELECT upa.user_id, upa.page_key
FROM user_page_access upa;
