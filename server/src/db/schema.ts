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
  phone TEXT,
  customer_type TEXT NOT NULL DEFAULT 'MARKETER',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Section 25: tenure is deliberately never a stored/editable field going
-- forward — date_engaged/date_disengaged are the source of truth, and
-- tenure is always computed live from them (peripheral.ts injects it before
-- every read). The legacy tenure column stays for any pre-existing data
-- but is no longer offered as an input anywhere.
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT,
  role TEXT,
  tenure TEXT,
  date_engaged TEXT,
  date_disengaged TEXT,
  exit_reason TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
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
  -- Nullable: requested_by above stays free text (a PO can be raised on
  -- someone else's behalf), but when the raiser is a real logged-in user this
  -- is how the approval route can tell "the same person is trying to approve
  -- what they just requested" and block it — real segregation of duties
  -- between Procurement Officer and Procurement Manager, not just a capability
  -- flag nobody's forced to split across two people.
  requested_by_user_id TEXT,
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
-- product_type/reviewed_by (Section 19) are nullable additions layered onto
-- the original single-parameter shape (parameter/result stay exactly as they
-- were, still written by the old recordResult() path) — a multi-parameter
-- test (see quality_test_parameters below and qualityControl.recordTest())
-- writes parameter/result as a rolled-up summary string here for anything
-- still reading this table directly, while the real per-parameter detail
-- that explains the verdict lives in the child table, one row per id.
CREATE TABLE IF NOT EXISTS quality_control (
  id TEXT PRIMARY KEY,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('GOODS_RECEIVED','PRODUCTION_BATCH')),
  ref_id TEXT NOT NULL,
  inspector TEXT,
  parameter TEXT,
  result TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('PASS','FAIL')),
  notes TEXT,
  product_type TEXT CHECK (product_type IN ('RAW_WATER','TREATED_WATER','UNTREATED_WATER','OTHER')),
  reviewed_by TEXT,
  tested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qc_ref ON quality_control(ref_type, ref_id);

-- One row per parameter measured in a single quality_control test (Section
-- 19: "do not hard-code only pH" — parameter_name is free text drawn from a
-- configurable list, see qualityControl.parameterNames(), never a fixed
-- enum). result is never trusted from the client alone: whenever min_value/
-- max_value are both present and measured_value parses as a number,
-- qualityControl.recordTest() recomputes result itself by comparing the two,
-- overriding whatever the caller sent — the whole point being that "Passed"
-- always has to be independently explainable from this table, not just
-- asserted. Only a genuinely qualitative parameter (no numeric range, e.g.
-- Odour/Taste) falls back to trusting the tester's own PASS/FAIL call.
CREATE TABLE IF NOT EXISTS quality_test_parameters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qc_id TEXT NOT NULL REFERENCES quality_control(id),
  parameter_name TEXT NOT NULL,
  measured_value TEXT NOT NULL,
  unit TEXT,
  min_value REAL,
  max_value REAL,
  expected_value TEXT,
  result TEXT NOT NULL CHECK (result IN ('PASS','FAIL'))
);
CREATE INDEX IF NOT EXISTS idx_qc_params_qc ON quality_test_parameters(qc_id);

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
  -- Physical from/to for this movement (e.g. 'Production Floor' -> 'Finished
  -- Goods Warehouse' for a packaged batch) — distinct from source_type, which
  -- only names the business event, not a location. Nullable: legacy rows and
  -- plain ADJUSTMENTs carry none. Set explicitly per call site in the
  -- services layer rather than inferred here, since source_type is reused
  -- across physically different flows (e.g. PRODUCTION covers both raw-
  -- material consumption and finished-goods intake).
  from_location TEXT,
  to_location TEXT,
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
-- Section 24: rejected/wasted are only ever set together, once, by
-- production.closeBatch() — closed_at IS NOT NULL is what "Closed Production
-- Batches" means (kept as a nullable timestamp rather than a new status
-- value so the existing IN_PROGRESS/COMPLETED/FAILED CHECK never needs a
-- guarded-rebuild). Not Yet Packaged is never stored — always
-- units_actual - packaged - rejected_quantity - wasted_quantity, live.
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
  rejected_quantity REAL NOT NULL DEFAULT 0,
  wasted_quantity REAL NOT NULL DEFAULT 0,
  closed_by TEXT,
  closed_at TEXT,
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

