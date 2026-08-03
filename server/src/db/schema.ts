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
  -- Manufacturer/grammage variants (e.g. "PET Preform 16g – Prima" vs "...– Century")
  -- are separate items rows, each with their own stock — these two columns are what
  -- distinguish a variant from a plain material and drive the bags→pieces conversion
  -- at PO/GRN entry time. NULL for every item that isn't bought this way.
  manufacturer_id TEXT REFERENCES suppliers(id),
  pieces_per_bag REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- customer_type ('RETAIL'|'MARKETER'|'DISTRIBUTOR') drives genuinely different
-- order workflow in services/sales.ts — validated there, not by a DB CHECK
-- (kept loose at the DB level, consistent with e.g. payments.method).
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  customer_type TEXT NOT NULL DEFAULT 'MARKETER',
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
-- received_by is the Receiving Officer; inspection_officer (below) is filled
-- in separately once inspectGoodsReceived() runs — a GRN is logged at the
-- dock before anyone has decided what's accepted vs rejected.
CREATE TABLE IF NOT EXISTS goods_received (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  received_by TEXT,
  driver_name TEXT,
  driver_phone TEXT,
  vehicle_number TEXT,
  delivery_date TEXT,
  invoice_number TEXT,
  waybill_number TEXT,
  inspection_officer TEXT,
  inspected_at TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_INSPECTION' CHECK (status IN ('PENDING_INSPECTION','PARTIALLY_ACCEPTED','ACCEPTED','REJECTED','RETURNED')),
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_grn_po ON goods_received(po_id);

-- quantity is what was physically Delivered. expected_quantity is snapshotted
-- from the PO line at receiving time (never inspection-time client input —
-- it's a fact the system already knows). accepted/rejected/short/over are
-- only populated once inspectGoodsReceived() runs; NULL until then.
CREATE TABLE IF NOT EXISTS goods_received_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_id TEXT NOT NULL REFERENCES goods_received(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  expected_quantity REAL,
  quantity REAL NOT NULL,
  accepted_quantity REAL,
  rejected_quantity REAL,
  short_quantity REAL,
  over_quantity REAL,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_grn_items_grn ON goods_received_items(grn_id);

-- A rejected quantity never enters inventory (see inspectGoodsReceived in
-- services/receiving.ts) — it's tracked here instead, explicitly linked back
-- to the GRN, the PO and the supplier so it can be chased to a credit note
-- or physical pickup independent of any of those three records changing.
CREATE TABLE IF NOT EXISTS supplier_returns (
  id TEXT PRIMARY KEY,
  grn_id TEXT NOT NULL REFERENCES goods_received(id),
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_grn ON supplier_returns(grn_id);

CREATE TABLE IF NOT EXISTS supplier_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES supplier_returns(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_return ON supplier_return_items(return_id);

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

-- Bill of materials: for one unit of product_item_id produced, qty_per_unit of
-- component_item_id is consumed. Recording a batch's output (production.recordBatch)
-- auto-deducts every component here — see services/bom.ts. A product with no rows
-- here gets no auto-consumption, unchanged from before this table existed.
CREATE TABLE IF NOT EXISTS bom_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_item_id TEXT NOT NULL REFERENCES items(id),
  component_item_id TEXT NOT NULL REFERENCES items(id),
  qty_per_unit REAL NOT NULL DEFAULT 1,
  UNIQUE (product_item_id, component_item_id)
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

-- Empty dispenser bottles pulled from the warehouse for a production run —
-- deliberately its own small pipeline (see services/emptyBottleManagement.ts)
-- rather than a production_batches/bom_components retrofit: every bottle
-- pulled at quantity_issued must reconcile into damaged + leaking +
-- finished + returned, which that atomic single-call batch model has no
-- room for. "Empty Bottle Warehouse" and "Warehouse Finished Goods" are just
-- the ordinary inventory balance of the empty-bottle item and FG-03 — no new
-- stock-location table needed, only the run header below.
CREATE TABLE IF NOT EXISTS empty_bottle_runs (
  id TEXT PRIMARY KEY,
  quantity_issued REAL NOT NULL,
  issued_by TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RECONCILED')),
  damaged_quantity REAL,
  leaking_quantity REAL,
  finished_quantity REAL,
  returned_quantity REAL,
  actor TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  reconciled_at TEXT
);

-- Damaged/leaking bottles aren't sellable stock, so they don't belong in the
-- inventory ledger — this tracks their condition state instead. Damaged Empty
-- / Leaking Empty = SUM(that event) minus whatever's since been triaged away;
-- Repairable Empty = SUM(TRIAGED_TO_REPAIRABLE) minus SUM(REPAIRED_TO_GOOD);
-- Scrapped Empty = SUM(TRIAGED_TO_SCRAPPED), a terminal write-off.
CREATE TABLE IF NOT EXISTS empty_bottle_condition_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('DAMAGED','LEAKING','TRIAGED_TO_REPAIRABLE','TRIAGED_TO_SCRAPPED','REPAIRED_TO_GOOD')),
  quantity REAL NOT NULL,
  source_state TEXT,
  run_id TEXT REFERENCES empty_bottle_runs(id),
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_empty_bottle_condition_item ON empty_bottle_condition_events(item_id);

-- ===================== Sales =====================
-- Sales and Point-of-Sale are the same table distinguished by channel —
-- one inventory-deduction path instead of two divergent ones.
-- customer_id is nullable: a Retail POS sale needs no customer profile.
-- AWAITING_APPROVAL is the one new status — a Distributor buying on credit
-- sits here (header + sales_items recorded, nothing posted to inventory or
-- the ledger yet) until services/sales.ts's approveCreditSale/rejectCreditSale
-- resolves it. Every other customer type/terms combination skips this
-- entirely and behaves exactly as before.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  channel TEXT NOT NULL DEFAULT 'INVOICE' CHECK (channel IN ('INVOICE','POS')),
  rep TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AWAITING_APPROVAL','PROCESSING','DELIVERED','CANCELLED','PAID')),
  payment_terms TEXT NOT NULL DEFAULT 'CREDIT',
  approved_by TEXT,
  approved_at TEXT,
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

-- A major distributor's own branches (services/distributorBranches.ts,
-- Module 11) — a subordinate entity under a DISTRIBUTOR-type customers row,
-- lighter than Module 9's marketer_customers since branch purchasing still
-- goes through the real sales/ledger tables above, just tagged with which
-- branch it's for (sales.branch_id, ledger.branch_id) rather than a parallel
-- ledger. Fully optional — a distributor with none behaves as before.
CREATE TABLE IF NOT EXISTS distributor_branches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  location TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_distributor_branches_company ON distributor_branches(company_id);

-- Goods a Marketer brings back unsold. Only accepted_quantity ever re-enters
-- inventory (see salesReturns.inspectReturn in services/salesReturns.ts) —
-- the mirror image of Module 1's goods_received/inspectGoodsReceived, just
-- reversed in direction.
CREATE TABLE IF NOT EXISTS sales_returns (
  id TEXT PRIMARY KEY,
  sales_id TEXT NOT NULL REFERENCES sales(id),
  customer_id TEXT REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'PENDING_INSPECTION' CHECK (status IN ('PENDING_INSPECTION','PARTIALLY_ACCEPTED','ACCEPTED','REJECTED')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  inspected_by TEXT,
  inspected_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_returns_sales ON sales_returns(sales_id);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES sales_returns(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity_returned REAL NOT NULL,
  quantity_accepted REAL,
  quantity_rejected REAL,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_return_items_return ON sales_return_items(return_id);

-- ===================== Marketer stock accountability =====================
-- A Marketer's own mobile inventory — goods issued here are NOT a sale (see
-- sales.createOrder for that path, unaffected by any of this); nothing is
-- invoiced until recordSale reports what was actually sold in the field.
-- Append-only, balance derived exactly like inventory_transactions:
-- SUM(IN) - SUM(OUT) per (marketer_id, item_id).
CREATE TABLE IF NOT EXISTS marketer_stock_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketer_id TEXT NOT NULL REFERENCES customers(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL CHECK (source_type IN ('ISSUE','RETURN','SOLD')),
  source_id TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketer_stock_txn_marketer ON marketer_stock_transactions(marketer_id, item_id);

CREATE TABLE IF NOT EXISTS marketer_stock_issues (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL REFERENCES customers(id),
  issued_by TEXT,
  issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS marketer_stock_issue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL REFERENCES marketer_stock_issues(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0
);

-- Physical goods back from the marketer — no financial posting (see
-- services/marketerStock.ts): nothing was ever invoiced for unsold stock,
-- so there's nothing to reverse. Shrinks the marketer's stock balance, which
-- is the entirety of "reduce expected sales amount" — that figure is never
-- stored, just read live off this ledger.
CREATE TABLE IF NOT EXISTS marketer_returns (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL REFERENCES customers(id),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS marketer_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES marketer_returns(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0
);

-- What a marketer reports as actually sold out in the field — this is what
-- turns into real revenue/receivable; cash_received is whatever they hand
-- over on the spot, the rest becomes "Credit Given" on their AR balance.
CREATE TABLE IF NOT EXISTS marketer_sales (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL REFERENCES customers(id),
  cash_received REAL NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS marketer_sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id TEXT NOT NULL REFERENCES marketer_sales(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0
);

-- ===================== Marketer customer credit management =====================
-- A second, subordinate tier of "customer" — the people a marketer sells to
-- out in the field, not one of the company's own registered Marketer/
-- Distributor/Retail parties in "customers" (see services/marketerCustomers.ts).
-- credit_limit = 0 makes a customer strictly cash; > 0 makes them credit,
-- enforced at sale time, not just stored.
CREATE TABLE IF NOT EXISTS marketer_customers (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  phone TEXT,
  location TEXT,
  route TEXT,
  credit_limit REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketer_customers_marketer ON marketer_customers(marketer_id);

-- A sale attributed to one of a marketer's own customers — physically the
-- same event marketer_sales already models (see marketerStock.postFieldSale,
-- called by both), just with the extra attribution this table exists for.
CREATE TABLE IF NOT EXISTS marketer_customer_sales (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL REFERENCES customers(id),
  customer_id TEXT NOT NULL REFERENCES marketer_customers(id),
  cash_received REAL NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketer_customer_sales_customer ON marketer_customer_sales(customer_id);
CREATE TABLE IF NOT EXISTS marketer_customer_sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id TEXT NOT NULL REFERENCES marketer_customer_sales(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0
);

-- Follow-up notes on one invoice over time (services/marketerCustomers.ts,
-- Module 10) — append-only, a collector adds one each visit rather than
-- overwriting a single field, same reasoning as every other log in this app.
CREATE TABLE IF NOT EXISTS marketer_customer_sale_remarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id TEXT NOT NULL REFERENCES marketer_customer_sales(id),
  remark TEXT NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketer_customer_sale_remarks_sale ON marketer_customer_sale_remarks(sale_id);

-- A standalone payment against an existing balance — a customer paying down
-- credit later, not tied to a new sale. Each one also posts a credit to
-- marketer_customer_ledger below.
CREATE TABLE IF NOT EXISTS marketer_customer_payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES marketer_customers(id),
  amount REAL NOT NULL,
  method TEXT,
  reference_id TEXT,
  actor TEXT,
  paid_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The marketer's own AR sub-ledger for their customers — same debit=invoiced/
-- credit=paid convention as the company "ledger" (finance.ts), deliberately
-- a separate table: ledger.customer_id has a real FK into customers(id),
-- and marketer_customers is a different id space entirely.
CREATE TABLE IF NOT EXISTS marketer_customer_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL REFERENCES marketer_customers(id),
  entry_date TEXT NOT NULL DEFAULT (datetime('now')),
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  description TEXT,
  reference_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketer_customer_ledger_customer ON marketer_customer_ledger(customer_id);

-- Dispenser bottles are company assets, tracked separately from the FG
-- sales/consignment ledger above: "expected" empties owed is derived from
-- marketer_stock_transactions ISSUE rows (services/dispenserBottles.ts), and
-- this table records only the two things that ledger doesn't capture — an
-- empty physically coming back, or a named field customer keeping the
-- bottle because they bought it with no empty to trade in.
CREATE TABLE IF NOT EXISTS bottle_custody_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketer_id TEXT NOT NULL REFERENCES customers(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('EMPTY_RETURNED','SOLD_WITH_BOTTLE')),
  quantity REAL NOT NULL,
  customer_name TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bottle_custody_marketer ON bottle_custody_events(marketer_id, item_id);

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
-- supplier_id (on both tables below) is what turns "every supplier into an
-- Account" — a supplier's sub-ledger/statement/aging is just these two
-- tables filtered by it; there's no separate supplier-ledger table to keep
-- in sync. NULL means "not supplier-related", true of every pre-Module-2 row.
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL DEFAULT (datetime('now')),
  account TEXT NOT NULL,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id TEXT,
  description TEXT,
  supplier_id TEXT REFERENCES suppliers(id),
  customer_id TEXT REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  paid_to TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'CLEARED',
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  supplier_id TEXT REFERENCES suppliers(id)
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

-- Every POS receipt print event (services/posReceipts.ts, Module 13) — the
-- first print of a given sale is unrestricted; every one after that is a
-- reprint and requires approved_by/reason to exist at all (enforced in the
-- service, not here — SQLite can't express "these columns are required only
-- when is_reprint=1" as a table constraint). This table IS the audit trail.
CREATE TABLE IF NOT EXISTS pos_receipt_prints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_id TEXT NOT NULL REFERENCES sales(id),
  is_reprint INTEGER NOT NULL DEFAULT 0,
  printed_by TEXT,
  approved_by TEXT,
  reason TEXT,
  printed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_receipt_prints_sales ON pos_receipt_prints(sales_id);

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
-- department/old_value/new_value/reason/ip_address/device (Module 17) are
-- nullable — populated where they're actually meaningful (department is a
-- best-effort role lookup, old/new value only for reversals and master-data
-- edits, ip/device auto-captured per request) and NULL everywhere else,
-- which is correct for a plain create with no prior state to diff.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  summary TEXT,
  department TEXT,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  ip_address TEXT,
  device TEXT,
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

-- ===================== Reversals (Module 17) =====================
-- "No transaction may be edited — corrections must be made through reversing
-- transactions." Rather than widen a CHECK constraint on every affected
-- table's status column (a guarded-rebuild migration, like ensureGrnUpgrade/
-- ensureSalesUpgrade below) to add a 'REVERSED' value, this table is the
-- single source of truth for "has this entity been reversed" — the original
-- row's status is never rewritten, a reversal is a new event layered on top.
-- UNIQUE(entity_type, entity_id) blocks a double reversal of the same entity.
CREATE TABLE IF NOT EXISTS reversals (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reversed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reversed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_reversals_entity ON reversals(entity_type, entity_id);

-- ===================== Day close =====================
-- A close-of-business sign-off (services/dayClose.ts): only ever inserted
-- when every open-record check across the app passes, so its mere existence
-- for a given business_date IS the reconciliation proof — nothing about a
-- close is ever partially written. business_date is a label for the audit
-- trail, not a filter the checks themselves use (they always read current
-- state, live).
CREATE TABLE IF NOT EXISTS day_closes (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('CLOSED')),
  checked_by TEXT,
  actor TEXT,
  closed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
