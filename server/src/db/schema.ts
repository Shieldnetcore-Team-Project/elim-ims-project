// Kept as a TS template literal (not a standalone .sql file) so it survives
// esbuild's single-file bundle unchanged — a separate asset file wouldn't be
// copied alongside dist/index.js.
export const SCHEMA_SQL = `
-- Elim ERP schema. Every business action lands here as a row; nothing is
-- ever overwritten in place except a handful of explicit status fields.

-- ===================== Masters =====================
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('RAW_MATERIAL','PACKAGING','CONSUMABLE','FINISHED_GOOD')),
  uom TEXT NOT NULL DEFAULT 'unit',
  reorder_point REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT,
  role TEXT,
  tenure TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_active TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  description TEXT,
  members INTEGER NOT NULL DEFAULT 0,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  driver TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  odometer TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  equipment TEXT NOT NULL,
  location TEXT,
  last_service TEXT,
  next_due TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  description TEXT,
  value TEXT,
  updated_by TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS water_treatment_runs (
  id TEXT PRIMARY KEY,
  source TEXT,
  stage TEXT,
  volume_l REAL,
  operator TEXT,
  status TEXT NOT NULL DEFAULT 'PASS' CHECK (status IN ('PASS','IN_PROGRESS','FAIL')),
  tested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Procurement =====================
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','REJECTED','RECEIVED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);

-- ===================== Receiving =====================
CREATE TABLE IF NOT EXISTS goods_received (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  received_by TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_QC' CHECK (status IN ('PENDING_QC','PASSED','FAILED')),
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_grn_po ON goods_received(po_id);

CREATE TABLE IF NOT EXISTS goods_received_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_id TEXT NOT NULL REFERENCES goods_received(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grn_items_grn ON goods_received_items(grn_id);

-- ===================== Quality control =====================
-- ref_type/ref_id is a polymorphic pointer at either goods_received or
-- production_batches — SQLite can't express a conditional FK, so this is
-- validated in the service layer instead.
CREATE TABLE IF NOT EXISTS quality_control (
  id TEXT PRIMARY KEY,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('GOODS_RECEIVED','PRODUCTION_BATCH')),
  ref_id TEXT NOT NULL,
  inspector TEXT,
  parameter TEXT,
  result TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('PASS','FAIL')),
  notes TEXT,
  tested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qc_ref ON quality_control(ref_type, ref_id);

-- ===================== Inventory =====================
-- Append-only. The on-hand balance is never stored — it's always derived.
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL CHECK (source_type IN ('PURCHASE','PRODUCTION','SALES','MATERIAL_ISSUE','ADJUSTMENT')),
  source_id TEXT,
  note TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inv_item ON inventory_transactions(item_id);

CREATE VIEW IF NOT EXISTS inventory_balances AS
SELECT item_id, SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) AS on_hand
FROM inventory_transactions
GROUP BY item_id;

-- ===================== Warehouse =====================
CREATE TABLE IF NOT EXISTS warehouse_requisitions (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  expected_delivery TEXT,
  priority TEXT NOT NULL DEFAULT 'Medium',
  reason TEXT,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','ISSUED','REJECTED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Production: material requests =====================
CREATE TABLE IF NOT EXISTS material_requests (
  id TEXT PRIMARY KEY,
  requested_by TEXT,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ISSUED','REJECTED')),
  needed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS material_request_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES material_requests(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mri_request ON material_request_items(request_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT REFERENCES material_requests(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  from_location TEXT,
  to_location TEXT,
  moved_by TEXT,
  moved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Manufacturing =====================
CREATE TABLE IF NOT EXISTS production_batches (
  id TEXT PRIMARY KEY,
  product_item_id TEXT NOT NULL REFERENCES items(id),
  line TEXT,
  shift TEXT,
  operator TEXT,
  units_target REAL,
  units_actual REAL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  water_treatment_run_id TEXT REFERENCES water_treatment_runs(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- ===================== Packaging =====================
CREATE TABLE IF NOT EXISTS finished_goods (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES production_batches(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  packaged_by TEXT,
  packaged_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Sales =====================
-- Sales and Point-of-Sale are the same table distinguished by channel —
-- one inventory-deduction path instead of two divergent ones.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  channel TEXT NOT NULL DEFAULT 'INVOICE' CHECK (channel IN ('INVOICE','POS')),
  rep TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DELIVERED','CANCELLED','PAID')),
  total_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_id TEXT NOT NULL REFERENCES sales(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_items_sales ON sales_items(sales_id);

-- ===================== Fleet & delivery =====================
CREATE TABLE IF NOT EXISTS delivery_runs (
  id TEXT PRIMARY KEY,
  sales_id TEXT NOT NULL REFERENCES sales(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver TEXT,
  route TEXT,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','ACTIVE','DELIVERED')),
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delivery_sales ON delivery_runs(sales_id);

-- ===================== Finance =====================
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL DEFAULT (datetime('now')),
  account TEXT NOT NULL,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  paid_to TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'CLEARED',
  paid_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  received_from TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'CLEARED',
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Payroll =====================
CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES employees(id),
  staff_name TEXT,
  period TEXT NOT NULL,
  gross REAL NOT NULL,
  net REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('PAID','SCHEDULED','ON_HOLD')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payroll_staff ON payroll_runs(staff_id);

-- ===================== Reports =====================
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','RUNNING','FAILED')),
  last_run TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== Activity log =====================
-- The audit trail: every service call in server/src/services appends here.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  summary TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log(at);

-- ===================== Access control =====================
-- No row for a (user, page) pair = no access. Dashboard and super admins
-- (users.role = 'System admin') bypass this entirely — enforced in the
-- service/client layer, not here.
CREATE TABLE IF NOT EXISTS user_page_access (
  user_id TEXT NOT NULL REFERENCES users(id),
  page_key TEXT NOT NULL,
  PRIMARY KEY (user_id, page_key)
);

-- ===================== Deletion requests =====================
-- Nothing in this app is ever hard-deleted. A delete action anywhere creates
-- a PENDING row here instead; a super admin's approval is what actually
-- hides the record (see services/deletionRequests.ts: filterDeleted()).
CREATE TABLE IF NOT EXISTS deletion_requests (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_label TEXT,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_deletion_status ON deletion_requests(status);
CREATE INDEX IF NOT EXISTS idx_deletion_entity ON deletion_requests(entity_type, entity_id);
`;
