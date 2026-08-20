import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as reversals from './reversals.js';

export interface LedgerEntry {
  id: string; entry_date: string; account: string; debit: number; credit: number;
  reference_type: string | null; reference_id: string | null; description: string | null;
  supplier_id: string | null; customer_id: string | null; branch_id: string | null;
}
export interface Payment {
  id: string; paid_to: string; amount: number; method: string | null;
  reference_type: string | null; reference_id: string | null; status: string; paid_at: string;
  supplier_id: string | null;
}
export interface Receipt {
  id: string; received_from: string; amount: number; method: string | null;
  reference_type: string | null; reference_id: string | null; status: string; received_at: string;
}

const AP_ACCOUNT = 'Accounts payable';

/** The only writer of the ledger table — every other service posts through this.
 *  branchId (Module 11) is one more optional tag on the same row, like
 *  supplierId/customerId — never a second posting, which would double-count
 *  in totals()/anything that sums an account without also filtering by it. */
export function postLedger(params: {
  account: string; debit: number; credit: number;
  referenceType?: string; referenceId?: string; description?: string; actor?: string; supplierId?: string; customerId?: string; branchId?: string;
}): LedgerEntry {
  const id = nextBusinessId('ledger', 'LED-', 6);
  db.prepare('INSERT INTO ledger (id, account, debit, credit, reference_type, reference_id, description, supplier_id, customer_id, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, params.account, params.debit, params.credit, params.referenceType ?? null, params.referenceId ?? null, params.description ?? null, params.supplierId ?? null, params.customerId ?? null, params.branchId ?? null);
  activityLog.record(params.actor ?? 'Finance', 'posted ledger entry for', 'ledger', id, `${params.account}: Dr ${params.debit} / Cr ${params.credit}`);
  return db.prepare('SELECT * FROM ledger WHERE id = ?').get(id) as unknown as LedgerEntry;
}

/** Goods accepted at GRN inspection become a payable — Dr Inventory / Cr Accounts
 *  payable, tagged to the supplier — the same shape as any other purchase entry,
 *  just posted automatically instead of typed in. Called from
 *  receiving.inspectGoodsReceived(), inside its existing transaction. */
export function postSupplierInvoice(params: {
  supplierId: string; amount: number; referenceId: string; description: string; actor?: string;
}): void {
  if (params.amount <= 0) return;
  postLedger({ account: 'Inventory', debit: params.amount, credit: 0, referenceType: 'goods_received', referenceId: params.referenceId, description: params.description, actor: params.actor });
  postLedger({ account: AP_ACCOUNT, debit: 0, credit: params.amount, referenceType: 'goods_received', referenceId: params.referenceId, description: params.description, actor: params.actor, supplierId: params.supplierId });
}

/** Every payment debits an expense account and credits Cash/Bank — a standalone
 *  credit to Cash/Bank with no offsetting debit would silently understate cash forever.
 *  When paying a registered supplier (supplierId set), the debit lands on Accounts
 *  payable instead of Operating expenses — settling what's owed rather than booking
 *  a fresh expense. Every existing caller omits supplierId and is unaffected. */
export function recordPayment(params: {
  paidTo: string; amount: number; method: string; referenceType?: string; referenceId?: string; actor?: string; supplierId?: string;
}): Payment {
  const id = nextBusinessId('payments', 'PAY-2026-', 5);
  db.prepare('INSERT INTO payments (id, paid_to, amount, method, reference_type, reference_id, supplier_id) VALUES (?,?,?,?,?,?,?)')
    .run(id, params.paidTo, params.amount, params.method, params.referenceType ?? null, params.referenceId ?? null, params.supplierId ?? null);
  const expenseAccount = params.supplierId ? AP_ACCOUNT : 'Operating expenses';
  postLedger({ account: expenseAccount, debit: params.amount, credit: 0, referenceType: params.referenceType, referenceId: params.referenceId, description: `Payment ${id} to ${params.paidTo}`, actor: params.actor, supplierId: params.supplierId });
  postLedger({ account: 'Cash/Bank', debit: 0, credit: params.amount, referenceType: params.referenceType, referenceId: params.referenceId, description: `Payment ${id} to ${params.paidTo}`, actor: params.actor });
  activityLog.record(params.actor ?? 'Finance', 'recorded payment to', 'payment', id, `₦${params.amount.toLocaleString('en-NG')} to ${params.paidTo}`);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as unknown as Payment;
}

/** A receipt against a sales invoice debits Cash/Bank and credits Accounts receivable
 *  (settling the debt raised when the sale was created) rather than a lopsided single
 *  entry that would leave the receivable outstanding forever even once paid.
 *  If the invoice belongs to a distributor branch (Module 11), the branch tag is
 *  derived from the sales order itself (a raw lookup, not an import of sales.ts —
 *  that would be circular, since sales.ts already imports this module) so every
 *  caller gets correct branch-level balances for free, with nothing new to pass. */
export function recordReceipt(params: {
  receivedFrom: string; amount: number; method: string; referenceType?: string; referenceId?: string; actor?: string; customerId?: string;
}): Receipt {
  const id = nextBusinessId('receipts', 'RCT-', 6);
  db.prepare('INSERT INTO receipts (id, received_from, amount, method, reference_type, reference_id) VALUES (?,?,?,?,?,?)')
    .run(id, params.receivedFrom, params.amount, params.method, params.referenceType ?? null, params.referenceId ?? null);
  const offsetAccount = params.referenceType === 'sales' ? 'Accounts receivable' : 'Other income';
  const branchId = params.referenceType === 'sales' && params.referenceId
    ? (db.prepare('SELECT branch_id FROM sales WHERE id = ?').get(params.referenceId) as { branch_id: string | null } | undefined)?.branch_id ?? undefined
    : undefined;
  postLedger({ account: 'Cash/Bank', debit: params.amount, credit: 0, referenceType: params.referenceType, referenceId: params.referenceId, description: `Receipt ${id} from ${params.receivedFrom}`, actor: params.actor });
  postLedger({
    account: offsetAccount, debit: 0, credit: params.amount, referenceType: params.referenceType, referenceId: params.referenceId,
    description: `Receipt ${id} from ${params.receivedFrom}`, actor: params.actor,
    customerId: offsetAccount === 'Accounts receivable' ? params.customerId : undefined,
    branchId: offsetAccount === 'Accounts receivable' ? branchId : undefined,
  });
  activityLog.record(params.actor ?? 'Finance', 'recorded receipt from', 'receipt', id, `₦${params.amount.toLocaleString('en-NG')} from ${params.receivedFrom}`);
  return db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as unknown as Receipt;
}

export function getPayment(id: string): Payment | undefined {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Payment | undefined;
}
export function getReceipt(id: string): Receipt | undefined {
  return db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as Receipt | undefined;
}

/** Module 17 reversal: posts the exact mirror image of recordPayment's two ledger
 *  lines, debit/credit swapped, netting the ledger effect back to zero without
 *  touching the original payment row — payments.status is never mutated (see
 *  reversals.ts for why: the reversals table, not a status flag, is the source of
 *  truth for "has this been reversed"). */
export function reversePayment(paymentId: string, params: { reason: string; actor: string }): { reversal: reversals.Reversal; payment: Payment } {
  const payment = getPayment(paymentId);
  if (!payment) throw new Error(`Unknown payment ${paymentId}`);
  reversals.assertNotReversed('payments', paymentId);

  db.exec('BEGIN');
  try {
    const expenseAccount = payment.supplier_id ? AP_ACCOUNT : 'Operating expenses';
    postLedger({
      account: expenseAccount, debit: 0, credit: payment.amount, referenceType: 'payment_reversal', referenceId: paymentId,
      description: `Reversal of payment ${paymentId}`, actor: params.actor, supplierId: payment.supplier_id ?? undefined,
    });
    postLedger({
      account: 'Cash/Bank', debit: payment.amount, credit: 0, referenceType: 'payment_reversal', referenceId: paymentId,
      description: `Reversal of payment ${paymentId}`, actor: params.actor,
    });

    const reversal = reversals.create({
      entityType: 'payments', entityId: paymentId, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ amount: payment.amount }), newValue: JSON.stringify({ amount: 0 }),
    });
    activityLog.record(
      params.actor, 'reversed', 'payments', paymentId,
      `Payment ${paymentId} (₦${payment.amount.toLocaleString('en-NG')} to ${payment.paid_to}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    db.exec('COMMIT');
    return { reversal, payment: getPayment(paymentId)! };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Module 17 reversal: mirror image of recordReceipt's two ledger lines. */
export function reverseReceipt(receiptId: string, params: { reason: string; actor: string }): { reversal: reversals.Reversal; receipt: Receipt } {
  const receipt = getReceipt(receiptId);
  if (!receipt) throw new Error(`Unknown receipt ${receiptId}`);
  reversals.assertNotReversed('receipts', receiptId);

  db.exec('BEGIN');
  try {
    const offsetAccount = receipt.reference_type === 'sales' ? 'Accounts receivable' : 'Other income';
    const customerId = receipt.reference_type === 'sales' && receipt.reference_id
      ? (db.prepare('SELECT customer_id FROM sales WHERE id = ?').get(receipt.reference_id) as { customer_id: string | null } | undefined)?.customer_id ?? undefined
      : undefined;

    postLedger({
      account: offsetAccount, debit: receipt.amount, credit: 0, referenceType: 'receipt_reversal', referenceId: receiptId,
      description: `Reversal of receipt ${receiptId}`, actor: params.actor,
      customerId: offsetAccount === 'Accounts receivable' ? customerId : undefined,
    });
    postLedger({
      account: 'Cash/Bank', debit: 0, credit: receipt.amount, referenceType: 'receipt_reversal', referenceId: receiptId,
      description: `Reversal of receipt ${receiptId}`, actor: params.actor,
    });

    const reversal = reversals.create({
      entityType: 'receipts', entityId: receiptId, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ amount: receipt.amount }), newValue: JSON.stringify({ amount: 0 }),
    });
    activityLog.record(
      params.actor, 'reversed', 'receipts', receiptId,
      `Receipt ${receiptId} (₦${receipt.amount.toLocaleString('en-NG')} from ${receipt.received_from}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    db.exec('COMMIT');
    return { reversal, receipt: getReceipt(receiptId)! };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listLedger(limit = 300): LedgerEntry[] {
  return db.prepare('SELECT * FROM ledger ORDER BY id DESC LIMIT ?').all(limit) as unknown as LedgerEntry[];
}
export function listPayments(supplierId?: string): Payment[] {
  if (supplierId) return db.prepare('SELECT * FROM payments WHERE supplier_id = ? ORDER BY id DESC').all(supplierId) as unknown as Payment[];
  return db.prepare('SELECT * FROM payments ORDER BY id DESC').all() as unknown as Payment[];
}
export function listReceipts(): Receipt[] {
  return db.prepare('SELECT * FROM receipts ORDER BY id DESC').all() as unknown as Receipt[];
}

export function totals() {
  const revenue = (db.prepare(`SELECT COALESCE(SUM(credit), 0) AS v FROM ledger WHERE account = 'Sales revenue'`).get() as { v: number }).v;
  const receivable = (db.prepare(`SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS v FROM ledger WHERE account = 'Accounts receivable'`).get() as { v: number }).v;
  const cash = (db.prepare(`SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS v FROM ledger WHERE account = 'Cash/Bank'`).get() as { v: number }).v;
  return { revenue, outstandingReceivable: receivable, cashPosition: cash };
}

/** invoiced/paid/outstanding for one supplier's Accounts payable activity.
 *  outstanding > 0 is a debit balance (we owe them); < 0 is a credit balance
 *  (they owe us — an overpayment, since nothing here issues credit notes). */
export function supplierBalance(supplierId: string) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(credit), 0) AS invoiced, COALESCE(SUM(debit), 0) AS paid
     FROM ledger WHERE account = ? AND supplier_id = ?`,
  ).get(AP_ACCOUNT, supplierId) as { invoiced: number; paid: number };
  return { invoiced: row.invoiced, paid: row.paid, outstanding: row.invoiced - row.paid };
}

/** The customer-side mirror of supplierBalance — a Marketer's (or any
 *  customer's) running Accounts receivable balance. Debit increases what
 *  they owe (a sale/credit given), credit decreases it (a receipt). */
export function customerBalance(customerId: string) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(debit), 0) AS invoiced, COALESCE(SUM(credit), 0) AS paid
     FROM ledger WHERE account = 'Accounts receivable' AND customer_id = ?`,
  ).get(customerId) as { invoiced: number; paid: number };
  return { invoiced: row.invoiced, paid: row.paid, outstanding: row.invoiced - row.paid };
}

