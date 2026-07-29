import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as finance from './finance.js';

export interface Customer { id: string; name: string; location: string | null }
export interface SalesOrder {
  id: string; customer_id: string; channel: 'INVOICE' | 'POS'; rep: string | null;
  status: string; total_amount: number; created_at: string;
}
export interface SalesItem { id: number; sales_id: string; item_id: string; quantity: number; unit_price: number; line_total: number }

export function listCustomers(): Customer[] {
  return db.prepare('SELECT * FROM customers ORDER BY name').all() as unknown as Customer[];
}
export function createCustomer(c: Customer): void {
  db.prepare('INSERT INTO customers (id, name, location) VALUES (?,?,?)').run(c.id, c.name, c.location);
}

/** Creates the order, deducts finished-goods inventory for every line, and posts the
 *  corresponding AR/revenue ledger entries — one function, one transaction's worth of effect. */
export function createOrder(params: {
  customerId: string; channel: 'INVOICE' | 'POS'; rep: string;
  items: { itemId: string; quantity: number; unitPrice: number }[]; actor?: string;
}): SalesOrder {
  const id = nextBusinessId('sales', 'SO-2026-', 5);
  const total = params.items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);
  const status = params.channel === 'POS' ? 'PAID' : 'PENDING';
  const actor = params.actor ?? params.rep;

  db.prepare('INSERT INTO sales (id, customer_id, channel, rep, status, total_amount) VALUES (?,?,?,?,?,?)')
    .run(id, params.customerId, params.channel, params.rep, status, total);

  const insertItem = db.prepare('INSERT INTO sales_items (sales_id, item_id, quantity, unit_price, line_total) VALUES (?,?,?,?,?)');
  for (const it of params.items) {
    insertItem.run(id, it.itemId, it.quantity, it.unitPrice, it.quantity * it.unitPrice);
    inventory.postTransaction({
      itemId: it.itemId, direction: 'OUT', quantity: it.quantity, unitCost: it.unitPrice,
      sourceType: 'SALES', sourceId: id, actor, note: `Sold on ${id}`,
    });
  }

  finance.postLedger({ account: 'Accounts receivable', debit: total, credit: 0, referenceType: 'sales', referenceId: id, description: `Sales order ${id}`, actor });
  finance.postLedger({ account: 'Sales revenue', debit: 0, credit: total, referenceType: 'sales', referenceId: id, description: `Sales order ${id}`, actor });
  if (params.channel === 'POS') {
    finance.recordReceipt({ receivedFrom: params.customerId, amount: total, method: 'POS card', referenceType: 'sales', referenceId: id, actor });
  }

  activityLog.record(actor, 'created', 'sales', id, `Sales order ${id} (${params.channel}) — ₦${total.toLocaleString('en-NG')}`);
  return getOrder(id)!;
}

/** The only writer of sales.status besides createOrder() — Fleet & delivery calls this. */
export function setStatus(id: string, status: string, actor = 'System Administrator'): void {
  db.prepare('UPDATE sales SET status = ? WHERE id = ?').run(status, id);
  activityLog.record(actor, 'updated status of', 'sales', id, `Sales order ${id} → ${status}`);
}

export function getOrder(id: string): SalesOrder | undefined {
  return db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as SalesOrder | undefined;
}

export function listItemsFor(salesId: string): SalesItem[] {
  return db.prepare('SELECT * FROM sales_items WHERE sales_id = ?').all(salesId) as unknown as SalesItem[];
}

export function listOrders(channel?: 'INVOICE' | 'POS') {
  const base = `SELECT s.*, c.name AS customer_name, c.location AS customer_location FROM sales s JOIN customers c ON c.id = s.customer_id`;
  if (channel) return db.prepare(`${base} WHERE s.channel = ? ORDER BY s.id DESC`).all(channel);
  return db.prepare(`${base} ORDER BY s.id DESC`).all();
}
