import { db } from './client.js';
import { SCHEMA_SQL } from './schema.js';

export function migrate(): void {
  db.exec(SCHEMA_SQL);
  ensureColumn('inventory_transactions', 'actor', 'TEXT');
  ensureColumn('payroll_runs', 'staff_name', 'TEXT');
  ensureColumn('items', 'manufacturer_id', 'TEXT');
  ensureColumn('items', 'pieces_per_bag', 'REAL');
  ensureColumn('ledger', 'supplier_id', 'TEXT');
  ensureColumn('payments', 'supplier_id', 'TEXT');
  ensureColumn('customers', 'customer_type', "TEXT NOT NULL DEFAULT 'MARKETER'");
  ensureColumn('ledger', 'customer_id', 'TEXT');
  ensureColumn('marketer_returns', 'status', "TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'");
  ensureColumn('marketer_returns', 'verified_by', 'TEXT');
  ensureColumn('marketer_returns', 'verified_at', 'TEXT');
  ensureColumn('marketer_return_items', 'verified_quantity', 'REAL');
  ensureColumn('items', 'is_returnable_asset', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('marketer_customer_sales', 'due_date', 'TEXT');
  ensureColumn('marketer_customer_sales', 'collector', 'TEXT');
  ensureColumn('sales', 'branch_id', 'TEXT');
  ensureColumn('sales', 'manual_invoice_number', 'TEXT');
  ensureColumn('ledger', 'branch_id', 'TEXT');
  ensureColumn('activity_log', 'department', 'TEXT');
  ensureColumn('activity_log', 'old_value', 'TEXT');
  ensureColumn('activity_log', 'new_value', 'TEXT');
  ensureColumn('activity_log', 'reason', 'TEXT');
  ensureColumn('activity_log', 'ip_address', 'TEXT');
  ensureColumn('activity_log', 'device', 'TEXT');
  ensureColumn('users', 'password_hash', 'TEXT');
  ensureColumn('customers', 'phone', 'TEXT');
  ensureColumn('users', 'phone', 'TEXT');
  ensureColumn('inventory_transactions', 'from_location', 'TEXT');
  ensureColumn('inventory_transactions', 'to_location', 'TEXT');
  ensureColumn('pos_receipt_prints', 'document_type', "TEXT NOT NULL DEFAULT 'RECEIPT' CHECK (document_type IN ('RECEIPT','INVOICE'))");
  ensureColumn('marketer_stock_issues', 'status', "TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','VERIFIED'))");
  ensureColumn('marketer_stock_issues', 'verified_by', 'TEXT');
  ensureColumn('marketer_stock_issues', 'verified_at', 'TEXT');
  // Every marketer_stock_issues row that predates this column already has a
  // real marketer_stock_transactions IN row (the old issueStock posted it
  // immediately) — mark them VERIFIED so existing installs don't suddenly
  // show old, already-confirmed assignments as newly pending.
  db.exec(`UPDATE marketer_stock_issues SET status = 'VERIFIED', verified_at = issued_at WHERE status = 'ASSIGNED' AND id IN (SELECT DISTINCT source_id FROM marketer_stock_transactions WHERE source_type = 'ISSUE')`);
  // Commission rate and aging-bucket boundaries are read from these two Settings
  // rows (marketerPerformance.commissionRatePercent / finance.agingBoundaries) —
  // seeded once, idempotently, so every install has them to edit via the
  // existing Settings module rather than starting from a silently-missing row.
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Marketer commission rate', 'Percentage applied to a marketer''s commissionable sales (Cash + Recovered Credit) — see Marketer Performance', '5%', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Marketer commission rate')
  `);
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'AR aging buckets (days)', 'Comma-separated day breakpoints for customer/supplier aging: Current, then each bucket upper bound, the rest falling into the final 90+ bucket', '0,30,40,50,60,90', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'AR aging buckets (days)')
  `);
  ensureColumn('purchase_orders', 'requested_by_user_id', 'TEXT');
  ensureColumn('quality_control', 'product_type', "TEXT CHECK (product_type IN ('RAW_WATER','TREATED_WATER','UNTREATED_WATER','OTHER'))");
  ensureColumn('quality_control', 'reviewed_by', 'TEXT');
  // Item categories (Procurement) and QC parameters (Section 19) — both read
  // from these Settings rows (inventory.categoryList / qualityControl.parameterNames)
  // rather than any hard-coded list, editable via the existing Settings module.
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Item categories', 'Comma-separated categories offered when creating an item or material variant', 'Chemicals,Labels,Bottle Caps,Raw Materials,Packaging,Other', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Item categories')
  `);
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'QC parameters', 'Comma-separated laboratory parameters offered when recording a quality test', 'pH,Turbidity,Odour,Taste,Appearance/Clearness,Total Dissolved Solids,Conductivity,Chlorine Residual', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'QC parameters')
  `);
  ensureColumn('employees', 'date_engaged', 'TEXT');
  ensureColumn('employees', 'date_disengaged', 'TEXT');
  ensureColumn('employees', 'exit_reason', 'TEXT');
  ensureColumn('employees', 'notes', 'TEXT');
  // Best-effort backfill so pre-existing staff still show a tenure — created_at
  // is the closest fact already on file for when they joined.
  db.exec(`UPDATE employees SET date_engaged = date(created_at) WHERE date_engaged IS NULL`);
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Employee status options', 'Comma-separated employee status values offered on staff records', 'Active,Inactive,On Leave,Resigned,Terminated,Disengaged,Absconded', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Employee status options')
  `);
  ensureColumn('production_batches', 'rejected_quantity', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('production_batches', 'wasted_quantity', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('production_batches', 'closed_by', 'TEXT');
  ensureColumn('production_batches', 'closed_at', 'TEXT');
  // Backfill existing payroll rows created before staff_name existed.
  db.exec(`UPDATE payroll_runs SET staff_name = (SELECT name FROM employees WHERE employees.id = payroll_runs.staff_id) WHERE staff_name IS NULL`);
  // The only returnable-asset SKU today — dispenser bottles are company
  // property that's supposed to come back for a refill, tracked separately
  // from ordinary FG stock (see services/dispenserBottles.ts). Idempotent.
  db.exec(`UPDATE items SET is_returnable_asset = 1 WHERE name = '20L Dispenser'`);

  // ===================== Payroll (Module 26/27/28/29) =====================
  ensureColumn('employees', 'bank_name', 'TEXT');
  ensureColumn('employees', 'bank_account_number', 'TEXT');
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Compulsory savings liquidation date', 'Annual liquidation date for employee compulsory savings, as MM-DD', '01-01', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Compulsory savings liquidation date')
  `);
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Payroll approval signature format', 'Template for the digital approval signature payroll.approveRun() generates — {approver} and {date} are substituted', 'Digitally approved by {approver} on {date} on behalf of the Chairman', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Payroll approval signature format')
  `);

  // ===================== Asset & Maintenance (Module 30/31) =====================
  ensureColumn('assets', 'category', 'TEXT');
  ensureColumn('assets', 'serial_number', 'TEXT');
  ensureColumn('assets', 'assigned_department', 'TEXT');
  ensureColumn('assets', 'service_interval_days', 'INTEGER');
  ensureColumn('assets', 'notes', 'TEXT');
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Asset categories', 'Comma-separated categories offered when registering an asset', 'Vehicles,Generators,Machines,Equipment,Building,Office Equipment,Other Fixed Assets', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Asset categories')
  `);
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Maintenance categories', 'Comma-separated categories offered when recording a maintenance expense', 'Vehicle Fuel,Diesel,Engine Oil,Filters,Tyres,Tyre Maintenance,Brake,Spare Parts,Machine Spare Parts,Generator Maintenance,Machine Maintenance,Building Maintenance,Photocopier Maintenance,Printer Maintenance,Utilities,Electricity,Other Maintenance', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Maintenance categories')
  `);

  // ===================== Company Vehicles & Fuel (Module 32/33/34/35) =====================
  ensureColumn('vehicles', 'plate_number', 'TEXT');
  ensureColumn('vehicles', 'vehicle_type', 'TEXT');
  ensureColumn('vehicles', 'category', "TEXT CHECK (category IN ('COMMERCIAL', 'PRIVATE'))");
  ensureColumn('vehicles', 'acquisition_date', 'TEXT');
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Vehicle documents - Commercial', 'Comma-separated document types required for Commercial vehicles', 'AMAC documentation,Local Government documentation,Registration,Insurance,Roadworthiness,Speed Limiting Device', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Vehicle documents - Commercial')
  `);
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Vehicle documents - Private', 'Comma-separated document types required for Private vehicles', 'Registration,Insurance,Roadworthiness', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Vehicle documents - Private')
  `);
  db.exec(`
    INSERT INTO settings (id, description, value, updated_by, status)
    SELECT 'Document expiry notification days', 'How many days before a vehicle document expires its notification appears', '7', 'System Administrator', 'ACTIVE'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 'Document expiry notification days')
  `);

  ensureGrnUpgrade();
  ensureSalesUpgrade();
  ensurePayrollUpgrade();
  ensureDeliveryUpgrade();
}

/** goods_received's status CHECK constraint changed shape (PENDING_QC/PASSED/FAILED
 *  → PENDING_INSPECTION/PARTIALLY_ACCEPTED/ACCEPTED/REJECTED/RETURNED) and gained
 *  several header columns — SQLite can't ALTER a CHECK constraint, so an existing
 *  install needs a guarded rebuild (fresh installs already get the new shape
 *  straight from SCHEMA_SQL above, so this no-ops for them). Existing rows are
 *  remapped onto the new status vocabulary and goods_received_items backfilled
 *  from the old binary verdict, so historical GRNs render correctly in the new
 *  accepted/rejected UI instead of showing blanks. */
function ensureGrnUpgrade(): void {
  const columns = db.prepare(`PRAGMA table_info(goods_received)`).all() as { name: string }[];
  if (columns.some(c => c.name === 'driver_name')) return;

  // goods_received_items.grn_id (and supplier_returns.grn_id) hold a real FK onto
  // goods_received(id) — dropping the table while those rows still point at it
  // violates the constraint even though every id is about to be recreated
  // identically. foreign_keys can only be toggled outside a transaction.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE goods_received_new (
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
      )
    `);
    db.exec(`
      INSERT INTO goods_received_new (id, po_id, received_by, status, received_at)
      SELECT id, po_id, received_by,
        CASE status WHEN 'PENDING_QC' THEN 'PENDING_INSPECTION' WHEN 'PASSED' THEN 'ACCEPTED' WHEN 'FAILED' THEN 'REJECTED' ELSE status END,
        received_at
      FROM goods_received
    `);
    db.exec('DROP TABLE goods_received');
    db.exec('ALTER TABLE goods_received_new RENAME TO goods_received');
    db.exec('CREATE INDEX IF NOT EXISTS idx_grn_po ON goods_received(po_id)');

    ensureColumn('goods_received_items', 'expected_quantity', 'REAL');
    ensureColumn('goods_received_items', 'accepted_quantity', 'REAL');
    ensureColumn('goods_received_items', 'rejected_quantity', 'REAL');
    ensureColumn('goods_received_items', 'short_quantity', 'REAL');
    ensureColumn('goods_received_items', 'over_quantity', 'REAL');
    ensureColumn('goods_received_items', 'rejection_reason', 'TEXT');

    db.exec(`
      UPDATE goods_received_items
      SET expected_quantity = (
        SELECT poi.quantity FROM purchase_order_items poi
        JOIN goods_received gr ON gr.po_id = poi.po_id
        WHERE gr.id = goods_received_items.grn_id AND poi.item_id = goods_received_items.item_id
      )
      WHERE expected_quantity IS NULL
    `);
    db.exec(`
      UPDATE goods_received_items
      SET
        accepted_quantity = CASE (SELECT status FROM goods_received WHERE id = goods_received_items.grn_id)
          WHEN 'ACCEPTED' THEN quantity WHEN 'REJECTED' THEN 0 ELSE accepted_quantity END,
        rejected_quantity = CASE (SELECT status FROM goods_received WHERE id = goods_received_items.grn_id)
          WHEN 'ACCEPTED' THEN 0 WHEN 'REJECTED' THEN quantity ELSE rejected_quantity END
      WHERE accepted_quantity IS NULL AND rejected_quantity IS NULL
    `);
    db.exec(`
      UPDATE goods_received_items
      SET
        short_quantity = MAX(COALESCE(expected_quantity, 0) - quantity, 0),
        over_quantity = MAX(quantity - COALESCE(expected_quantity, 0), 0)
      WHERE short_quantity IS NULL
        AND (SELECT status FROM goods_received WHERE id = goods_received_items.grn_id) != 'PENDING_INSPECTION'
    `);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** sales.customer_id was NOT NULL (a Retail POS sale needs no customer profile
 *  now) and its status CHECK gained AWAITING_APPROVAL — both need the same
 *  guarded-rebuild treatment as ensureGrnUpgrade above, for the same reason
 *  (SQLite can't ALTER a column's nullability or a CHECK constraint in place).
 *  Existing rows keep their customer_id/status untouched; payment_terms is
 *  backfilled from channel (POS was always effectively cash). */
