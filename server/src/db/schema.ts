// Kept as a TS template literal (not a standalone .sql file) so it survives
// esbuild's single-file bundle unchanged — a separate asset file wouldn't be
// copied alongside dist/index.js.
//
// This is a direct, mechanical port of the app's Postgres schema (previously
// node:sqlite). It intentionally does NOT reuse the two earlier, abandoned
// Postgres redesigns in this repo (database/postgres/, supabase/migrations/) —
// both were found to be stale/incomplete against this file when the migration
// was done (missing ~30 tables the app actively uses, frozen at pre-upgrade
// table shapes, and — for supabase/migrations specifically — built around
// Supabase Auth/RLS, a different auth model from this app's own bcrypt
// password_hash scheme). Every table/column here matches the final shape the
// old server/src/db/migrate.ts converged SQLite installs to (ensureColumn
// additions and guarded-rebuild upgrades folded straight into the base
// CREATE TABLE, since a fresh Postgres install needs none of SQLite's
// ALTER-TABLE workarounds).
//
// Foreign keys are added in a second pass (FOREIGN_KEYS_SQL below) after every
// table exists, rather than inline, so table order can stay close to the
// original SQLite file without solving a 74-table topological sort by hand —
// unlike SQLite, Postgres requires a REFERENCES target to already exist at
// CREATE TABLE time.
//
// Timestamp columns stay TEXT (not native TIMESTAMPTZ) with a default that
// reproduces SQLite's datetime('now') string shape exactly
// ('YYYY-MM-DD HH:MM:SS', UTC) — the app does string slicing/comparison on
// these columns throughout the service layer, and switching to a native type
// would silently change what every one of those call sites receives.
export const SCHEMA_SQL = `
-- Elim ERP schema. Every business action lands here as a row; nothing is
-- ever overwritten in place except a handful of explicit status fields.

-- ===================== Masters =====================
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('RAW_MATERIAL','PACKAGING','CONSUMABLE','FINISHED_GOOD')),
  uom TEXT NOT NULL DEFAULT 'unit',
  reorder_point DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Manufacturer/grammage variants (e.g. "PET Preform 16g – Prima" vs "...– Century")
  -- are separate items rows, each with their own stock — these two columns are what
  -- distinguish a variant from a plain material and drive the bags→pieces conversion
  -- at PO/GRN entry time. NULL for every item that isn't bought this way.
  manufacturer_id TEXT,
  pieces_per_bag DOUBLE PRECISION,
  is_returnable_asset INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
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
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
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
  bank_name TEXT,
  bank_account_number TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_active TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  description TEXT,
  members INTEGER NOT NULL DEFAULT 0,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  driver TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  odometer TEXT,
  plate_number TEXT,
  vehicle_type TEXT,
  category TEXT CHECK (category IN ('COMMERCIAL', 'PRIVATE')),
  acquisition_date TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- category/serial_number/assigned_department/service_interval_days/notes: the
-- configurable Section 30 groups (Vehicles/Generators/Machines/Equipment/
-- Building/Office Equipment/Other Fixed Assets) — company vehicles keep their
-- own dedicated vehicles table (fleet dispatch already depends on it), so a
-- "Vehicles" category asset row here is only ever used for a vehicle-adjacent
-- fixed asset that isn't itself a registered vehicle.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  equipment TEXT NOT NULL,
  location TEXT,
  category TEXT,
  serial_number TEXT,
  assigned_department TEXT,
  service_interval_days INTEGER,
  notes TEXT,
  last_service TEXT,
  next_due TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  description TEXT,
  value TEXT,
  updated_by TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS water_treatment_runs (
  id TEXT PRIMARY KEY,
  source TEXT,
  stage TEXT,
  volume_l DOUBLE PRECISION,
  operator TEXT,
  status TEXT NOT NULL DEFAULT 'PASS' CHECK (status IN ('PASS','IN_PROGRESS','FAIL')),
  tested_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ===================== Procurement =====================
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  requested_by TEXT,
  -- Nullable: requested_by above stays free text (a PO can be raised on
  -- someone else's behalf), but when the raiser is a real logged-in user this
  -- is how the approval route can tell "the same person is trying to approve
  -- what they just requested" and block it.
  requested_by_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','REJECTED','RECEIVED')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  po_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);

-- ===================== Receiving =====================
-- received_by is the Receiving Officer; inspection_officer (below) is filled
-- in separately once inspectGoodsReceived() runs.
CREATE TABLE IF NOT EXISTS goods_received (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL,
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
  received_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_grn_po ON goods_received(po_id);

CREATE TABLE IF NOT EXISTS goods_received_items (
  id SERIAL PRIMARY KEY,
  grn_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  expected_quantity DOUBLE PRECISION,
  quantity DOUBLE PRECISION NOT NULL,
  accepted_quantity DOUBLE PRECISION,
  rejected_quantity DOUBLE PRECISION,
  short_quantity DOUBLE PRECISION,
  over_quantity DOUBLE PRECISION,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_grn_items_grn ON goods_received_items(grn_id);

CREATE TABLE IF NOT EXISTS supplier_returns (
  id TEXT PRIMARY KEY,
  grn_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_grn ON supplier_returns(grn_id);

CREATE TABLE IF NOT EXISTS supplier_return_items (
  id SERIAL PRIMARY KEY,
  return_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_return ON supplier_return_items(return_id);

-- ===================== Quality control =====================
-- ref_type/ref_id is a polymorphic pointer at either goods_received or
-- production_batches, validated in the service layer, not by a real FK.
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
  tested_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_qc_ref ON quality_control(ref_type, ref_id);

CREATE TABLE IF NOT EXISTS quality_test_parameters (
  id SERIAL PRIMARY KEY,
  qc_id TEXT NOT NULL,
  parameter_name TEXT NOT NULL,
  measured_value TEXT NOT NULL,
  unit TEXT,
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  expected_value TEXT,
  result TEXT NOT NULL CHECK (result IN ('PASS','FAIL'))
);
CREATE INDEX IF NOT EXISTS idx_qc_params_qc ON quality_test_parameters(qc_id);

-- ===================== Inventory =====================
-- Append-only. The on-hand balance is never stored — it's always derived.
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  quantity DOUBLE PRECISION NOT NULL,
  unit_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL CHECK (source_type IN ('PURCHASE','PRODUCTION','SALES','MATERIAL_ISSUE','ADJUSTMENT')),
  source_id TEXT,
  note TEXT,
  actor TEXT,
  from_location TEXT,
  to_location TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_inv_item ON inventory_transactions(item_id);

CREATE OR REPLACE VIEW inventory_balances AS
SELECT item_id, SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) AS on_hand
FROM inventory_transactions
GROUP BY item_id;

-- ===================== Warehouse =====================
CREATE TABLE IF NOT EXISTS warehouse_requisitions (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
  expected_delivery TEXT,
  priority TEXT NOT NULL DEFAULT 'Medium',
  reason TEXT,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','ISSUED','REJECTED')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ===================== Production: material requests =====================
CREATE TABLE IF NOT EXISTS material_requests (
  id TEXT PRIMARY KEY,
  requested_by TEXT,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ISSUED','REJECTED')),
  needed_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS material_request_items (
  id SERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mri_request ON material_request_items(request_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  request_id TEXT,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  from_location TEXT,
  to_location TEXT,
  moved_by TEXT,
  moved_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ===================== Manufacturing =====================
-- Section 24: rejected/wasted are only ever set together, once, by
-- production.closeBatch() — closed_at IS NOT NULL is what "Closed Production
-- Batches" means. Not Yet Packaged is never stored — always
-- units_actual - packaged - rejected_quantity - wasted_quantity, live.
CREATE TABLE IF NOT EXISTS production_batches (
  id TEXT PRIMARY KEY,
  product_item_id TEXT NOT NULL,
  line TEXT,
  shift TEXT,
  operator TEXT,
  units_target DOUBLE PRECISION,
  units_actual DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  water_treatment_run_id TEXT,
  rejected_quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
  wasted_quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
  closed_by TEXT,
  closed_at TEXT,
  started_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  completed_at TEXT
);

-- Bill of materials: for one unit of product_item_id produced, qty_per_unit of
-- component_item_id is consumed.
CREATE TABLE IF NOT EXISTS bom_components (
  id SERIAL PRIMARY KEY,
  product_item_id TEXT NOT NULL,
  component_item_id TEXT NOT NULL,
  qty_per_unit DOUBLE PRECISION NOT NULL DEFAULT 1,
  UNIQUE (product_item_id, component_item_id)
);

-- ===================== Packaging =====================
CREATE TABLE IF NOT EXISTS finished_goods (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  packaged_by TEXT,
  packaged_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- Empty dispenser bottles pulled from the warehouse for a production run.
CREATE TABLE IF NOT EXISTS empty_bottle_runs (
  id TEXT PRIMARY KEY,
  quantity_issued DOUBLE PRECISION NOT NULL,
  issued_by TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RECONCILED')),
  damaged_quantity DOUBLE PRECISION,
  leaking_quantity DOUBLE PRECISION,
  finished_quantity DOUBLE PRECISION,
  returned_quantity DOUBLE PRECISION,
  actor TEXT,
  started_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reconciled_at TEXT
);

CREATE TABLE IF NOT EXISTS empty_bottle_condition_events (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('DAMAGED','LEAKING','TRIAGED_TO_REPAIRABLE','TRIAGED_TO_SCRAPPED','REPAIRED_TO_GOOD')),
  quantity DOUBLE PRECISION NOT NULL,
  source_state TEXT,
  run_id TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_empty_bottle_condition_item ON empty_bottle_condition_events(item_id);

-- ===================== Sales =====================
-- Sales and Point-of-Sale are the same table distinguished by channel.
-- customer_id is nullable: a Retail POS sale needs no customer profile.
-- AWAITING_APPROVAL: a Distributor buying on credit sits here until
-- services/sales.ts's approveCreditSale/rejectCreditSale resolves it.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  channel TEXT NOT NULL DEFAULT 'INVOICE' CHECK (channel IN ('INVOICE','POS')),
  rep TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AWAITING_APPROVAL','PROCESSING','DELIVERED','CANCELLED','PAID')),
  payment_terms TEXT NOT NULL DEFAULT 'CREDIT',
  approved_by TEXT,
  approved_at TEXT,
  branch_id TEXT,
  manual_invoice_number TEXT,
  total_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS sales_items (
  id SERIAL PRIMARY KEY,
  sales_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL,
  line_total DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_items_sales ON sales_items(sales_id);

CREATE TABLE IF NOT EXISTS sales_payments (
  id SERIAL PRIMARY KEY,
  sales_id TEXT NOT NULL,
  method TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_sales_payments_sales ON sales_payments(sales_id);

CREATE TABLE IF NOT EXISTS distributor_branches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  location TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_distributor_branches_company ON distributor_branches(company_id);

CREATE TABLE IF NOT EXISTS sales_returns (
  id TEXT PRIMARY KEY,
  sales_id TEXT NOT NULL,
  customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_INSPECTION' CHECK (status IN ('PENDING_INSPECTION','PARTIALLY_ACCEPTED','ACCEPTED','REJECTED')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  inspected_by TEXT,
  inspected_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_returns_sales ON sales_returns(sales_id);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id SERIAL PRIMARY KEY,
  return_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity_returned DOUBLE PRECISION NOT NULL,
  quantity_accepted DOUBLE PRECISION,
  quantity_rejected DOUBLE PRECISION,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_return_items_return ON sales_return_items(return_id);

-- ===================== Marketer stock accountability =====================
CREATE TABLE IF NOT EXISTS marketer_stock_transactions (
  id SERIAL PRIMARY KEY,
  marketer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  quantity DOUBLE PRECISION NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL CHECK (source_type IN ('ISSUE','RETURN','SOLD')),
  source_id TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_marketer_stock_txn_marketer ON marketer_stock_transactions(marketer_id, item_id);

CREATE TABLE IF NOT EXISTS marketer_stock_issues (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL,
  issued_by TEXT,
  status TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','VERIFIED')),
  verified_by TEXT,
  verified_at TEXT,
  issued_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE IF NOT EXISTS marketer_stock_issue_items (
  id SERIAL PRIMARY KEY,
  issue_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS marketer_returns (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
  verified_by TEXT,
  verified_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE IF NOT EXISTS marketer_return_items (
  id SERIAL PRIMARY KEY,
  return_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  verified_quantity DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS marketer_sales (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL,
  cash_received DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE IF NOT EXISTS marketer_sale_items (
  id SERIAL PRIMARY KEY,
  sale_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- ===================== Marketer customer credit management =====================
CREATE TABLE IF NOT EXISTS marketer_customers (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  location TEXT,
  route TEXT,
  credit_limit DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_marketer_customers_marketer ON marketer_customers(marketer_id);

CREATE TABLE IF NOT EXISTS marketer_customer_sales (
  id TEXT PRIMARY KEY,
  marketer_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  cash_received DOUBLE PRECISION NOT NULL DEFAULT 0,
  due_date TEXT,
  collector TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_marketer_customer_sales_customer ON marketer_customer_sales(customer_id);
CREATE TABLE IF NOT EXISTS marketer_customer_sale_items (
  id SERIAL PRIMARY KEY,
  sale_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS marketer_customer_sale_remarks (
  id SERIAL PRIMARY KEY,
  sale_id TEXT NOT NULL,
  remark TEXT NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_marketer_customer_sale_remarks_sale ON marketer_customer_sale_remarks(sale_id);

CREATE TABLE IF NOT EXISTS marketer_customer_payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  method TEXT,
  reference_id TEXT,
  actor TEXT,
  paid_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS marketer_customer_ledger (
  id SERIAL PRIMARY KEY,
  customer_id TEXT NOT NULL,
  entry_date TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  debit DOUBLE PRECISION NOT NULL DEFAULT 0,
  credit DOUBLE PRECISION NOT NULL DEFAULT 0,
  description TEXT,
  reference_id TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_marketer_customer_ledger_customer ON marketer_customer_ledger(customer_id);

CREATE TABLE IF NOT EXISTS bottle_custody_events (
  id SERIAL PRIMARY KEY,
  marketer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('EMPTY_RETURNED','SOLD_WITH_BOTTLE')),
  quantity DOUBLE PRECISION NOT NULL,
  customer_name TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_bottle_custody_marketer ON bottle_custody_events(marketer_id, item_id);

-- ===================== Retail stock =====================
CREATE TABLE IF NOT EXISTS retail_stock_transactions (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  quantity DOUBLE PRECISION NOT NULL,
  unit_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL CHECK (source_type IN ('INTAKE','SOLD','ADJUSTMENT')),
  source_id TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_retail_stock_txn_item ON retail_stock_transactions(item_id);

CREATE TABLE IF NOT EXISTS retail_intakes (
  id TEXT PRIMARY KEY,
  issued_by TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE IF NOT EXISTS retail_intake_items (
  id SERIAL PRIMARY KEY,
  intake_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  unit_cost DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_retail_intake_items_intake ON retail_intake_items(intake_id);

-- ===================== Retail return / exchange (Module 21) =====================
CREATE TABLE IF NOT EXISTS retail_exchanges (
  id TEXT PRIMARY KEY,
  original_sales_id TEXT NOT NULL,
  new_sales_id TEXT,
  customer_id TEXT,
  reason TEXT NOT NULL,
  staff TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_retail_exchanges_original ON retail_exchanges(original_sales_id);

CREATE TABLE IF NOT EXISTS retail_exchange_items (
  id SERIAL PRIMARY KEY,
  exchange_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity_returned DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit_price DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_retail_exchange_items_exchange ON retail_exchange_items(exchange_id);

-- ===================== Fleet & delivery =====================
CREATE TABLE IF NOT EXISTS delivery_runs (
  id TEXT PRIMARY KEY,
  sales_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  driver TEXT,
  route TEXT,
  status TEXT NOT NULL DEFAULT 'DISPATCHED' CHECK (status IN ('PENDING','READY','DISPATCHED','ACTIVE','DELIVERED','CANCELLED','RETURNED')),
  dispatched_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  delivered_by TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delivery_sales ON delivery_runs(sales_id);

-- ===================== Finance =====================
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  account TEXT NOT NULL,
  debit DOUBLE PRECISION NOT NULL DEFAULT 0,
  credit DOUBLE PRECISION NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id TEXT,
  description TEXT,
  supplier_id TEXT,
  customer_id TEXT,
  branch_id TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  paid_to TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  method TEXT,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'CLEARED',
  paid_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  supplier_id TEXT
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  received_from TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  method TEXT,
  reference_type TEXT,
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'CLEARED',
  received_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS pos_receipt_prints (
  id SERIAL PRIMARY KEY,
  sales_id TEXT NOT NULL,
  is_reprint INTEGER NOT NULL DEFAULT 0,
  printed_by TEXT,
  approved_by TEXT,
  reason TEXT,
  document_type TEXT NOT NULL DEFAULT 'RECEIPT' CHECK (document_type IN ('RECEIPT','INVOICE')),
  printed_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_pos_receipt_prints_sales ON pos_receipt_prints(sales_id);

-- ===================== Reports =====================
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','RUNNING','FAILED')),
  last_run TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ===================== Activity log =====================
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
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
  at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log(at);

-- ===================== Access control =====================
CREATE TABLE IF NOT EXISTS user_page_access (
  user_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  PRIMARY KEY (user_id, page_key)
);

-- ===================== Deletion requests =====================
CREATE TABLE IF NOT EXISTS deletion_requests (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_label TEXT,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_deletion_status ON deletion_requests(status);
CREATE INDEX IF NOT EXISTS idx_deletion_entity ON deletion_requests(entity_type, entity_id);

-- ===================== Reversals (Module 17) =====================
CREATE TABLE IF NOT EXISTS reversals (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reversed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reversed_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_reversals_entity ON reversals(entity_type, entity_id);

-- ===================== Day close =====================
CREATE TABLE IF NOT EXISTS day_closes (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('CLOSED')),
  checked_by TEXT,
  actor TEXT,
  closed_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ===================== Till reconciliation (Module 23) =====================
CREATE TABLE IF NOT EXISTS till_closes (
  id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  till TEXT NOT NULL DEFAULT 'Retail Till',
  opening_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  cash_sales DOUBLE PRECISION NOT NULL DEFAULT 0,
  cash_received DOUBLE PRECISION NOT NULL DEFAULT 0,
  payments DOUBLE PRECISION NOT NULL DEFAULT 0,
  transfers DOUBLE PRECISION NOT NULL DEFAULT 0,
  adjustments DOUBLE PRECISION NOT NULL DEFAULT 0,
  expected_closing DOUBLE PRECISION NOT NULL DEFAULT 0,
  actual_closing DOUBLE PRECISION NOT NULL DEFAULT 0,
  difference DOUBLE PRECISION NOT NULL DEFAULT 0,
  closed_by TEXT,
  reviewed_by TEXT,
  status TEXT NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('CLOSED','REVIEWED')),
  closed_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reviewed_at TEXT,
  UNIQUE (business_date, till)
);
CREATE INDEX IF NOT EXISTS idx_till_closes_date ON till_closes(business_date);

-- ===================== Payroll (Module 26/27/28/29) =====================
-- Module 28: HR/Accounts prepares (PENDING_REVIEW) -> Payroll review
-- (AWAITING_APPROVAL) -> Chairman approval (APPROVED, locked=1) -> Accounts
-- disbursement (DISBURSED). REJECTED sends it back for a revision. locked
-- blocks direct edits once APPROVED or DISBURSED — a correction is a
-- brand-new row with revision_of pointing back, never an edit in place.
CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  staff_name TEXT,
  period TEXT NOT NULL,
  gross DOUBLE PRECISION NOT NULL,
  total_deductions DOUBLE PRECISION NOT NULL DEFAULT 0,
  net DOUBLE PRECISION NOT NULL,
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
  revision_of TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_payroll_staff ON payroll_runs(staff_id);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  principal DOUBLE PRECISION NOT NULL,
  date_issued TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  repayment_schedule TEXT,
  monthly_repayment DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount_repaid DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAID_OFF', 'WRITTEN_OFF')),
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_loans_employee ON loans(employee_id);

CREATE TABLE IF NOT EXISTS employee_savings (
  employee_id TEXT PRIMARY KEY,
  monthly_contribution DOUBLE PRECISION NOT NULL DEFAULT 0,
  start_date TEXT,
  current_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_contribution DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE TABLE IF NOT EXISTS employee_savings_transactions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('CONTRIBUTION', 'LIQUIDATION')),
  amount DOUBLE PRECISION NOT NULL,
  payroll_run_id TEXT,
  authorized_by TEXT,
  paid_date TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_savings_txn_employee ON employee_savings_transactions(employee_id);

CREATE TABLE IF NOT EXISTS payroll_deductions (
  id SERIAL PRIMARY KEY,
  payroll_run_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('LOAN', 'SALARY_ADVANCE', 'SAVINGS', 'COMPULSORY_SAVINGS', 'TAX', 'PENALTY', 'OTHER')),
  description TEXT,
  amount DOUBLE PRECISION NOT NULL,
  reference_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_payroll_deductions_run ON payroll_deductions(payroll_run_id);

-- ===================== Asset & Maintenance (Module 30/31) =====================
-- Section 31: individual maintenance expenditure, one row per job — ref_type/
-- ref_id is the same polymorphic pointer convention quality_control uses
-- (ASSET -> assets(id), VEHICLE -> vehicles(id)), validated in the service
-- layer, not by a real FK.
CREATE TABLE IF NOT EXISTS maintenance_records (
  id TEXT PRIMARY KEY,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('ASSET', 'VEHICLE')),
  ref_id TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  vendor TEXT,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  service_date TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  invoice_reference TEXT,
  performed_by TEXT,
  approved_by TEXT,
  next_due_date TEXT,
  remarks TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_maintenance_ref ON maintenance_records(ref_type, ref_id);

-- ===================== Company Vehicles & Fuel (Module 32/33/34/35) =====================
CREATE TABLE IF NOT EXISTS fuel_records (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  driver TEXT,
  department TEXT,
  fuel_date TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  fuel_type TEXT,
  quantity DOUBLE PRECISION NOT NULL,
  unit_cost DOUBLE PRECISION NOT NULL,
  total_cost DOUBLE PRECISION NOT NULL,
  odometer DOUBLE PRECISION,
  vendor TEXT,
  receipt_reference TEXT,
  remarks TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_fuel_vehicle ON fuel_records(vehicle_id);

-- Section 34: which document_type values are even offered depends on the
-- vehicle's category — see services/vehicleDocuments.ts's documentTypesFor(),
-- configured via Settings, not hard-coded here.
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  document_number TEXT,
  issue_date TEXT,
  expiry_date TEXT,
  notes TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle ON vehicle_documents(vehicle_id);
`;