/** The printable statement: every Accounts payable movement for this supplier,
 *  oldest first, with a running balance — same SUM(...) OVER (ORDER BY ...) shape
 *  services/inventory.ts's listTransactions already uses for its running total. */
export function supplierStatement(supplierId: string) {
  return db.prepare(`
    SELECT id, entry_date, debit, credit, description, reference_type, reference_id,
      SUM(credit - debit) OVER (ORDER BY entry_date, id) AS running_balance
    FROM ledger
    WHERE supplier_id = ? AND account = ?
    ORDER BY entry_date, id
  `).all(supplierId, AP_ACCOUNT);
}

/** Supplier Payables Report — invoiced/paid/outstanding for every supplier with
 *  any Accounts payable activity. */
export function payablesReport() {
  return db.prepare(`
    SELECT s.id AS supplier_id, s.name AS supplier_name,
      COALESCE(SUM(l.credit), 0) AS invoiced, COALESCE(SUM(l.debit), 0) AS paid,
      COALESCE(SUM(l.credit), 0) - COALESCE(SUM(l.debit), 0) AS outstanding
    FROM ledger l JOIN suppliers s ON s.id = l.supplier_id
    WHERE l.account = ?
    GROUP BY s.id, s.name
    HAVING invoiced <> 0 OR paid <> 0
    ORDER BY outstanding DESC
  `).all(AP_ACCOUNT) as { supplier_id: string; supplier_name: string; invoiced: number; paid: number; outstanding: number }[];
}

