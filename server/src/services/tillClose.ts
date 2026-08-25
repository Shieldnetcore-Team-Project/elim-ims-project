import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';

export interface TillClose {
  id: string; business_date: string; till: string;
  opening_balance: number; cash_sales: number; cash_received: number; payments: number; transfers: number; adjustments: number;
  expected_closing: number; actual_closing: number; difference: number;
  closed_by: string | null; reviewed_by: string | null; status: 'CLOSED' | 'REVIEWED'; closed_at: string; reviewed_at: string | null;
}

const DEFAULT_TILL = 'Retail Till';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Cash Sales / Cash Received / Transfers, read live off today's Retail
 *  (POS) activity — never entered by hand. Cash Sales is the value of
 *  everything sold for cash (sales.total_amount); Cash Received and
 *  Transfers split what was actually collected by payment method (a POS
 *  sale can be split-paid — see sales.ts's payments array), since only the
 *  Cash portion ever touches the physical till drawer.
 *
 *  Scoped by business_date only, not by till: POS sales aren't tagged to a
 *  specific counter anywhere in this system (only a free-text `rep`), so
 *  today's company-wide Retail cash activity is what every till on the same
 *  date sees — closeTill() still records opening balance/payments/
 *  adjustments/actual count separately per till, just against this one
 *  shared figure. If multiple physical tills ever need their own sales
 *  split, that requires tagging sales with a till id first. */
export async function todayCashFigures(businessDate?: string): Promise<{ cashSales: number; cashReceived: number; transfers: number }> {
  const d = businessDate ?? today();
  const cashSales = (await db.prepare(
    `SELECT COALESCE(SUM(total_amount), 0) AS v FROM sales WHERE channel = 'POS' AND status = 'PAID' AND to_char(created_at::timestamp, 'YYYY-MM-DD') = ?`,
  ).get(d) as { v: number }).v;
  const cashReceived = (await db.prepare(`
    SELECT COALESCE(SUM(r.amount), 0) AS v FROM receipts r JOIN sales s ON s.id = r.reference_id AND r.reference_type = 'sales'
    WHERE s.channel = 'POS' AND to_char(r.received_at::timestamp, 'YYYY-MM-DD') = ? AND r.method = 'Cash'
  `).get(d) as { v: number }).v;
  const transfers = (await db.prepare(`
    SELECT COALESCE(SUM(r.amount), 0) AS v FROM receipts r JOIN sales s ON s.id = r.reference_id AND r.reference_type = 'sales'
    WHERE s.channel = 'POS' AND to_char(r.received_at::timestamp, 'YYYY-MM-DD') = ? AND r.method IN ('Transfer', 'POS Terminal')
  `).get(d) as { v: number }).v;
  return { cashSales, cashReceived, transfers };
}

export async function getTillClose(id: string): Promise<TillClose | undefined> {
  return await db.prepare('SELECT * FROM till_closes WHERE id = ?').get(id) as TillClose | undefined;
}

export async function listTillCloses(): Promise<TillClose[]> {
  return await db.prepare('SELECT * FROM till_closes ORDER BY business_date DESC, id DESC').all() as unknown as TillClose[];
}

export async function isTillClosed(till: string = DEFAULT_TILL, businessDate?: string): Promise<boolean> {
  const d = businessDate ?? today();
  return !!(await db.prepare('SELECT 1 FROM till_closes WHERE business_date = ? AND till = ?').get(d, till));
}

/** Section 23: cash Sales/Received/Transfers are read live (todayCashFigures);
 *  Payments (cash paid out of the drawer) and Adjustments (float top-ups/
 *  corrections) are the till operator's own entries — nothing in this system
 *  tracks till-level expenses automatically. expected_closing is deliberately
 *  a pure cash-drawer figure: Opening + Cash Received - Payments +
 *  Adjustments — Transfers never touch physical cash, so they're reported
 *  alongside for context but excluded from the math, and Cash Sales (the
 *  value of what sold, which can differ from Cash Received on a split-paid
 *  sale) is likewise reporting-only. difference = actual - expected: positive
 *  is an overage, negative a shortage. */
export async function closeTill(params: {
  till?: string; businessDate?: string; openingBalance: number; payments: number; adjustments: number;
  actualClosing: number; closedBy: string; actor?: string;
}): Promise<TillClose> {
  const till = params.till?.trim() || DEFAULT_TILL;
  const businessDate = params.businessDate ?? today();
  if (await isTillClosed(till, businessDate)) throw new Error(`${till} is already closed for ${businessDate}`);
  if (params.openingBalance < 0 || params.payments < 0) throw new Error('Opening balance and payments cannot be negative');

  const { cashSales, cashReceived, transfers } = await todayCashFigures(businessDate);
  const expectedClosing = params.openingBalance + cashReceived - params.payments + params.adjustments;
  const difference = params.actualClosing - expectedClosing;

  const id = await nextBusinessId('till_closes', 'TC-', 4);
  await db.prepare(`
    INSERT INTO till_closes (id, business_date, till, opening_balance, cash_sales, cash_received, payments, transfers, adjustments, expected_closing, actual_closing, difference, closed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, businessDate, till, params.openingBalance, cashSales, cashReceived, params.payments, transfers, params.adjustments, expectedClosing, params.actualClosing, difference, params.closedBy);

  const actor = params.actor ?? params.closedBy;
  const diffNote = difference === 0 ? 'balanced' : difference > 0 ? `₦${difference.toLocaleString('en-NG')} over` : `₦${Math.abs(difference).toLocaleString('en-NG')} short`;
  await activityLog.record(actor, 'closed till', 'till_close', id, `${till} closed for ${businessDate} by ${params.closedBy} — ${diffNote}`);
  return (await getTillClose(id))!;
}

/** Confirmation by a second person, same shape as marketerStock.verifyAssignment
 *  — no role/approval gate, just a distinct signature from whoever closed it. */
export async function reviewTill(id: string, params: { reviewedBy: string; actor?: string }): Promise<TillClose> {
  const row = await getTillClose(id);
  if (!row) throw new Error(`Unknown till close ${id}`);
  if (row.status === 'REVIEWED') throw new Error(`${id} has already been reviewed`);
  const actor = params.actor ?? params.reviewedBy;
  await db.prepare(`UPDATE till_closes SET reviewed_by = ?, status = 'REVIEWED', reviewed_at = now() WHERE id = ?`).run(params.reviewedBy, id);
  await activityLog.record(actor, 'reviewed till close', 'till_close', id, `${id} reviewed by ${params.reviewedBy}`);
  return (await getTillClose(id))!;
}
