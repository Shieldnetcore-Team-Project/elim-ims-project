import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as finance from './finance.js';
import * as reversals from './reversals.js';

export type CustomerType = 'RETAIL' | 'MARKETER' | 'DISTRIBUTOR';
export type PaymentTerms = 'CASH' | 'ADVANCE' | 'CREDIT';

export interface Customer { id: string; name: string; location: string | null; customer_type: CustomerType }
export interface SalesOrder {
  id: string; customer_id: string | null; channel: 'INVOICE' | 'POS'; rep: string | null;
  status: string; payment_terms: PaymentTerms; approved_by: string | null; approved_at: string | null;
  total_amount: number; created_at: string; branch_id: string | null; manual_invoice_number: string | null;
}
export interface SalesItem { id: number; sales_id: string; item_id: string; quantity: number; unit_price: number; line_total: number }

export function listCustomers(): Customer[] {
  return db.prepare('SELECT * FROM customers ORDER BY name').all() as unknown as Customer[];
}
export function getCustomer(id: string): Customer | undefined {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
}
export function createCustomer(c: Customer): void {
  db.prepare('INSERT INTO customers (id, name, location, customer_type) VALUES (?,?,?,?)').run(c.id, c.name, c.location, c.customer_type);
}

/** Three customer categories, three different workflows:
 *  - RETAIL (no customerId, or a customer whose type is RETAIL): always cash,
 *    settles immediately — unchanged from today's POS behavior, just no
 *    longer requires a registered customer.
 *  - MARKETER: sells on credit exactly like today's INVOICE flow, no gate.
 *  - DISTRIBUTOR on CREDIT terms: requires approval before anything posts to
 *    inventory or the ledger (see approveCreditSale/rejectCreditSale below) —
 *    a Distributor paying CASH or in ADVANCE settles immediately instead,
 *    same as Retail. */
export type PosPaymentMethod = 'Cash' | 'Transfer' | 'POS Terminal';

