import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';

export interface LedgerEntry {
  id: string; entry_date: string; account: string; debit: number; credit: number;
  reference_type: string | null; reference_id: string | null; description: string | null;
}
export interface Payment {
  id: string; paid_to: string; amount: number; method: string | null;
  reference_type: string | null; reference_id: string | null; status: string; paid_at: string;
}
export interface Receipt {
  id: string; received_from: string; amount: number; method: string | null;
  reference_type: string | null; reference_id: string | null; status: string; received_at: string;
}

/** The only writer of the ledger table — every other service posts through this. */
export function postLedger(params: {
  account: string; debit: number; credit: number;
  referenceType?: string; referenceId?: string; description?: string; actor?: string;
}): LedgerEntry {
  const id = nextBusinessId('ledger', 'LED-', 6);
  db.prepare('INSERT INTO ledger (id, account, debit, credit, reference_type, reference_id, description) VALUES (?,?,?,?,?,?,?)')
    .run(id, params.account, params.debit, params.credit, params.referenceType ?? null, params.referenceId ?? null, params.description ?? null);
  activityLog.record(params.actor ?? 'Finance', 'posted ledger entry for', 'ledger', id, `${params.account}: Dr ${params.debit} / Cr ${params.credit}`);
  return db.prepare('SELECT * FROM ledger WHERE id = ?').get(id) as unknown as LedgerEntry;
}

/** Every payment debits an expense account and credits Cash/Bank — a standalone
 *  credit to Cash/Bank with no offsetting debit would silently understate cash forever. */
export function recordPayment(params: {
  paidTo: string; amount: number; method: string; referenceType?: string; referenceId?: string; actor?: string;
}): Payment {
  const id = nextBusinessId('payments', 'PAY-2026-', 5);
  db.prepare('INSERT INTO payments (id, paid_to, amount, method, reference_type, reference_id) VALUES (?,?,?,?,?,?)')
    .run(id, params.paidTo, params.amount, params.method, params.referenceType ?? null, params.referenceId ?? null);
  postLedger({ account: 'Operating expenses', debit: params.amount, credit: 0, referenceType: params.referenceType, referenceId: params.referenceId, description: `Payment ${id} to ${params.paidTo}`, actor: params.actor });
  postLedger({ account: 'Cash/Bank', debit: 0, credit: params.amount, referenceType: params.referenceType, referenceId: params.referenceId, description: `Payment ${id} to ${params.paidTo}`, actor: params.actor });
  activityLog.record(params.actor ?? 'Finance', 'recorded payment to', 'payment', id, `₦${params.amount.toLocaleString('en-NG')} to ${params.paidTo}`);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as unknown as Payment;
}

/** A receipt against a sales invoice debits Cash/Bank and credits Accounts receivable
 *  (settling the debt raised when the sale was created) rather than a lopsided single
 *  entry that would leave the receivable outstanding forever even once paid. */
export function recordReceipt(params: {
  receivedFrom: string; amount: number; method: string; referenceType?: string; referenceId?: string; actor?: string;
}): Receipt {
  const id = nextBusinessId('receipts', 'RCT-', 6);
  db.prepare('INSERT INTO receipts (id, received_from, amount, method, reference_type, reference_id) VALUES (?,?,?,?,?,?)')
    .run(id, params.receivedFrom, params.amount, params.method, params.referenceType ?? null, params.referenceId ?? null);
  const offsetAccount = params.referenceType === 'sales' ? 'Accounts receivable' : 'Other income';
  postLedger({ account: 'Cash/Bank', debit: params.amount, credit: 0, referenceType: params.referenceType, referenceId: params.referenceId, description: `Receipt ${id} from ${params.receivedFrom}`, actor: params.actor });
  postLedger({ account: offsetAccount, debit: 0, credit: params.amount, referenceType: params.referenceType, referenceId: params.referenceId, description: `Receipt ${id} from ${params.receivedFrom}`, actor: params.actor });
  activityLog.record(params.actor ?? 'Finance', 'recorded receipt from', 'receipt', id, `₦${params.amount.toLocaleString('en-NG')} from ${params.receivedFrom}`);
  return db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as unknown as Receipt;
}

export function listLedger(limit = 300): LedgerEntry[] {
  return db.prepare('SELECT * FROM ledger ORDER BY id DESC LIMIT ?').all(limit) as unknown as LedgerEntry[];
}
export function listPayments(): Payment[] {
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