export interface SupplierInvoicePayment { payment_id: string; date: string; amount_applied: number; method: string | null }
export interface SupplierInvoice {
  id: string; invoice_number: string | null; po_id: string; date: string;
  total: number; paid: number; outstanding: number; status: 'UNPAID' | 'PARTIALLY_PAID' | 'FULLY_PAID';
  payment_history: SupplierInvoicePayment[];
}

/** Section 21: per-invoice Total/Paid/Outstanding/Payment History — the
 *  drill-down "open an invoice and see..." view. Each invoice is one GRN's
 *  accepted-value posting (postSupplierInvoice, tagged reference_id=grnId);
 *  payments are never targeted at a specific invoice when recorded (the
 *  RecordPayment form only ever picks a supplier), so — same as
 *  agingReport()'s bucketing — they're applied oldest-invoice-first here,
 *  each payment split across however many invoices it reaches. That FIFO
 *  application is exactly what makes "15 invoices fully paid, running
 *  balance reaches zero" and "one invoice partially paid stays outstanding"
 *  fall out correctly on their own: a payment that fully covers the oldest
 *  invoices and only partially reaches the next leaves that one, and only
 *  that one, with a nonzero outstanding balance. */
export function supplierInvoices(supplierId: string): SupplierInvoice[] {
  const invoiceRows = db.prepare(`
    SELECT l.id AS ledger_id, l.reference_id AS grn_id, l.entry_date, l.credit AS total, gr.invoice_number, gr.po_id
    FROM ledger l JOIN goods_received gr ON gr.id = l.reference_id
    WHERE l.supplier_id = ? AND l.account = ? AND l.reference_type = 'goods_received' AND l.credit > 0
    ORDER BY l.entry_date, l.id
  `).all(supplierId, AP_ACCOUNT) as { ledger_id: string; grn_id: string; entry_date: string; total: number; invoice_number: string | null; po_id: string }[];

  const payments = db.prepare(`
    SELECT id, amount, method, paid_at FROM payments WHERE supplier_id = ? ORDER BY paid_at, id
  `).all(supplierId) as { id: string; amount: number; method: string | null; paid_at: string }[];

  const invoices = invoiceRows.map(inv => ({ ...inv, remaining: inv.total, paymentHistory: [] as SupplierInvoicePayment[] }));

  for (const payment of payments) {
    let remainingPayment = payment.amount;
    for (const inv of invoices) {
      if (remainingPayment <= 0) break;
      if (inv.remaining <= 0) continue;
      const applied = Math.min(inv.remaining, remainingPayment);
      inv.remaining -= applied;
      remainingPayment -= applied;
      inv.paymentHistory.push({ payment_id: payment.id, date: payment.paid_at, amount_applied: applied, method: payment.method });
    }
  }

  return invoices.map(inv => {
    const paid = inv.total - inv.remaining;
    const status: SupplierInvoice['status'] = inv.remaining <= 0 ? 'FULLY_PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
    return {
      id: inv.grn_id, invoice_number: inv.invoice_number, po_id: inv.po_id, date: inv.entry_date,
      total: inv.total, paid, outstanding: inv.remaining, status, payment_history: inv.paymentHistory,
    };
  });
}

