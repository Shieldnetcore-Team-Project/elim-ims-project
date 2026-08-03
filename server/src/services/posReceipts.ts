import { db } from '../db/client.js';
import * as activityLog from './activityLog.js';
import * as accessControl from './accessControl.js';
import * as sales from './sales.js';

const MANAGER_ROLE = 'Sales manager';

export interface ReceiptPayment { id: string; amount: number; method: string | null; received_at: string }
export interface PosReceipt {
  salesId: string; createdAt: string; rep: string | null; total: number;
  items: { item_id: string; quantity: number; unit_price: number; line_total: number }[];
  payments: ReceiptPayment[]; printCount: number;
}

export function printCount(salesId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM pos_receipt_prints WHERE sales_id = ?').get(salesId) as { n: number }).n;
}

/** Everything a receipt needs to render — order + items + the payment-line
 *  breakdown from receipts (one row per method for a split payment, Module
 *  13), plus how many times it's already been printed. */
export function getReceipt(salesId: string): PosReceipt {
  const order = sales.getOrder(salesId);
  if (!order) throw new Error(`Unknown sales order ${salesId}`);
  const items = sales.listItemsFor(salesId).map(it => ({ item_id: it.item_id, quantity: it.quantity, unit_price: it.unit_price, line_total: it.line_total }));
  const payments = db.prepare(
    `SELECT id, amount, method, received_at FROM receipts WHERE reference_type = 'sales' AND reference_id = ? ORDER BY id`,
  ).all(salesId) as unknown as ReceiptPayment[];
  return { salesId, createdAt: order.created_at, rep: order.rep, total: order.total_amount, items, payments, printCount: printCount(salesId) };
}

/** The first print of a sale's receipt is unrestricted — normal operation,
 *  the cashier printing the customer's own receipt. Every print after that
 *  is a reprint: requires overrideUserId to resolve (accessControl.getUser,
 *  the same real users.role check Module 5's Warehouse Manager override
 *  uses) to role === 'Sales manager', plus a non-empty reason. A blocked
 *  attempt writes nothing — only a successful print/reprint leaves a row,
 *  so pos_receipt_prints IS the complete, honest audit trail. */
export function recordPrint(params: { salesId: string; actor: string; overrideUserId?: string; reason?: string }): { isReprint: boolean } {
  const order = sales.getOrder(params.salesId);
  if (!order) throw new Error(`Unknown sales order ${params.salesId}`);

  const isReprint = printCount(params.salesId) > 0;
  let approvedBy: string | null = null;

  if (isReprint) {
    if (!params.reason || !params.reason.trim()) throw new Error('A reason is required to reprint a receipt');
    if (!params.overrideUserId) throw new Error(`Only a ${MANAGER_ROLE} can approve a receipt reprint`);
    const manager = accessControl.getUser(params.overrideUserId);
    if (!manager || manager.role !== MANAGER_ROLE) throw new Error(`Only a ${MANAGER_ROLE} can approve a receipt reprint`);
    approvedBy = manager.name;
  }

  db.prepare('INSERT INTO pos_receipt_prints (sales_id, is_reprint, printed_by, approved_by, reason) VALUES (?,?,?,?,?)')
    .run(params.salesId, isReprint ? 1 : 0, params.actor, approvedBy, isReprint ? params.reason!.trim() : null);

  if (isReprint) {
    activityLog.record(approvedBy!, 'approved receipt reprint for', 'sales', params.salesId, `Reprinted by ${params.actor} — reason: ${params.reason!.trim()}`);
  } else {
    activityLog.record(params.actor, 'printed receipt for', 'sales', params.salesId, `${params.salesId} receipt printed`);
  }

  return { isReprint };
}