export function createOrder(params: {
  customerId?: string; channel: 'INVOICE' | 'POS'; rep: string; paymentTerms?: PaymentTerms;
  items: { itemId: string; quantity: number; unitPrice: number }[]; actor?: string;
  branchId?: string; manualInvoiceNumber?: string; payments?: { method: PosPaymentMethod; amount: number }[];
}): SalesOrder {
  const customerType: CustomerType = params.customerId ? (getCustomer(params.customerId)?.customer_type ?? 'RETAIL') : 'RETAIL';
  // Retail POS is always cash, regardless of what's sent — the one hard rule
  // the spec states outright rather than leaving to caller discretion.
  const paymentTerms: PaymentTerms = params.channel === 'POS' ? 'CASH' : (params.paymentTerms ?? 'CREDIT');
  const requiresApproval = customerType === 'DISTRIBUTOR' && paymentTerms === 'CREDIT';
  const settledImmediately = paymentTerms === 'CASH' || paymentTerms === 'ADVANCE';

  if (params.branchId) {
    const branch = db.prepare('SELECT company_id FROM distributor_branches WHERE id = ?').get(params.branchId) as { company_id: string } | undefined;
    if (!branch) throw new Error(`Unknown branch ${params.branchId}`);
    if (branch.company_id !== params.customerId) throw new Error(`${params.branchId} does not belong to ${params.customerId}`);
  }

  const id = nextBusinessId('sales', 'SO-2026-', 5);
  const total = params.items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);
  const actor = params.actor ?? params.rep;
  const status = requiresApproval ? 'AWAITING_APPROVAL' : settledImmediately ? 'PAID' : 'PENDING';

  // Split payment (Module 13) — optional, POS-only in practice: one or more
  // named methods (no duplicates) that must sum to exactly the order total.
  // Omitted, behavior is unchanged from before this module.
  if (params.payments) {
    const validMethods: PosPaymentMethod[] = ['Cash', 'Transfer', 'POS Terminal'];
    if (params.payments.length === 0) throw new Error('payments must have at least one line if provided');
    const seen = new Set<string>();
    let sum = 0;
    for (const p of params.payments) {
      if (!validMethods.includes(p.method)) throw new Error(`Invalid payment method "${p.method}"`);
      if (seen.has(p.method)) throw new Error(`Duplicate payment method "${p.method}"`);
      seen.add(p.method);
      if (p.amount <= 0) throw new Error(`${p.method}: amount must be positive`);
      sum += p.amount;
    }
    if (Math.abs(sum - total) > 0.01) {
      throw new Error(`Payment lines total ₦${sum.toLocaleString('en-NG')} does not match the order total ₦${total.toLocaleString('en-NG')}`);
    }
  }

  db.prepare('INSERT INTO sales (id, customer_id, channel, rep, status, payment_terms, total_amount, branch_id, manual_invoice_number) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, params.customerId ?? null, params.channel, params.rep, status, paymentTerms, total, params.branchId ?? null, params.manualInvoiceNumber ?? null);

  const insertItem = db.prepare('INSERT INTO sales_items (sales_id, item_id, quantity, unit_price, line_total) VALUES (?,?,?,?,?)');
  for (const it of params.items) insertItem.run(id, it.itemId, it.quantity, it.unitPrice, it.quantity * it.unitPrice);

  if (requiresApproval) {
    // Deferred: what was ordered is recorded (sales_items above), but nothing
    // touches inventory_transactions or the ledger until approveCreditSale —
    // otherwise stock would be committed to an order that might get rejected.
    activityLog.record(actor, 'created', 'sales', id, `Sales order ${id} awaiting credit approval — ₦${total.toLocaleString('en-NG')}`);
    return getOrder(id)!;
  }

  for (const it of params.items) {
    inventory.postTransaction({
      itemId: it.itemId, direction: 'OUT', quantity: it.quantity, unitCost: it.unitPrice,
      sourceType: 'SALES', sourceId: id, actor, note: `Sold on ${id}`,
    });
  }
  finance.postLedger({ account: 'Accounts receivable', debit: total, credit: 0, referenceType: 'sales', referenceId: id, description: `Sales order ${id}`, actor, customerId: params.customerId, branchId: params.branchId });
  finance.postLedger({ account: 'Sales revenue', debit: 0, credit: total, referenceType: 'sales', referenceId: id, description: `Sales order ${id}`, actor });
  if (settledImmediately) {
    if (params.payments) {
      for (const p of params.payments) {
        finance.recordReceipt({
          receivedFrom: params.customerId ?? 'Walk-in customer', amount: p.amount, method: p.method,
          referenceType: 'sales', referenceId: id, actor,
        });
      }
    } else {
      finance.recordReceipt({
        receivedFrom: params.customerId ?? 'Walk-in customer', amount: total,
        method: params.channel === 'POS' ? 'POS card' : paymentTerms === 'ADVANCE' ? 'Advance payment' : 'Cash',
        referenceType: 'sales', referenceId: id, actor,
      });
    }
  }
  activityLog.record(actor, 'created', 'sales', id, `Sales order ${id} (${params.channel}) — ₦${total.toLocaleString('en-NG')}`);
  return getOrder(id)!;
}

/** Posts the inventory/ledger effect createOrder deferred for a Distributor
 *  credit order, then hands it back into the normal PENDING lifecycle —
 *  mirrors receiving.inspectGoodsReceived's transaction shape. */