/** The customer-side mirror of payablesReport — invoiced/paid/outstanding for
 *  every customer (Marketer, Distributor or Retail) with any Accounts
 *  receivable activity, the "customer accounts" list Section 16's statement
 *  view is opened from. */
export function receivablesReport() {
  return db.prepare(`
    SELECT c.id AS customer_id, c.name AS customer_name, c.customer_type,
      COALESCE(SUM(l.debit), 0) AS invoiced, COALESCE(SUM(l.credit), 0) AS paid,
      COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS outstanding
    FROM ledger l JOIN customers c ON c.id = l.customer_id
    WHERE l.account = 'Accounts receivable'
    GROUP BY c.id, c.name, c.customer_type
    HAVING invoiced <> 0 OR paid <> 0
    ORDER BY outstanding DESC
  `).all() as { customer_id: string; customer_name: string; customer_type: string; invoiced: number; paid: number; outstanding: number }[];
}

/** The customer-side mirror of supplierStatement (Section 16: Customer
 *  Account Statement) — every Accounts receivable movement for this
 *  customer, oldest first, with a running balance. Every kind of movement
 *  the spec lists (Invoice, Payment, Credit, Return, Adjustment) already
 *  lands here as a plain debit/credit row via postLedger/recordReceipt — a
 *  sale debits, a receipt/return credit note credits — so nothing new needs
 *  to be tagged; the running balance itself is never stored, only computed,
 *  so every past movement is retained exactly as posted (Do NOT calculate
 *  only a final total). */