-- Payment lines captured at sale creation time (POS only in practice — see
-- services/sales.ts createOrder). Every retail sale now sits AWAITING_APPROVAL
-- until a manager approves it, but the cashier already collected this money
-- at the till, so it's kept here and replayed into finance.recordReceipt once
-- approveCreditSale runs — otherwise the payment method/split would be lost.
CREATE TABLE IF NOT EXISTS sales_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_id TEXT NOT NULL REFERENCES sales(id),
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_payments_sales ON sales_payments(sales_id);

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

-- Section 12: warehouse posting stock to a marketer and the marketer holding
-- it are two different, separately-recorded events — status starts ASSIGNED
-- (physically left the warehouse, posted by the warehouse) and only becomes
-- VERIFIED once the marketer confirms what actually arrived (see
-- marketerStock.verifyAssignment). Confirmation, not managerial approval:
-- verifying is the marketer's own action, nobody else's sign-off.
CREATE TABLE IF NOT EXISTS marketer_stock_issues (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL REFERENCES customers(id),
  issued_by TEXT,
  status TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','VERIFIED')),
  verified_by TEXT,
  verified_at TEXT,
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

-- ===================== Retail stock =====================
-- Retail's own bounded stock, issued out of the central warehouse (see
-- services/retailStock.ts) — mirrors marketer_stock_transactions above but
-- scoped to the single Retail unit, so no per-marketer column is needed.
-- Append-only; balance = SUM(IN)-SUM(OUT) per item_id, same convention as
-- inventory_transactions/marketer_stock_transactions.
CREATE TABLE IF NOT EXISTS retail_stock_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL CHECK (source_type IN ('INTAKE','SOLD','ADJUSTMENT')),
  source_id TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retail_stock_txn_item ON retail_stock_transactions(item_id);

