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