export function customerStatement(customerId: string) {
  return db.prepare(`
    SELECT id, entry_date, debit, credit, description, reference_type, reference_id,
      SUM(debit - credit) OVER (ORDER BY entry_date, id) AS running_balance
    FROM ledger
    WHERE customer_id = ? AND account = 'Accounts receivable'
    ORDER BY entry_date, id
  `).all(customerId);
}

/** Section 17: configurable AR aging bucket boundaries, in days —
 *  [breakpoint1, breakpoint2, ...] where age<=breakpoint1 is "Current" and
 *  each subsequent breakpoint closes the next bucket, the last one left
 *  open-ended as "90+". Stored as a comma-separated Settings row (module 18's
 *  existing generic CRUD, so no new admin UI is needed to change it) —
 *  defaults to the spec's own Current/1-30/31-40/41-50/51-60/61-90/90+ shape
 *  if unset or malformed. */
const DEFAULT_AGING_BOUNDARIES = [0, 30, 40, 50, 60, 90];
const AGING_SETTING_ID = 'AR aging buckets (days)';

function agingBoundaries(): number[] {
  const row = db.prepare('SELECT value FROM settings WHERE id = ?').get(AGING_SETTING_ID) as { value: string } | undefined;
  if (!row) return DEFAULT_AGING_BOUNDARIES;
  const parsed = row.value.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
  return parsed.length >= 2 ? parsed : DEFAULT_AGING_BOUNDARIES;
}

function bucketOf(ageDays: number, boundaries: number[]): number {
  for (let i = 0; i < boundaries.length; i++) if (ageDays <= boundaries[i]) return i;
  return boundaries.length;
}

export interface CustomerAgingRow {
  customerId: string; customerName: string; customerType: string;
  current: number; d1to30: number; d31to40: number; d41to50: number; d51to60: number; d61to90: number; d90plus: number; total: number;
}

/** Customer Aging (Section 17) — the customer-side counterpart to
 *  agingReport() above, same FIFO cash-application algorithm, bucketed
 *  against the configurable boundaries instead of the supplier report's
 *  fixed 4-bucket shape. Used for performance monitoring and debt recovery,
 *  same as the spec asks. */
