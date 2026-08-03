import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as finance from './finance.js';
import * as sales from './sales.js';

export interface SalesReturn {
  id: string; sales_id: string; customer_id: string | null;
  status: string; created_by: string | null; created_at: string; inspected_by: string | null; inspected_at: string | null;
}
export interface SalesReturnItem {
  id: number; return_id: string; item_id: string; quantity_returned: number;
  quantity_accepted: number | null; quantity_rejected: number | null; rejection_reason: string | null;
}
export interface ReturnInspectionLine { itemId: string; acceptedQuantity: number; rejectedQuantity: number; rejectionReason?: string }

/** The mirror image of Module 1's goods_received/inspectGoodsReceived, reversed:
 *  a customer brings stock back instead of a supplier sending it out. Gated to
 *  Marketers specifically — "carry stock to market, may return unsold goods" is
 *  a Marketer-only allowance in the spec; a Retail or Distributor sale can't be
 *  returned through this workflow. */
export function createReturn(params: {
  salesId: string; items: { itemId: string; quantityReturned: number }[]; actor: string;
}): SalesReturn {
  const order = sales.getOrder(params.salesId);
  if (!order) throw new Error(`Unknown sales order ${params.salesId}`);
  if (!order.customer_id) throw new Error(`${params.salesId} has no customer on record — Retail walk-in sales cannot be returned`);
  const customer = sales.getCustomer(order.customer_id);
  if (customer?.customer_type !== 'MARKETER') throw new Error(`Only sales to Marketer customers can be returned (${params.salesId} is ${customer?.customer_type ?? 'unknown'})`);
  if (!['DELIVERED', 'PAID'].includes(order.status)) throw new Error(`${params.salesId} hasn't been delivered yet (status ${order.status})`);

  const soldItems = new Map(sales.listItemsFor(params.salesId).map(it => [it.item_id, it]));
  for (const line of params.items) {
    const sold = soldItems.get(line.itemId);
    if (!sold) throw new Error(`${line.itemId} was not part of ${params.salesId}`);
    const alreadyReturned = (db.prepare(
      `SELECT COALESCE(SUM(sri.quantity_returned), 0) AS q FROM sales_return_items sri
       JOIN sales_returns sr ON sr.id = sri.return_id WHERE sr.sales_id = ? AND sri.item_id = ?`,
    ).get(params.salesId, line.itemId) as { q: number }).q;
    if (line.quantityReturned <= 0 || line.quantityReturned > sold.quantity - alreadyReturned) {
      throw new Error(`${line.itemId}: cannot return ${line.quantityReturned} — only ${sold.quantity - alreadyReturned} of the original ${sold.quantity} remains returnable`);
    }
  }

  const id = nextBusinessId('sales_returns', 'SRT-', 4);
  db.prepare('INSERT INTO sales_returns (id, sales_id, customer_id, created_by) VALUES (?,?,?,?)')
    .run(id, params.salesId, order.customer_id, params.actor);
  const insertItem = db.prepare('INSERT INTO sales_return_items (return_id, item_id, quantity_returned) VALUES (?,?,?)');
  for (const line of params.items) insertItem.run(id, line.itemId, line.quantityReturned);

  activityLog.record(params.actor, 'created', 'sales_return', id, `Return ${id} raised against ${params.salesId}, pending inspection`);
  return getReturn(id)!;
}

/** Only the accepted quantity re-enters inventory; the accepted value posts a
 *  credit note against the customer's receivable. Validated in full before
 *  anything is written, then applied inside one transaction — same shape as
 *  receiving.inspectGoodsReceived. */