CREATE TABLE IF NOT EXISTS retail_intakes (
  id TEXT PRIMARY KEY,
  issued_by TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS retail_intake_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intake_id TEXT NOT NULL REFERENCES retail_intakes(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_retail_intake_items_intake ON retail_intake_items(intake_id);

-- ===================== Retail return / exchange (Module 21) =====================
-- Section 10: a retail correction is never an edit of the original sale —
-- original_sales_id always points at a real, untouched sales row (Retail's
-- own POS sales post immediately, so unlike Module 3's sales_returns there's
-- no inspection delay: the returned quantity posts back to Retail stock and
-- the refund posts to the ledger the moment this is recorded). new_sales_id
-- is the "New transaction reference" the spec asks for — an ordinary POS
-- sale created via sales.createOrder for whatever the customer takes
-- instead, left NULL for a plain return with no replacement. Preserves
-- exactly "Original Sale -> Return/Correction -> New Sale" as three
-- separate, linked rows, never one edited in place.
CREATE TABLE IF NOT EXISTS retail_exchanges (
  id TEXT PRIMARY KEY,
  original_sales_id TEXT NOT NULL REFERENCES sales(id),
  new_sales_id TEXT REFERENCES sales(id),
  customer_id TEXT REFERENCES customers(id),
  reason TEXT NOT NULL,
  staff TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retail_exchanges_original ON retail_exchanges(original_sales_id);

-- unit_price is snapshotted from the original sale's line, not looked up live —
-- the refund must value the return at what the customer actually paid.
CREATE TABLE IF NOT EXISTS retail_exchange_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange_id TEXT NOT NULL REFERENCES retail_exchanges(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  quantity_returned REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_retail_exchange_items_exchange ON retail_exchange_items(exchange_id);

-- ===================== Fleet & delivery =====================
CREATE TABLE IF NOT EXISTS delivery_runs (
  id TEXT PRIMARY KEY,
  sales_id TEXT NOT NULL REFERENCES sales(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver TEXT,
  route TEXT,
  status TEXT NOT NULL DEFAULT 'DISPATCHED' CHECK (status IN ('PENDING','READY','DISPATCHED','ACTIVE','DELIVERED','CANCELLED','RETURNED')),
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_by TEXT,
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
  -- INVOICE prints (Section 9: "Print invoice" as its own action, distinct
  -- from the till receipt) carry none of the reprint-approval restriction
  -- below — a customer asking for another copy of their invoice isn't the
  -- till-fraud pattern the receipt reprint gate exists for. Counted
  -- separately from RECEIPT prints so an invoice reprint never trips that gate.
  document_type TEXT NOT NULL DEFAULT 'RECEIPT' CHECK (document_type IN ('RECEIPT','INVOICE')),
  printed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_receipt_prints_sales ON pos_receipt_prints(sales_id);

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

-- ===================== Till reconciliation (Module 23) =====================
-- One row per counter per business day. cash_sales/cash_received/transfers
-- are read live from sales/receipts for that date at close time (never
-- editable), payments/adjustments are the till operator's own manual entries
-- (cash paid out of the drawer, float top-ups/corrections) — see
-- services/tillClose.ts for the expected_closing formula. reviewed_by is a
-- distinct second signature, set later by reviewTill(), same "confirmation,
-- not the same person" shape as marketerStock.verifyAssignment.
CREATE TABLE IF NOT EXISTS till_closes (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  till TEXT NOT NULL DEFAULT 'Retail Till',
  opening_balance REAL NOT NULL DEFAULT 0,
  cash_sales REAL NOT NULL DEFAULT 0,
  cash_received REAL NOT NULL DEFAULT 0,
  payments REAL NOT NULL DEFAULT 0,
  transfers REAL NOT NULL DEFAULT 0,
  adjustments REAL NOT NULL DEFAULT 0,
  expected_closing REAL NOT NULL DEFAULT 0,
  actual_closing REAL NOT NULL DEFAULT 0,
  difference REAL NOT NULL DEFAULT 0,
  closed_by TEXT,
  reviewed_by TEXT,
  status TEXT NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('CLOSED','REVIEWED')),
  closed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  UNIQUE (business_date, till)
);
CREATE INDEX IF NOT EXISTS idx_till_closes_date ON till_closes(business_date);

-- ===================== Payroll (Module 26/27/28/29) =====================
-- Bank details live on the employee, not per payroll run — a stable
-- employee-level attribute, exported on the payslip (Section 29) but never
-- duplicated per run. Added via ensureColumn in migrate.ts (existing
-- installs already have the employees table, so this can't be a plain CREATE TABLE).
--
-- Section 26 worked example: "Staff receives loan... Payroll automatically
-- applies the appropriate deduction." One row per loan; amount_repaid only
-- increments once a payroll run carrying a LOAN deduction against this loan
-- is actually disbursed (services/payroll.ts) — never at prepare/review/
-- approve time, so a rejected run never falsely credits a repayment.
-- outstanding is always principal - amount_repaid, never stored.
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  principal REAL NOT NULL,
  date_issued TEXT NOT NULL DEFAULT (datetime('now')),
  repayment_schedule TEXT,
  monthly_repayment REAL NOT NULL DEFAULT 0,
  amount_repaid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAID_OFF', 'WRITTEN_OFF')),
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loans_employee ON loans(employee_id);

-- Compulsory Savings: one row per employee, the "current state" (rate,
-- balance, contribution totals). current_balance is zeroed by
-- payroll.liquidateSavings() at the configurable annual liquidation date;
-- total_contribution never decreases — the lifetime figure, kept even
-- across a liquidation, per "do not delete previous savings history."
CREATE TABLE IF NOT EXISTS employee_savings (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  monthly_contribution REAL NOT NULL DEFAULT 0,
  start_date TEXT,
  current_balance REAL NOT NULL DEFAULT 0,
  total_contribution REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

-- The append-only ledger behind employee_savings' running figures —
-- CONTRIBUTION posted on payroll disbursement, LIQUIDATION posted by
-- liquidateSavings(). This table is the permanent historical record;
-- employee_savings above is only ever a derived-looking cache of it (kept
-- as real columns rather than computed live, same convention as
-- production_batches.rejected_quantity, since the two are always written
-- together in the same transaction).
CREATE TABLE IF NOT EXISTS employee_savings_transactions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL CHECK (type IN ('CONTRIBUTION', 'LIQUIDATION')),
  amount REAL NOT NULL,
  payroll_run_id TEXT REFERENCES payroll_runs(id),
  authorized_by TEXT,
  paid_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_savings_txn_employee ON employee_savings_transactions(employee_id);

-- One row per deduction line applied to a payroll run — Loan/Salary Advance/
-- Savings/Compulsory Savings/Tax/Penalties/Other Approved Deductions, each
-- independently recorded rather than folded into a single number.
CREATE TABLE IF NOT EXISTS payroll_deductions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  type TEXT NOT NULL CHECK (type IN ('LOAN', 'SALARY_ADVANCE', 'SAVINGS', 'COMPULSORY_SAVINGS', 'TAX', 'PENALTY', 'OTHER')),
  description TEXT,
  amount REAL NOT NULL,
  reference_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_payroll_deductions_run ON payroll_deductions(payroll_run_id);

-- Module 28: HR/Accounts prepares (PENDING_REVIEW) -> Payroll review
-- (AWAITING_APPROVAL) -> Chairman approval (APPROVED, locked=1, an
-- approval_signature generated per the configured policy) -> Accounts
-- disbursement (DISBURSED, the one point loan/savings balances actually
-- move and the ledger posts). REJECTED sends it back for a revision.
-- locked blocks direct edits once APPROVED or DISBURSED — a correction is a
-- brand-new row with revision_of pointing back, never an edit in place, so
-- "approved payroll should not be silently modified" holds structurally,
-- not just by convention.
CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES employees(id),
  staff_name TEXT,
  period TEXT NOT NULL,
  gross REAL NOT NULL,
  total_deductions REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'DISBURSED')),
  prepared_by TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  approval_signature TEXT,
  disbursed_by TEXT,
  disbursed_at TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  revision_of TEXT REFERENCES payroll_runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payroll_staff ON payroll_runs(staff_id);

-- ===================== Asset & Maintenance (Module 30/31) =====================
-- category is one of the configurable Section 30 groups (Vehicles/
-- Generators/Machines/Equipment/Building/Office Equipment/Other Fixed
-- Assets) — company vehicles keep their own dedicated vehicles table
-- (fleet dispatch already depends on it), so a "Vehicles" category asset
-- row here is only ever used for a vehicle-adjacent fixed asset that isn't
-- itself a registered vehicle, avoiding duplicating the same object in two
-- tables. New columns added via ensureColumn in migrate.ts.

-- Section 31: individual maintenance expenditure, one row per job — ref_type/
-- ref_id is the same polymorphic pointer convention quality_control uses
-- (ASSET -> assets(id), VEHICLE -> vehicles(id)), validated in the service
-- layer since SQLite can't express a conditional FK. Posts a real payment
-- (services/finance.ts) so maintenance spend shows up in the ledger, not
-- just this table.
CREATE TABLE IF NOT EXISTS maintenance_records (
  id TEXT PRIMARY KEY,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('ASSET', 'VEHICLE')),
  ref_id TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  vendor TEXT,
  amount REAL NOT NULL DEFAULT 0,
  service_date TEXT NOT NULL DEFAULT (datetime('now')),
  invoice_reference TEXT,
  performed_by TEXT,
  approved_by TEXT,
  next_due_date TEXT,
  remarks TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_ref ON maintenance_records(ref_type, ref_id);

-- ===================== Company Vehicles & Fuel (Module 32/33/34/35) =====================
-- plate_number/vehicle_type/category/acquisition_date added via
-- ensureColumn in migrate.ts (existing installs already have the vehicles table).
CREATE TABLE IF NOT EXISTS fuel_records (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver TEXT,
  department TEXT,
  fuel_date TEXT NOT NULL DEFAULT (datetime('now')),
  fuel_type TEXT,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL,
  total_cost REAL NOT NULL,
  odometer REAL,
  vendor TEXT,
  receipt_reference TEXT,
  remarks TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_vehicle ON fuel_records(vehicle_id);

-- Section 34: which document_type values are even offered depends on the
-- vehicle's category (Commercial vs Private) — see
-- services/vehicleDocuments.ts's documentTypesFor(), configured via
-- Settings, not hard-coded here. expiry_date drives Section 35's
-- notifications; "expired" is always computed live against today, never
-- stored, so it can't drift.
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  document_type TEXT NOT NULL,
  document_number TEXT,
  issue_date TEXT,
  expiry_date TEXT,
  notes TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle ON vehicle_documents(vehicle_id);
`;