export function customerAgingReport(): CustomerAgingRow[] {
  const boundaries = agingBoundaries();
  const customers = db.prepare(
    `SELECT DISTINCT c.id, c.name, c.customer_type FROM customers c JOIN ledger l ON l.customer_id = c.id WHERE l.account = 'Accounts receivable'`,
  ).all() as { id: string; name: string; customer_type: string }[];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  return customers.map(c => {
    const invoices = (db.prepare(
      `SELECT entry_date, debit AS amount FROM ledger WHERE customer_id = ? AND account = 'Accounts receivable' AND debit > 0 ORDER BY entry_date, id`,
    ).all(c.id) as { entry_date: string; amount: number }[]).map(inv => ({ ...inv, remaining: inv.amount }));
    const payments = db.prepare(
      `SELECT credit AS amount FROM ledger WHERE customer_id = ? AND account = 'Accounts receivable' AND credit > 0 ORDER BY entry_date, id`,
    ).all(c.id) as { amount: number }[];

    for (const payment of payments) {
      let remainingPayment = payment.amount;
      for (const inv of invoices) {
        if (remainingPayment <= 0) break;
        const applied = Math.min(inv.remaining, remainingPayment);
        inv.remaining -= applied;
        remainingPayment -= applied;
      }
    }

    const amounts = new Array(boundaries.length + 1).fill(0);
    for (const inv of invoices) {
      if (inv.remaining <= 0) continue;
      // Floored to whole days: without this, an invoice raised moments ago
      // (fractionally > 0 days old by the time this query runs) would miss
      // the boundaries[0]=0 "Current" cutoff and fall straight into "1-30".
      const ageDays = Math.floor((now - new Date(inv.entry_date).getTime()) / DAY);
      amounts[bucketOf(ageDays, boundaries)] += inv.remaining;
    }
    const [current, d1to30, d31to40, d41to50, d51to60, d61to90, d90plus] = amounts;
    const total = amounts.reduce((s, v) => s + v, 0);
    return { customerId: c.id, customerName: c.name, customerType: c.customer_type, current, d1to30, d31to40, d41to50, d51to60, d61to90, d90plus, total };
  }).filter(row => row.total > 0);
}

/** Supplier Aging — payments applied oldest-invoice-first (standard FIFO cash
 *  application) to bucket outstanding balances by how old the invoice they're
 *  still sitting against is. A pure computation over ledger rows; nothing stored. */
export function agingReport() {
  const suppliers = db.prepare(`SELECT DISTINCT s.id, s.name FROM suppliers s JOIN ledger l ON l.supplier_id = s.id WHERE l.account = ?`).all(AP_ACCOUNT) as { id: string; name: string }[];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  return suppliers.map(s => {
    const invoices = (db.prepare(`SELECT entry_date, credit AS amount FROM ledger WHERE supplier_id = ? AND account = ? AND credit > 0 ORDER BY entry_date, id`).all(s.id, AP_ACCOUNT) as { entry_date: string; amount: number }[])
      .map(inv => ({ ...inv, remaining: inv.amount }));
    const payments = db.prepare(`SELECT debit AS amount FROM ledger WHERE supplier_id = ? AND account = ? AND debit > 0 ORDER BY entry_date, id`).all(s.id, AP_ACCOUNT) as { amount: number }[];

    for (const payment of payments) {
      let remainingPayment = payment.amount;
      for (const inv of invoices) {
        if (remainingPayment <= 0) break;
        const applied = Math.min(inv.remaining, remainingPayment);
        inv.remaining -= applied;
        remainingPayment -= applied;
      }
    }

    const buckets = { current: 0, d31to60: 0, d61to90: 0, d90plus: 0 };
    for (const inv of invoices) {
      if (inv.remaining <= 0) continue;
      const ageDays = (now - new Date(inv.entry_date).getTime()) / DAY;
      if (ageDays <= 30) buckets.current += inv.remaining;
      else if (ageDays <= 60) buckets.d31to60 += inv.remaining;
      else if (ageDays <= 90) buckets.d61to90 += inv.remaining;
      else buckets.d90plus += inv.remaining;
    }

    const total = buckets.current + buckets.d31to60 + buckets.d61to90 + buckets.d90plus;
    return { supplierId: s.id, supplierName: s.name, ...buckets, total };
  }).filter(row => row.total > 0);
}