// Second pass: foreign keys, added only after every table above exists —
// unlike SQLite, Postgres requires a REFERENCES target to already exist at
// constraint-creation time, so these can't be inline without solving a
// 74-table topological sort of the CREATE TABLE order above by hand.
// One statement per REFERENCES clause in the original SQLite schema; each
// wrapped so re-running this file (a fresh install re-applying the whole
// script) doesn't fail on a constraint that already exists.
const FK_SPECS: [table: string, column: string, refTable: string][] = [
  ['items', 'manufacturer_id', 'suppliers'],
  ['purchase_orders', 'supplier_id', 'suppliers'],
  ['purchase_order_items', 'po_id', 'purchase_orders'],
  ['purchase_order_items', 'item_id', 'items'],
  ['goods_received', 'po_id', 'purchase_orders'],
  ['goods_received_items', 'grn_id', 'goods_received'],
  ['goods_received_items', 'item_id', 'items'],
  ['supplier_returns', 'grn_id', 'goods_received'],
  ['supplier_returns', 'po_id', 'purchase_orders'],
  ['supplier_returns', 'supplier_id', 'suppliers'],
  ['supplier_return_items', 'return_id', 'supplier_returns'],
  ['supplier_return_items', 'item_id', 'items'],
  ['quality_test_parameters', 'qc_id', 'quality_control'],
  ['inventory_transactions', 'item_id', 'items'],
  ['material_request_items', 'request_id', 'material_requests'],
  ['material_request_items', 'item_id', 'items'],
  ['stock_movements', 'request_id', 'material_requests'],
  ['stock_movements', 'item_id', 'items'],
  ['production_batches', 'product_item_id', 'items'],
  ['production_batches', 'water_treatment_run_id', 'water_treatment_runs'],
  ['bom_components', 'product_item_id', 'items'],
  ['bom_components', 'component_item_id', 'items'],
  ['finished_goods', 'batch_id', 'production_batches'],
  ['finished_goods', 'item_id', 'items'],
  ['empty_bottle_condition_events', 'item_id', 'items'],
  ['empty_bottle_condition_events', 'run_id', 'empty_bottle_runs'],
  ['sales', 'customer_id', 'customers'],
  ['sales_items', 'sales_id', 'sales'],
  ['sales_items', 'item_id', 'items'],
  ['sales_payments', 'sales_id', 'sales'],
  ['distributor_branches', 'company_id', 'customers'],
  ['sales_returns', 'sales_id', 'sales'],
  ['sales_returns', 'customer_id', 'customers'],
  ['sales_return_items', 'return_id', 'sales_returns'],
  ['sales_return_items', 'item_id', 'items'],
  ['marketer_stock_transactions', 'marketer_id', 'customers'],
  ['marketer_stock_transactions', 'item_id', 'items'],
  ['marketer_stock_issues', 'marketer_id', 'customers'],
  ['marketer_stock_issue_items', 'issue_id', 'marketer_stock_issues'],
  ['marketer_stock_issue_items', 'item_id', 'items'],
  ['marketer_returns', 'marketer_id', 'customers'],
  ['marketer_return_items', 'return_id', 'marketer_returns'],
  ['marketer_return_items', 'item_id', 'items'],
  ['marketer_sales', 'marketer_id', 'customers'],
  ['marketer_sale_items', 'sale_id', 'marketer_sales'],
  ['marketer_sale_items', 'item_id', 'items'],
  ['marketer_customers', 'marketer_id', 'customers'],
  ['marketer_customer_sales', 'marketer_id', 'customers'],
  ['marketer_customer_sales', 'customer_id', 'marketer_customers'],
  ['marketer_customer_sale_items', 'sale_id', 'marketer_customer_sales'],
  ['marketer_customer_sale_items', 'item_id', 'items'],
  ['marketer_customer_sale_remarks', 'sale_id', 'marketer_customer_sales'],
  ['marketer_customer_payments', 'customer_id', 'marketer_customers'],
  ['marketer_customer_ledger', 'customer_id', 'marketer_customers'],
  ['bottle_custody_events', 'marketer_id', 'customers'],
  ['bottle_custody_events', 'item_id', 'items'],
  ['retail_stock_transactions', 'item_id', 'items'],
  ['retail_intake_items', 'intake_id', 'retail_intakes'],
  ['retail_intake_items', 'item_id', 'items'],
  ['retail_exchanges', 'original_sales_id', 'sales'],
  ['retail_exchanges', 'new_sales_id', 'sales'],
  ['retail_exchanges', 'customer_id', 'customers'],
  ['retail_exchange_items', 'exchange_id', 'retail_exchanges'],
  ['retail_exchange_items', 'item_id', 'items'],
  ['delivery_runs', 'sales_id', 'sales'],
  ['delivery_runs', 'vehicle_id', 'vehicles'],
  ['ledger', 'supplier_id', 'suppliers'],
  ['ledger', 'customer_id', 'customers'],
  ['payments', 'supplier_id', 'suppliers'],
  ['pos_receipt_prints', 'sales_id', 'sales'],
  ['user_page_access', 'user_id', 'users'],
  ['payroll_runs', 'staff_id', 'employees'],
  ['payroll_runs', 'revision_of', 'payroll_runs'],
  ['loans', 'employee_id', 'employees'],
  ['employee_savings', 'employee_id', 'employees'],
  ['employee_savings_transactions', 'employee_id', 'employees'],
  ['employee_savings_transactions', 'payroll_run_id', 'payroll_runs'],
  ['payroll_deductions', 'payroll_run_id', 'payroll_runs'],
  ['fuel_records', 'vehicle_id', 'vehicles'],
  ['vehicle_documents', 'vehicle_id', 'vehicles'],
];

