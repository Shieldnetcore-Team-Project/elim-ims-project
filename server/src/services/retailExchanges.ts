import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as finance from './finance.js';
import * as retailStock from './retailStock.js';
import * as sales from './sales.js';
import type { PosPaymentMethod } from './sales.js';

export interface RetailExchange {
  id: string; original_sales_id: string; new_sales_id: string | null; customer_id: string | null;
  reason: string; staff: string | null; actor: string | null; created_at: string;
}
export interface RetailExchangeItem { item_id: string; item_name: string; quantity_returned: number; unit_price: number }

/** Quantity of one item from one original sale already returned across every
 *  retail_exchanges event raised against it — the guard against returning
 *  more than was ever sold, whether that happens in one visit or several. */
function alreadyReturned(originalSalesId: string, itemId: string): number {
  return (db.prepare(`
    SELECT COALESCE(SUM(rei.quantity_returned), 0) AS q
    FROM retail_exchange_items rei JOIN retail_exchanges re ON re.id = rei.exchange_id
    WHERE re.original_sales_id = ? AND rei.item_id = ?
  `).get(originalSalesId, itemId) as { q: number }).q;
}

/** Section 10: a controlled correction against an already-posted retail
 *  sale — never edits or deletes the original (sales.ts's own createOrder
 *  and every other writer of `sales` stays untouched here). Records what
 *  came back (posted to Retail stock immediately, same "no inspection
 *  delay" philosophy as Section 9), refunds the returned amount, and
 *  optionally opens a brand new POS sale for whatever the customer takes
 *  instead — that new sale's own id is the "New transaction reference",
 *  its own sales_items are the "Quantity exchanged" the spec asks for, so
 *  neither is duplicated into a parallel table here. */
export function recordExchange(params: {
  originalSalesId: string;
  returns: { itemId: string; quantity: number }[];
  reason: string; staff: string; actor?: string;
  newSaleItems?: { itemId: string; quantity: number; unitPrice: number }[];
  newSalePayments?: { method: PosPaymentMethod; amount: number }[];
}): { id: string; newSalesId: string | null } {
  const actor = params.actor ?? params.staff;
  if (!params.reason || !params.reason.trim()) throw new Error('A reason is required');
  const lines = params.returns.filter(r => r.quantity > 0);
  if (lines.length === 0) throw new Error('At least one line with a positive quantity to return is required');

  const order = sales.getOrder(params.originalSalesId);
  if (!order) throw new Error(`Unknown sales order ${params.originalSalesId}`);
  if (order.channel !== 'POS') throw new Error('Retail return/exchange only applies to retail (POS) sales');
  if (order.status !== 'PAID') throw new Error(`${params.originalSalesId} is not a completed retail sale (status ${order.status})`);

  const soldItems = new Map(sales.listItemsFor(params.originalSalesId).map(it => [it.item_id, it]));
  for (const line of lines) {
    const sold = soldItems.get(line.itemId);
    if (!sold) throw new Error(`${line.itemId} was not part of ${params.originalSalesId}`);
    const already = alreadyReturned(params.originalSalesId, line.itemId);
    if (line.quantity > sold.quantity - already) {
      throw new Error(`${line.itemId}: cannot return ${line.quantity} — only ${sold.quantity - already} of the original ${sold.quantity} remains returnable`);
    }
  }

  const id = nextBusinessId('retail_exchanges', 'RXG-', 4);
  const returnedAmount = lines.reduce((sum, l) => sum + l.quantity * soldItems.get(l.itemId)!.unit_price, 0);

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO retail_exchanges (id, original_sales_id, customer_id, reason, staff, actor) VALUES (?,?,?,?,?,?)')
      .run(id, params.originalSalesId, order.customer_id, params.reason.trim(), params.staff, actor);
    const insertItem = db.prepare('INSERT INTO retail_exchange_items (exchange_id, item_id, quantity_returned, unit_price) VALUES (?,?,?,?)');
    for (const line of lines) {
      const unitPrice = soldItems.get(line.itemId)!.unit_price;
      insertItem.run(id, line.itemId, line.quantity, unitPrice);
      retailStock.reverseSale({ itemId: line.itemId, quantity: line.quantity, unitCost: unitPrice, salesId: params.originalSalesId, actor });
    }

    if (returnedAmount > 0) {
      finance.postLedger({ account: 'Sales revenue', debit: returnedAmount, credit: 0, referenceType: 'retail_exchange', referenceId: id, description: `Return against ${params.originalSalesId} (${id})`, actor, customerId: order.customer_id ?? undefined });
      finance.postLedger({ account: 'Cash/Bank', debit: 0, credit: returnedAmount, referenceType: 'retail_exchange', referenceId: id, description: `Refund for return against ${params.originalSalesId} (${id})`, actor });
    }

    let newSalesId: string | null = null;
    if (params.newSaleItems && params.newSaleItems.length > 0) {
      const newOrder = sales.createOrder({
        customerId: order.customer_id ?? undefined, channel: 'POS', rep: params.staff,
        items: params.newSaleItems, payments: params.newSalePayments, actor,
      });
      newSalesId = newOrder.id;
      db.prepare('UPDATE retail_exchanges SET new_sales_id = ? WHERE id = ?').run(newSalesId, id);
    }

    activityLog.record(
      actor, 'recorded retail return/exchange for', 'sales', params.originalSalesId,
      `${id}: ${lines.length} line(s) returned (₦${returnedAmount.toLocaleString('en-NG')} refunded)${newSalesId ? `, exchanged for new sale ${newSalesId}` : ''} — ${params.reason.trim()}`,
    );
    db.exec('COMMIT');
    return { id, newSalesId };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getExchange(id: string): RetailExchange | undefined {
  return db.prepare('SELECT * FROM retail_exchanges WHERE id = ?').get(id) as RetailExchange | undefined;
}

export function listItemsFor(exchangeId: string): RetailExchangeItem[] {
  return db.prepare(`
    SELECT rei.item_id, i.name AS item_name, rei.quantity_returned, rei.unit_price
    FROM retail_exchange_items rei JOIN items i ON i.id = rei.item_id
    WHERE rei.exchange_id = ?
  `).all(exchangeId) as unknown as RetailExchangeItem[];
}

export function listExchanges(): (RetailExchange & { customer_name: string })[] {
  return db.prepare(`
    SELECT re.*, COALESCE(c.name, 'Walk-in customer') AS customer_name
    FROM retail_exchanges re LEFT JOIN customers c ON c.id = re.customer_id
    ORDER BY re.id DESC
  `).all() as unknown as (RetailExchange & { customer_name: string })[];
}