export function approveCreditSale(salesId: string, actor = 'System Administrator'): SalesOrder {
  const order = getOrder(salesId);
  if (!order) throw new Error(`Unknown sales order ${salesId}`);
  if (order.status !== 'AWAITING_APPROVAL') throw new Error(`${salesId} is not awaiting approval (status ${order.status})`);

  db.exec('BEGIN');
  try {
    for (const it of listItemsFor(salesId)) {
      inventory.postTransaction({
        itemId: it.item_id, direction: 'OUT', quantity: it.quantity, unitCost: it.unit_price,
        sourceType: 'SALES', sourceId: salesId, actor, note: `Sold on ${salesId} (credit approved)`,
      });
    }
    finance.postLedger({ account: 'Accounts receivable', debit: order.total_amount, credit: 0, referenceType: 'sales', referenceId: salesId, description: `Sales order ${salesId}`, actor, customerId: order.customer_id ?? undefined, branchId: order.branch_id ?? undefined });
    finance.postLedger({ account: 'Sales revenue', debit: 0, credit: order.total_amount, referenceType: 'sales', referenceId: salesId, description: `Sales order ${salesId}`, actor });
    db.prepare(`UPDATE sales SET status='PENDING', approved_by=?, approved_at=datetime('now') WHERE id=?`).run(actor, salesId);
    activityLog.record(actor, 'approved credit for', 'sales', salesId, `Sales order ${salesId} credit approved — ₦${order.total_amount.toLocaleString('en-NG')}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getOrder(salesId)!;
}

/** Nothing was ever posted for an AWAITING_APPROVAL order, so rejecting it is
 *  just a status change — there's nothing to reverse. */
export function rejectCreditSale(salesId: string, actor = 'System Administrator'): SalesOrder {
  const order = getOrder(salesId);
  if (!order) throw new Error(`Unknown sales order ${salesId}`);
  if (order.status !== 'AWAITING_APPROVAL') throw new Error(`${salesId} is not awaiting approval (status ${order.status})`);
  db.prepare(`UPDATE sales SET status='CANCELLED', approved_by=?, approved_at=datetime('now') WHERE id=?`).run(actor, salesId);
  activityLog.record(actor, 'rejected credit for', 'sales', salesId, `Sales order ${salesId} credit rejected`);
  return getOrder(salesId)!;
}

/** Module 17 reversal: undoes the inventory OUT and AR/Revenue ledger lines
 *  createOrder (or approveCreditSale) posted — status is never mutated (see
 *  reversals.ts). AWAITING_APPROVAL orders never posted anything in the first
 *  place; rejectCreditSale is the correct "undo" for those, not this. */
export function reverseOrder(salesId: string, params: { reason: string; actor: string }): { reversal: reversals.Reversal; order: SalesOrder } {
  const order = getOrder(salesId);
  if (!order) throw new Error(`Unknown sales order ${salesId}`);
  if (order.status === 'AWAITING_APPROVAL') throw new Error(`${salesId} hasn't posted yet — reject it instead of reversing it`);
  reversals.assertNotReversed('sales', salesId);

  db.exec('BEGIN');
  try {
    for (const it of listItemsFor(salesId)) {
      inventory.postTransaction({
        itemId: it.item_id, direction: 'IN', quantity: it.quantity, unitCost: it.unit_price,
        sourceType: 'SALES', sourceId: salesId, actor: params.actor, note: `Reversal of ${salesId}`,
      });
    }
    finance.postLedger({ account: 'Accounts receivable', debit: 0, credit: order.total_amount, referenceType: 'sales_reversal', referenceId: salesId, description: `Reversal of sales order ${salesId}`, actor: params.actor, customerId: order.customer_id ?? undefined, branchId: order.branch_id ?? undefined });
    finance.postLedger({ account: 'Sales revenue', debit: order.total_amount, credit: 0, referenceType: 'sales_reversal', referenceId: salesId, description: `Reversal of sales order ${salesId}`, actor: params.actor });

    const reversal = reversals.create({
      entityType: 'sales', entityId: salesId, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ total_amount: order.total_amount }), newValue: JSON.stringify({ total_amount: 0 }),
    });
    activityLog.record(
      params.actor, 'reversed', 'sales', salesId,
      `Sales order ${salesId} (₦${order.total_amount.toLocaleString('en-NG')}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    db.exec('COMMIT');
    return { reversal, order: getOrder(salesId)! };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function pendingCreditApproval() {
  return db.prepare(`
    SELECT s.*, COALESCE(c.name, 'Walk-in customer') AS customer_name, c.location AS customer_location
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.status = 'AWAITING_APPROVAL'
    ORDER BY s.id DESC
  `).all();
}

/** The only writer of sales.status besides createOrder/approveCreditSale — Fleet & delivery calls this. */
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
  // LEFT JOIN: a Retail walk-in sale has no customer_id — an INNER JOIN would
  // silently drop it from every listing.
  const base = `SELECT s.*, COALESCE(c.name, 'Walk-in customer') AS customer_name, c.location AS customer_location, c.customer_type
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id`;
  if (channel) return db.prepare(`${base} WHERE s.channel = ? ORDER BY s.id DESC`).all(channel);
  return db.prepare(`${base} ORDER BY s.id DESC`).all();
}