export const FOREIGN_KEYS_SQL = FK_SPECS
  .map(([table, column, refTable]) => `
DO $$ BEGIN
  ALTER TABLE ${table} ADD FOREIGN KEY (${column}) REFERENCES ${refTable}(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`)
  .join('\n');

// Reference-data rows every install needs (configurable option lists read via
// services/*.ts's settings-lookup helpers) — the same seed the old
// migrate.ts inserted idempotently per-row. ON CONFLICT DO NOTHING makes
// re-running this safe, same as the old "WHERE NOT EXISTS" guards.
export const REFERENCE_DATA_SQL = `
INSERT INTO settings (id, description, value, updated_by, status) VALUES
  ('Marketer commission rate', 'Percentage applied to a marketer''s commissionable sales (Cash + Recovered Credit) — see Marketer Performance', '5%', 'System Administrator', 'ACTIVE'),
  ('AR aging buckets (days)', 'Comma-separated day breakpoints for customer/supplier aging: Current, then each bucket upper bound, the rest falling into the final 90+ bucket', '0,30,40,50,60,90', 'System Administrator', 'ACTIVE'),
  ('Item categories', 'Comma-separated categories offered when creating an item or material variant', 'Chemicals,Labels,Bottle Caps,Raw Materials,Packaging,Other', 'System Administrator', 'ACTIVE'),
  ('QC parameters', 'Comma-separated laboratory parameters offered when recording a quality test', 'pH,Turbidity,Odour,Taste,Appearance/Clearness,Total Dissolved Solids,Conductivity,Chlorine Residual', 'System Administrator', 'ACTIVE'),
  ('Employee status options', 'Comma-separated employee status values offered on staff records', 'Active,Inactive,On Leave,Resigned,Terminated,Disengaged,Absconded', 'System Administrator', 'ACTIVE'),
  ('Compulsory savings liquidation date', 'Annual liquidation date for employee compulsory savings, as MM-DD', '01-01', 'System Administrator', 'ACTIVE'),
  ('Payroll approval signature format', 'Template for the digital approval signature payroll.approveRun() generates — {approver} and {date} are substituted', 'Digitally approved by {approver} on {date} on behalf of the Chairman', 'System Administrator', 'ACTIVE'),
  ('Asset categories', 'Comma-separated categories offered when registering an asset', 'Vehicles,Generators,Machines,Equipment,Building,Office Equipment,Other Fixed Assets', 'System Administrator', 'ACTIVE'),
  ('Maintenance categories', 'Comma-separated categories offered when recording a maintenance expense', 'Vehicle Fuel,Diesel,Engine Oil,Filters,Tyres,Tyre Maintenance,Brake,Spare Parts,Machine Spare Parts,Generator Maintenance,Machine Maintenance,Building Maintenance,Photocopier Maintenance,Printer Maintenance,Utilities,Electricity,Other Maintenance', 'System Administrator', 'ACTIVE'),
  ('Vehicle documents - Commercial', 'Comma-separated document types required for Commercial vehicles', 'AMAC documentation,Local Government documentation,Registration,Insurance,Roadworthiness,Speed Limiting Device', 'System Administrator', 'ACTIVE'),
  ('Vehicle documents - Private', 'Comma-separated document types required for Private vehicles', 'Registration,Insurance,Roadworthiness', 'System Administrator', 'ACTIVE'),
  ('Document expiry notification days', 'How many days before a vehicle document expires its notification appears', '7', 'System Administrator', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;
`;
