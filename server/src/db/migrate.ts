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
  // Backfill existing payroll rows created before staff_name existed.
  db.exec(`UPDATE payroll_runs SET staff_name = (SELECT name FROM employees WHERE employees.id = payroll_runs.staff_id) WHERE staff_name IS NULL`);
  // The only returnable-asset SKU today — dispenser bottles are company
  // property that's supposed to come back for a refill, tracked separately
  // from ordinary FG stock (see services/dispenserBottles.ts). Idempotent.
  db.exec(`UPDATE items SET is_returnable_asset = 1 WHERE name = '20L Dispenser'`);
  ensureGrnUpgrade();
  ensureSalesUpgrade();
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

/** CREATE TABLE IF NOT EXISTS above only shapes a fresh database — existing
 *  installs need columns added explicitly when the schema grows a field. */
function ensureColumn(table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