export function inspectReturn(returnId: string, params: {
  inspectorOfficer: string; lines: ReturnInspectionLine[]; actor?: string;
}): SalesReturn {
  const ret = getReturn(returnId);
  if (!ret) throw new Error(`Unknown sales return ${returnId}`);
  if (ret.status !== 'PENDING_INSPECTION') throw new Error(`${returnId} has already been inspected (status ${ret.status})`);

  const items = listItemsFor(returnId);
  const byItem = new Map(items.map(it => [it.item_id, it]));
  for (const line of params.lines) {
    const item = byItem.get(line.itemId);
    if (!item) throw new Error(`${line.itemId} is not on return ${returnId}`);
    if (line.acceptedQuantity < 0 || line.rejectedQuantity < 0) throw new Error(`${line.itemId}: accepted/rejected quantity cannot be negative`);
    if (line.acceptedQuantity + line.rejectedQuantity !== item.quantity_returned) {
      throw new Error(`${line.itemId}: accepted (${line.acceptedQuantity}) + rejected (${line.rejectedQuantity}) must equal returned (${item.quantity_returned})`);
    }
  }

  const actor = params.actor ?? params.inspectorOfficer;
  const priceFor = new Map(sales.listItemsFor(ret.sales_id).map(it => [it.item_id, it.unit_price]));
  const totalAccepted = params.lines.reduce((s, l) => s + l.acceptedQuantity, 0);
  const totalRejected = params.lines.reduce((s, l) => s + l.rejectedQuantity, 0);
  const status = totalRejected === 0 ? 'ACCEPTED' : totalAccepted === 0 ? 'REJECTED' : 'PARTIALLY_ACCEPTED';
  const acceptedValue = params.lines.reduce((sum, l) => sum + l.acceptedQuantity * (priceFor.get(l.itemId) ?? 0), 0);

  db.exec('BEGIN');
  try {
    for (const line of params.lines) {
      const item = byItem.get(line.itemId)!;
      db.prepare('UPDATE sales_return_items SET quantity_accepted=?, quantity_rejected=?, rejection_reason=? WHERE id=?')
        .run(line.acceptedQuantity, line.rejectedQuantity, line.rejectionReason ?? null, item.id);

      if (line.acceptedQuantity > 0) {
        inventory.postTransaction({
          itemId: line.itemId, direction: 'IN', quantity: line.acceptedQuantity,
          sourceType: 'SALES', sourceId: returnId, actor,
          note: `Accepted at inspection of return ${returnId}`,
        });
      }
    }

    db.prepare(`UPDATE sales_returns SET status=?, inspected_by=?, inspected_at=datetime('now') WHERE id=?`)
      .run(status, params.inspectorOfficer, returnId);

    if (acceptedValue > 0) {
      finance.postLedger({ account: 'Sales returns', debit: acceptedValue, credit: 0, referenceType: 'sales_return', referenceId: returnId, description: `Return ${returnId} accepted`, actor, customerId: ret.customer_id ?? undefined });
      finance.postLedger({ account: 'Accounts receivable', debit: 0, credit: acceptedValue, referenceType: 'sales_return', referenceId: returnId, description: `Return ${returnId} accepted`, actor, customerId: ret.customer_id ?? undefined });
    }

    activityLog.record(actor, 'inspected', 'sales_return', returnId, `${returnId} inspected by ${params.inspectorOfficer}: ${totalAccepted} accepted, ${totalRejected} rejected`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getReturn(returnId)!;
}

export function getReturn(id: string): SalesReturn | undefined {
  return db.prepare('SELECT * FROM sales_returns WHERE id = ?').get(id) as SalesReturn | undefined;
}
export function listItemsFor(returnId: string): SalesReturnItem[] {
  return db.prepare('SELECT * FROM sales_return_items WHERE return_id = ?').all(returnId) as unknown as SalesReturnItem[];
}
export function list() {
  return db.prepare(`
    SELECT sr.*, s.channel, COALESCE(c.name, 'Walk-in customer') AS customer_name
    FROM sales_returns sr JOIN sales s ON s.id = sr.sales_id LEFT JOIN customers c ON c.id = sr.customer_id
    ORDER BY sr.id DESC
  `).all();
}
export function pendingInspection() {
  return db.prepare(`
    SELECT sr.*, s.channel, COALESCE(c.name, 'Walk-in customer') AS customer_name
    FROM sales_returns sr JOIN sales s ON s.id = sr.sales_id LEFT JOIN customers c ON c.id = sr.customer_id
    WHERE sr.status = 'PENDING_INSPECTION'
    ORDER BY sr.id DESC
  `).all();
}