function ensureSalesUpgrade(): void {
  const columns = db.prepare(`PRAGMA table_info(sales)`).all() as { name: string }[];
  if (columns.some(c => c.name === 'payment_terms')) return;

  // sales_items.sales_id and delivery_runs.sales_id hold a real FK onto
  // sales(id) — same DROP-while-referenced issue as the GRN rebuild.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE sales_new (
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
      )
    `);
    db.exec(`
      INSERT INTO sales_new (id, customer_id, channel, rep, status, payment_terms, total_amount, created_at)
      SELECT id, customer_id, channel, rep, status, CASE WHEN channel = 'POS' THEN 'CASH' ELSE 'CREDIT' END, total_amount, created_at
      FROM sales
    `);
    db.exec('DROP TABLE sales');
    db.exec('ALTER TABLE sales_new RENAME TO sales');

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** payroll_runs' status CHECK gained the whole Module 28 approval workflow
 *  (PENDING_REVIEW/AWAITING_APPROVAL/APPROVED/REJECTED/DISBURSED, replacing
 *  the old PAID/SCHEDULED/ON_HOLD) and several new columns — same
 *  guarded-rebuild treatment as ensureGrnUpgrade/ensureSalesUpgrade above.
 *  Existing rows are remapped onto the new vocabulary (PAID -> DISBURSED,
 *  everything else -> APPROVED so old, already-settled-looking runs don't
 *  suddenly appear to need review) and locked, since they represent payroll
 *  that already happened under the old system. */
function ensurePayrollUpgrade(): void {
  const columns = db.prepare(`PRAGMA table_info(payroll_runs)`).all() as { name: string }[];
  if (columns.some(c => c.name === 'total_deductions')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE payroll_runs_new (
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
      )
    `);
    db.exec(`
      INSERT INTO payroll_runs_new (id, staff_id, staff_name, period, gross, net, status, disbursed_by, disbursed_at, locked, created_at)
      SELECT id, staff_id, staff_name, period, gross, net,
        CASE status WHEN 'PAID' THEN 'DISBURSED' ELSE 'APPROVED' END,
        CASE status WHEN 'PAID' THEN staff_name ELSE NULL END,
        CASE status WHEN 'PAID' THEN created_at ELSE NULL END,
        1, created_at
      FROM payroll_runs
    `);
    db.exec('DROP TABLE payroll_runs');
    db.exec('ALTER TABLE payroll_runs_new RENAME TO payroll_runs');
    db.exec('CREATE INDEX IF NOT EXISTS idx_payroll_staff ON payroll_runs(staff_id)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** delivery_runs' status CHECK gained the full Section 37 vocabulary
 *  (PENDING/READY/DISPATCHED/ACTIVE/DELIVERED/CANCELLED/RETURNED, replacing
 *  the old SCHEDULED/ACTIVE/DELIVERED) and a delivered_by column — same
 *  guarded-rebuild treatment as the other CHECK-constraint upgrades above.
 *  Every existing row was created by the old single-step dispatch flow, so
 *  its status is remapped straight across (ACTIVE/DELIVERED keep their
 *  meaning, SCHEDULED — never actually produced by old code, but a valid
 *  old value — becomes DISPATCHED, the new initial state). */
function ensureDeliveryUpgrade(): void {
  const columns = db.prepare(`PRAGMA table_info(delivery_runs)`).all() as { name: string }[];
  if (columns.some(c => c.name === 'delivered_by')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE delivery_runs_new (
        id TEXT PRIMARY KEY,
        sales_id TEXT NOT NULL REFERENCES sales(id),
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        driver TEXT,
        route TEXT,
        status TEXT NOT NULL DEFAULT 'DISPATCHED' CHECK (status IN ('PENDING','READY','DISPATCHED','ACTIVE','DELIVERED','CANCELLED','RETURNED')),
        dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_by TEXT,
        delivered_at TEXT
      )
    `);
    db.exec(`
      INSERT INTO delivery_runs_new (id, sales_id, vehicle_id, driver, route, status, dispatched_at, delivered_at)
      SELECT id, sales_id, vehicle_id, driver, route,
        CASE status WHEN 'SCHEDULED' THEN 'DISPATCHED' ELSE status END,
        dispatched_at, delivered_at
      FROM delivery_runs
    `);
    db.exec('DROP TABLE delivery_runs');
    db.exec('ALTER TABLE delivery_runs_new RENAME TO delivery_runs');
    db.exec('CREATE INDEX IF NOT EXISTS idx_delivery_sales ON delivery_runs(sales_id)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** CREATE TABLE IF NOT EXISTS above only shapes a fresh database — existing
 *  installs need columns added explicitly when the schema grows a field. */
function ensureColumn(table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
